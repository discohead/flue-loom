// Tiny HTTP client wrapper around fetch. Handles JSON, errors, timeouts.
//
// Errors are thrown as `HttpError` so callers can branch on status and
// surface Flue-aware messages (see mapFlueError below).

export interface HttpJsonOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	body?: unknown;
	headers?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export class HttpError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly body: unknown;
	readonly url: string;

	constructor(status: number, statusText: string, body: unknown, url: string) {
		const bodyStr =
			typeof body === 'object' && body !== null
				? JSON.stringify(body)
				: typeof body === 'string'
					? body
					: String(body);
		super(`${status} ${statusText}: ${bodyStr}`);
		this.name = 'HttpError';
		this.status = status;
		this.statusText = statusText;
		this.body = body;
		this.url = url;
	}
}

export async function httpJson<T = unknown>(url: string, opts: HttpJsonOptions = {}): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

	// If caller provided a signal, abort our controller when theirs fires.
	const onCallerAbort = () => controller.abort();
	opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

	try {
		const res = await fetch(url, {
			method: opts.method ?? 'GET',
			headers: {
				'Content-Type': 'application/json',
				...opts.headers,
			},
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: controller.signal,
		});

		const text = await res.text();
		const contentType = res.headers.get('content-type') ?? '';
		const isJson = contentType.includes('application/json');
		const parsed = isJson && text ? (JSON.parse(text) as unknown) : text;

		if (!res.ok) {
			throw new HttpError(res.status, res.statusText, parsed, url);
		}

		return parsed as T;
	} finally {
		clearTimeout(timeout);
		opts.signal?.removeEventListener('abort', onCallerAbort);
	}
}

/**
 * Map a thrown error from a Flue HTTP call to an actionable message that
 * surfaces Flue-specific causes (trigger gating, structured error envelope,
 * model resolution, etc.) instead of just the raw status code.
 *
 * Pass `context` so the message can name the agent/session/endpoint.
 */
export function mapFlueError(
	error: unknown,
	context: { endpoint: string; agent?: string; sessionId?: string },
): string {
	if (error instanceof HttpError) {
		const where = context.agent
			? `agent "${context.agent}" (session "${context.sessionId ?? 'default'}") at ${context.endpoint}`
			: context.endpoint;

		// Try to unwrap the structured error envelope from @flue/sdk PR #18:
		//   { error: { code: string, message: string, ... } }
		if (
			typeof error.body === 'object' &&
			error.body !== null &&
			'error' in error.body &&
			typeof (error.body as { error: unknown }).error === 'object'
		) {
			const inner = (error.body as { error: { code?: unknown; message?: unknown } }).error;
			const code = String(inner.code ?? 'unknown');
			const message = String(inner.message ?? 'no message');
			return `Flue error [${code}]: ${message} (HTTP ${error.status} from ${where})`;
		}

		switch (error.status) {
			case 404:
				return context.agent
					? `Agent "${context.agent}" not found at ${context.endpoint}. Try flue_list_agents to see available agents.`
					: `Endpoint not found: ${context.endpoint}. Verify the URL is correct and the server is running.`;
			case 401:
			case 403:
				return `Endpoint rejected the call (HTTP ${error.status}) for ${where}. ` +
					`Common cause: trigger-less agent in production mode. The endpoint must run with FLUE_MODE=local ` +
					`(\`flue dev\` and \`flue run\` set this automatically) or the agent must export \`triggers = { webhook: true }\`.`;
			case 408:
			case 504:
				return `Timed out talking to ${where}. Consider flue_stream_agent for long-running agents.`;
			case 429:
				return `Rate limited by ${context.endpoint}. Wait and retry.`;
			case 500:
			case 502:
			case 503:
				return `Server error (HTTP ${error.status}) at ${where}: ${typeof error.body === 'string' ? error.body : JSON.stringify(error.body)}`;
			default:
				return `HTTP ${error.status} ${error.statusText} from ${where}: ${typeof error.body === 'string' ? error.body : JSON.stringify(error.body)}`;
		}
	}

	if (error instanceof Error && error.name === 'AbortError') {
		return `Request aborted (timed out or cancelled).`;
	}

	return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
