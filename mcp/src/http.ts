// Tiny HTTP client wrapper around fetch. Handles JSON, errors, timeouts.

export interface HttpJsonOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	body?: unknown;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

export async function httpJson<T = unknown>(url: string, opts: HttpJsonOptions = {}): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

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
			const message =
				typeof parsed === 'object' && parsed !== null && 'error' in parsed
					? JSON.stringify((parsed as { error: unknown }).error)
					: typeof parsed === 'string'
						? parsed
						: res.statusText;
			throw new Error(`${res.status} ${res.statusText}: ${message}`);
		}

		return parsed as T;
	} finally {
		clearTimeout(timeout);
	}
}
