// Thin layer over @flue/sdk: one client per conversation URL, waiting with
// progress and timeouts, activity tracking, and caller-facing error text.

import {
	type AgentReadResult,
	type AgentSendResult,
	type AgentSubmissionReply,
	type ConversationStreamChunk,
	type FlueClient,
	type FlueConversationMessage,
	type FlueConversationSnapshot,
	FlueApiError,
	FlueExecutionError,
	createFlueClient,
	readSubmissionReply,
} from '@flue/sdk';

import { HISTORY_PAGE_MESSAGES, PROGRESS_INTERVAL_MS, REPLY_WINDOW_MESSAGES } from './constants.ts';
import { type ResolvedTarget, TargetError } from './target.ts';

export function clientFor(target: ResolvedTarget): FlueClient {
	return createFlueClient({ url: target.conversationUrl, headers: target.headers, token: target.token });
}

export interface ToolActivity {
	tool: string;
	tool_call_id: string;
	status: 'running' | 'ok' | 'error';
	error?: string;
	duration_ms?: number;
}

/** Folds stream chunks seen while waiting into a compact activity summary. */
export class ActivityTracker {
	readonly tools = new Map<string, ToolActivity>();
	readonly dataParts = new Map<string, number>();
	textChars = 0;
	answeredBy?: string;

	constructor(private readonly submissionId?: string) {}

	/** Record a chunk; returns a progress line for notable events. */
	observe(chunk: ConversationStreamChunk): string | undefined {
		switch (chunk.type) {
			case 'tool-input':
				this.tools.set(chunk.toolCallId, { tool: chunk.toolName, tool_call_id: chunk.toolCallId, status: 'running' });
				return `tool ${chunk.toolName} started`;
			case 'tool-output':
			case 'tool-output-error': {
				const entry = this.tools.get(chunk.toolCallId);
				if (!entry) return undefined;
				entry.status = chunk.type === 'tool-output' ? 'ok' : 'error';
				if (chunk.type === 'tool-output-error') entry.error = chunk.errorText;
				if (chunk.durationMs !== undefined) entry.duration_ms = chunk.durationMs;
				return `tool ${entry.tool} ${entry.status === 'ok' ? 'finished' : 'failed'}`;
			}
			case 'data-part':
				this.dataParts.set(chunk.name, (this.dataParts.get(chunk.name) ?? 0) + 1);
				return `data part ${chunk.name} updated`;
			case 'message-delta':
				if (chunk.kind === 'text') this.textChars += chunk.delta.length;
				return undefined;
			case 'submission-settled':
				if (chunk.submissionId === this.submissionId && chunk.answeredBySubmissionId && chunk.answeredBySubmissionId !== this.submissionId) {
					this.answeredBy = chunk.answeredBySubmissionId;
				}
				return undefined;
			default:
				return undefined;
		}
	}

	activity(): ToolActivity[] {
		return [...this.tools.values()];
	}
}

export type WaitOutcome =
	| { kind: 'settled'; reply: AgentReadResult; tracker: ActivityTracker }
	| { kind: 'timeout'; tracker: ActivityTracker };

/**
 * Wait for a submission to settle and read its reply. Resolves `timeout`
 * (not an error: the agent keeps working) when `timeoutMs` elapses; rethrows
 * caller cancellation, execution failures, and HTTP errors.
 */
export async function waitForReply(
	client: FlueClient,
	target: AgentSendResult | string,
	options: {
		timeoutMs: number;
		signal: AbortSignal;
		progress?: (message: string) => Promise<void>;
	},
): Promise<WaitOutcome> {
	const submissionId = typeof target === 'string' ? target : target.submissionId;
	const tracker = new ActivityTracker(submissionId);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new Error('wait timed out')), options.timeoutMs);
	const signal = AbortSignal.any([options.signal, timeout.signal]);
	let lastTextProgress = 0;
	const onEvent = async (chunk: ConversationStreamChunk) => {
		const line = tracker.observe(chunk);
		if (!options.progress) return;
		if (line) {
			await options.progress(line);
		} else if (chunk.type === 'message-delta' && chunk.kind === 'text' && Date.now() - lastTextProgress >= PROGRESS_INTERVAL_MS) {
			lastTextProgress = Date.now();
			await options.progress(`writing reply (${tracker.textChars} chars)`);
		}
	};
	try {
		if (typeof target === 'string') {
			// Re-attach by id: read() follows the stream from its origin.
			return { kind: 'settled', reply: await client.read(target, { signal, onEvent }), tracker };
		}
		// read() would fetch the whole transcript for a reply that sits at its head.
		await client.wait(target, { signal, onEvent });
		const reply = await readReply(client, submissionId, signal);
		return { kind: 'settled', reply: { ...reply, submissionId, ...(target.uid !== undefined ? { uid: target.uid } : {}) }, tracker };
	} catch (err) {
		if (timeout.signal.aborted && !options.signal.aborted) return { kind: 'timeout', tracker };
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A settled submission's reply, read from the newest messages. Falls back to
 * the whole conversation when the reply isn't in that window — or for a
 * legacy settlement, whose reply readSubmissionReply() only guesses from a
 * complete transcript.
 */
async function readReply(client: FlueClient, submissionId: string, signal: AbortSignal): Promise<AgentSubmissionReply> {
	const window = await client.history({ limit: REPLY_WINDOW_MESSAGES, signal });
	if (typeof window.before !== 'string' || holdsReply(window, submissionId)) return readSubmissionReply(window, submissionId);
	return readSubmissionReply(await client.history({ signal }), submissionId);
}

function holdsReply(snapshot: FlueConversationSnapshot, submissionId: string): boolean {
	const answeredBy = snapshot.settlements.find((settlement) => settlement.submissionId === submissionId)?.answeredBySubmissionId;
	return snapshot.messages.some((message) => message.role === 'assistant' && (message.submissionId === submissionId || (answeredBy !== undefined && message.submissionId === answeredBy)));
}

export interface RecentMessages {
	/** The newest read; its settlements cover the whole conversation. */
	snapshot: FlueConversationSnapshot;
	/** Up to `count` of the newest messages that pass `keep`, oldest first. */
	messages: FlueConversationMessage[];
	/** Every message from the oldest returned one through the head, kept or not. */
	window: FlueConversationMessage[];
	/** How many messages in the whole conversation pass `keep` — known only when all of it was read. */
	total?: number;
}

/**
 * The newest `count` messages passing `keep`, paging back through bounded
 * history reads only as far as needed. A runtime that predates bounded reads
 * returns the whole conversation at once. A cursor invalidated by a stream
 * reset (410 history_cursor_not_found) restarts the read once.
 */
export async function readRecentMessages(
	client: FlueClient,
	count: number,
	keep: (message: FlueConversationMessage) => boolean,
	signal: AbortSignal,
): Promise<RecentMessages> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			const snapshot = await client.history({ limit: count, signal });
			let read = snapshot.messages;
			let cursor = snapshot.before;
			while (typeof cursor === 'string' && read.filter(keep).length < count) {
				const page = await client.historyBefore(cursor, { limit: Math.max(count, HISTORY_PAGE_MESSAGES), signal });
				read = [...page.messages, ...read];
				cursor = page.before;
			}
			const kept = read.filter(keep);
			const messages = kept.slice(-count);
			const [oldest] = messages;
			const window = oldest ? read.slice(read.indexOf(oldest)) : [];
			return { snapshot, messages, window, ...(typeof cursor !== 'string' ? { total: kept.length } : {}) };
		} catch (err) {
			if (attempt > 0 || !(err instanceof FlueApiError && err.status === 410)) throw err;
		}
	}
}

/** Sends an MCP progress notification when the caller asked for them. */
export function progressReporter(
	token: string | number | undefined,
	notify: (notification: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>,
): ((message: string) => Promise<void>) | undefined {
	if (token === undefined) return undefined;
	let progress = 0;
	return async (message) => {
		progress += 1;
		try {
			await notify({ method: 'notifications/progress', params: { progressToken: token, progress, message } });
		} catch {
			// Progress is best-effort; a closed transport must not fail the call.
		}
	};
}

export interface DescribedError {
	message: string;
	details: Record<string, unknown>;
}

/** Turn anything thrown while talking to Flue into actionable text. */
export function describeError(err: unknown, target?: ResolvedTarget): DescribedError {
	const where = target ? { conversation_url: target.conversationUrl } : {};
	if (err instanceof TargetError) return { message: err.message, details: where };

	if (err instanceof FlueExecutionError) {
		const cause = asRecord(err.error);
		const type = typeof cause?.type === 'string' ? cause.type : undefined;
		const detail = typeof cause?.message === 'string' ? cause.message : err.message;
		const verb = err.failure === 'aborted' ? 'was aborted' : err.failure === 'failed' ? 'failed' : 'ended without a terminal event';
		return {
			message: `The agent's submission ${err.targetId} ${verb}${type ? ` (${type})` : ''}: ${detail}`,
			details: { ...where, submission_id: err.targetId, failure: err.failure, error: err.error ?? null },
		};
	}

	if (err instanceof FlueApiError) {
		const envelope = asRecord(asRecord(err.body)?.error);
		const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
		const serverMessage = typeof envelope?.message === 'string' ? envelope.message : undefined;
		const meta = asRecord(envelope?.meta);
		const details = { ...where, status: err.status, type: type ?? null, error: envelope ?? err.body ?? null, ref: err.ref ?? null };
		const mount = target?.mountUrl ?? 'that URL';
		if (!envelope && err.status === 404) {
			return { message: `Nothing is mounted at ${mount} (plain 404, no Flue error envelope). Check the app.ts mounts (flue_list_agents), the base URL, and the port.`, details };
		}
		if (err.status === 401 || err.status === 403) {
			return { message: `The server refused the request (${err.status}${serverMessage ? `: ${serverMessage}` : ''}). Protected routes need credentials: register the agent with flue_add_agent and a token_env naming a FLUE_* variable set in this MCP server's environment.`, details };
		}
		const hints: Record<string, string> = {
			invalid_request: 'The request was rejected. If you passed initial_data, check it against the agent\'s initialData schema.',
			invalid_json: 'The request body was not valid JSON.',
			stream_not_found: `Conversation "${target?.conversationId ?? ''}" doesn't exist yet — send a message to create it.`,
			agent_instance_not_found: 'No conversation incarnation matches that uid. Drop `uid`, or use a new conversation_id.',
			agent_instance_exists: `The conversation already exists${typeof meta?.uid === 'string' ? ` (uid ${meta.uid})` : ''}. Drop create_only to continue it, or pick another conversation_id.`,
			submission_conflict: `That idempotency_key was already used for a different message${typeof meta?.submissionId === 'string' ? ` (submission ${meta.submissionId})` : ''}. Use a fresh key to send again.`,
			method_not_allowed: 'The route exists but does not accept this method.',
			runtime_unavailable: 'The runtime is temporarily unavailable (a dev server reload?). Retry in a moment.',
			history_cursor_not_found: 'The conversation\'s stream was reset while its history was being read. Retry.',
			internal_error: `The server hit an internal error${err.ref ? ` — quote ref ${err.ref} when reporting it` : ''}.`,
		};
		const hint = type ? hints[type] : undefined;
		return {
			message: `HTTP ${err.status}${type ? ` ${type}` : ''}${serverMessage ? `: ${serverMessage}` : ''}${hint ? `\n${hint}` : ''}`,
			details,
		};
	}

	const code = networkErrorCode(err);
	if (code) {
		const origin = target ? new URL(target.mountUrl).origin : 'the server';
		return {
			message: `Could not reach ${origin} (${code}). Start the server — \`vite dev\` serves http://localhost:5173 by default — or fix the URL.`,
			details: { ...where, code },
		};
	}
	return { message: err instanceof Error ? err.message : String(err), details: where };
}

function networkErrorCode(err: unknown): string | undefined {
	let current: unknown = err;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && /^(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|UND_ERR_\w+)$/.test(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
		const cause = (err as { cause?: unknown }).cause;
		return cause instanceof Error ? `fetch failed: ${cause.message}` : 'fetch failed';
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
