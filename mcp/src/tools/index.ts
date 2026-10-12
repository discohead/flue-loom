import type { McpServer } from '@modelcontextprotocol/server';
import type { AgentSendResult, DeliveredMessage, FlueConversationSnapshot } from '@flue/sdk';
import { FlueApiError } from '@flue/sdk';
import { z } from 'zod';

import { DEFAULT_HISTORY_MESSAGES, DEFAULT_WAIT_SECONDS, MAX_HISTORY_MESSAGES, MAX_WAIT_SECONDS } from '../constants.ts';
import { clientFor, describeError, progressReporter, waitForReply } from '../flue.ts';
import {
	type HistoryMessage,
	type ReplyOutput,
	agentsMarkdown,
	historyMarkdown,
	projectMessage,
	projectSettlement,
	replyMarkdown,
	truncate,
} from '../format.ts';
import { discoverProject } from '../project.ts';
import { listRegisteredAgents, registryPath, removeAgent, upsertAgent } from '../registry.ts';
import { CREDENTIAL_ENV_PATTERN, type ResolvedTarget, resolveTarget } from '../target.ts';

// ─── Shared schema pieces ───────────────────────────────────────────────────

const targetFields = {
	agent: z
		.string()
		.optional()
		.describe('Agent name: one registered with flue_add_agent, or a mount discovered in the local project (see flue_list_agents).'),
	url: z
		.string()
		.optional()
		.describe('Agent mount URL instead of a name, e.g. "https://api.example.com/agents/support", or "/agents/support" relative to the local dev server (FLUE_LOOM_BASE_URL, default http://localhost:5173). Do not include the conversation id.'),
	conversation_url: z
		.string()
		.optional()
		.describe('Full conversation URL (mount + id), e.g. "http://localhost:5173/agents/support/ticket-42" — an alternative to agent/url + conversation_id.'),
};

const conversationId = z
	.string()
	.min(1)
	.max(512)
	.describe('Conversation id: the durable conversation within the agent. Reuse it to continue with full context; a new id starts fresh.');

const responseFormat = z
	.enum(['markdown', 'json'])
	.optional()
	.describe('Text form of the result: "markdown" (default, readable) or "json" (the structured output). Structured output is returned either way.');

const waitSeconds = z
	.number()
	.int()
	.min(1)
	.max(MAX_WAIT_SECONDS)
	.optional()
	.describe(`How long to wait for the agent to finish before returning "pending" (default ${DEFAULT_WAIT_SECONDS}). The agent keeps working either way.`);

const activity = z.array(
	z.object({
		tool: z.string(),
		tool_call_id: z.string(),
		status: z.enum(['running', 'ok', 'error']),
		error: z.string().optional(),
		duration_ms: z.number().optional(),
	}),
);

const replyOutput = z.object({
	agent: z.string(),
	conversation_url: z.string(),
	conversation_id: z.string(),
	submission_id: z.string(),
	outcome: z.enum(['completed', 'pending']).describe('"completed": the reply is here. "pending": still running — use flue_read_reply.'),
	uid: z.string().optional(),
	deduplicated: z.boolean().optional(),
	text: z.string().optional(),
	data: z.record(z.string(), z.array(z.unknown())).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	answered_by_submission_id: z.string().optional(),
	activity,
	notes: z.array(z.string()).optional(),
	truncated: z.boolean().optional(),
});

const registeredOutput = z.object({
	name: z.string(),
	url: z.string(),
	description: z.string().optional(),
	token_env: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	header_env: z.record(z.string(), z.string()).optional(),
	credentials: z.string(),
});

// ─── Result helpers ─────────────────────────────────────────────────────────

type ToolResult = {
	content: Array<{ type: 'text'; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

function ok(structured: object, markdown: string, format: 'markdown' | 'json' = 'markdown'): ToolResult {
	const text = format === 'json' ? JSON.stringify(structured, null, 2) : markdown;
	return { content: [{ type: 'text', text: truncate(text).text }], structuredContent: structured as Record<string, unknown> };
}

// Errors carry no structuredContent: it would have to satisfy outputSchema, and
// strict clients reject a non-conforming object even on isError results.
function fail(err: unknown, target?: ResolvedTarget): ToolResult {
	const { message, details } = describeError(err, target);
	const text = Object.keys(details).length > 0 ? `${message}\n\n${JSON.stringify(details, null, 2)}` : message;
	return { content: [{ type: 'text', text }], isError: true };
}

function credentialsLabel(agent: { token_env?: string; header_env?: Record<string, string> }): string {
	const variables = [...(agent.token_env ? [agent.token_env] : []), ...Object.values(agent.header_env ?? {})];
	if (variables.length === 0) return 'none';
	return variables.map((variable) => `${variable} ${process.env[variable] ? 'set' : 'NOT SET'}`).join(', ');
}

function replyFrom(
	target: ResolvedTarget,
	admission: Pick<AgentSendResult, 'submissionId'> & Partial<AgentSendResult>,
): Omit<ReplyOutput, 'outcome' | 'activity'> {
	return {
		agent: target.label,
		conversation_url: target.conversationUrl,
		conversation_id: target.conversationId,
		submission_id: admission.submissionId,
		...(admission.uid ? { uid: admission.uid } : {}),
		...(admission.deduplicated ? { deduplicated: true } : {}),
		...(target.notes.length > 0 ? { notes: target.notes } : {}),
	};
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
	server.registerTool(
		'flue_list_agents',
		{
			title: 'List Flue agents',
			description: `List the Flue agents you can talk to: agents registered with flue_add_agent (deployed or remote mounts, with their credential variables) and the agents the local Flue project mounts in app.ts (reachable once \`vite dev\` runs, default http://localhost:5173).

Flue 2 has no server-side agent listing — an agent is reached at its app.ts mount URL, and a conversation is that URL plus an id. Use this first to find names for flue_send_message.

Args:
  - project_dir (optional): Flue project to inspect instead of the default (FLUE_LOOM_PROJECT_DIR, else the server's working directory).
  - base_url (optional): where the project is served (default FLUE_LOOM_BASE_URL or http://localhost:5173).
  - response_format (optional): "markdown" (default) or "json".`,
			inputSchema: z.object({
				project_dir: z.string().optional().describe('Path to a Flue project (or a directory inside one).'),
				base_url: z.string().optional().describe('Base URL of the running project, e.g. http://localhost:5173.'),
				response_format: responseFormat,
			}),
			outputSchema: z.object({
				registry_file: z.string(),
				registered: z.array(registeredOutput),
				project: z
					.object({
						root: z.string(),
						app: z.string().nullable(),
						base_url: z.string(),
						uses_glob: z.boolean(),
						agents: z.array(z.object({ name: z.string(), export: z.string(), path: z.string(), url: z.string().nullable() })),
					})
					.nullable(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ project_dir, base_url, response_format }) => {
			try {
				const registered = (await listRegisteredAgents()).map((agent) => ({ ...agent, credentials: credentialsLabel(agent) }));
				const project = discoverProject({ projectDir: project_dir, baseUrl: base_url });
				const structured = { registry_file: registryPath(), registered, project };
				return ok(structured, agentsMarkdown(registered, registryPath(), project), response_format);
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		'flue_add_agent',
		{
			title: 'Register a Flue agent',
			description: `Register (or replace) a named Flue agent so other tools can address it by name. Stored in ~/.config/flue-loom/agents.json (or $FLUE_LOOM_HOME), shared by every MCP host on this machine.

The URL is the agent's mount from app.ts — e.g. https://api.example.com/agents/support — without a conversation id. Credentials are never stored: name environment variables of this MCP server instead. For safety only FLUE_* variables are accepted (e.g. token_env "FLUE_PROD_TOKEN" sends "Authorization: Bearer $FLUE_PROD_TOKEN").

Args:
  - name: short handle, e.g. "prod-support".
  - url: agent mount URL (http/https).
  - description (optional): what the agent does.
  - token_env (optional): FLUE_* variable holding a bearer token.
  - headers (optional): static, non-secret headers.
  - header_env (optional): header name → FLUE_* variable holding its value (for API-key headers).`,
			inputSchema: z.object({
				name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, ".", "_", "-"; max 64').describe('Handle used as `agent` in other tools.'),
				url: z.string().describe('Agent mount URL, e.g. https://api.example.com/agents/support.'),
				description: z.string().max(500).optional(),
				token_env: z.string().regex(CREDENTIAL_ENV_PATTERN, 'must be a FLUE_* environment variable name').optional(),
				headers: z.record(z.string(), z.string()).optional(),
				header_env: z.record(z.string(), z.string().regex(CREDENTIAL_ENV_PATTERN, 'must be a FLUE_* environment variable name')).optional(),
			}),
			outputSchema: z.object({ agent: registeredOutput, replaced: z.boolean(), registry_file: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async ({ name, url, description, token_env, headers, header_env }) => {
			try {
				let parsed: URL;
				try {
					parsed = new URL(url);
				} catch {
					return fail(new Error(`Not a valid URL: ${url}`));
				}
				if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(new Error('url must be http(s).'));
				if (parsed.search || parsed.hash) return fail(new Error('url must be a plain mount URL without a query string or fragment.'));
				const entry = {
					name,
					url: parsed.href.replace(/\/+$/, ''),
					...(description ? { description } : {}),
					...(token_env ? { token_env } : {}),
					...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
					...(header_env && Object.keys(header_env).length > 0 ? { header_env } : {}),
				};
				const { replaced } = await upsertAgent(entry);
				const agent = { ...entry, credentials: credentialsLabel(entry) };
				const markdown = `${replaced ? 'Updated' : 'Registered'} **${name}** → ${entry.url}${agent.credentials !== 'none' ? ` (credentials: ${agent.credentials})` : ''}.\nTalk to it with flue_send_message { agent: "${name}", message }.`;
				return ok({ agent, replaced, registry_file: registryPath() }, markdown);
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		'flue_remove_agent',
		{
			title: 'Unregister a Flue agent',
			description: 'Remove a named agent from the flue-loom registry. Only the registry entry is removed; the agent and its conversations are untouched. No-op when the name is not registered.',
			inputSchema: z.object({ name: z.string().min(1).describe('Registered agent name.') }),
			outputSchema: z.object({ removed: z.boolean(), registry_file: z.string() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ name }) => {
			try {
				const { removed } = await removeAgent(name);
				return ok({ removed, registry_file: registryPath() }, removed ? `Removed **${name}** from the registry.` : `No registered agent named "${name}"; nothing changed.`);
			} catch (err) {
				return fail(err);
			}
		},
	);

	server.registerTool(
		'flue_send_message',
		{
			title: 'Send a message to a Flue agent',
			description: `Deliver a message into a Flue agent conversation and (by default) wait for the agent's reply, streaming progress for tool calls and reply text when the host supports progress notifications.

Conversations are durable and server-side: reuse the returned conversation_id to continue with full context; omit it to start a new conversation (an id is generated and returned). If the agent is still working when the wait ends, the result is "pending" with a submission_id for flue_read_reply — the agent keeps going.

Args:
  - agent | url | conversation_url: which agent (see flue_list_agents).
  - conversation_id (optional): conversation to create or continue.
  - message: the text to deliver.
  - signal_type (optional): deliver a structured event (kind "signal", e.g. "webhook", "schedule") instead of a user turn; attributes (optional) are string key/values the agent reads as trusted metadata.
  - initial_data (optional): creation data, validated by the agent's initialData schema; only used when this message creates the conversation.
  - create_only (optional): fail if the conversation already exists. uid (optional): continue only this conversation incarnation.
  - idempotency_key (optional, ≤256 chars): retrying with the same key never delivers twice.
  - wait (optional, default true): false returns right after the agent accepts the message.
  - timeout_seconds (optional): max wait, default ${DEFAULT_WAIT_SECONDS}.

Errors explain the fix: unreachable server (start \`vite dev\`), plain 404 (nothing mounted at that URL), 401/403 (register credentials), invalid initial_data, failed or aborted submissions (with the agent's error type).`,
			inputSchema: z.object({
				...targetFields,
				conversation_id: conversationId.optional(),
				message: z.string().min(1).describe('Message text for the agent.'),
				signal_type: z.string().min(1).optional().describe('Deliver as a signal of this type instead of a user message.'),
				attributes: z.record(z.string(), z.string()).optional().describe('Signal attributes (requires signal_type).'),
				initial_data: z.record(z.string(), z.unknown()).optional().describe('Creation data for a new conversation.'),
				create_only: z.boolean().optional().describe('Reject if the conversation already exists.'),
				uid: z.string().optional().describe('Continue only this conversation incarnation (from an earlier result).'),
				idempotency_key: z.string().min(1).max(256).optional().describe('Deduplicates retried sends.'),
				wait: z.boolean().optional().describe('Wait for the reply (default true).'),
				timeout_seconds: waitSeconds,
				response_format: responseFormat,
			}),
			outputSchema: replyOutput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args, ctx) => {
			let target: ResolvedTarget | undefined;
			try {
				if (args.attributes && !args.signal_type) return fail(new Error('`attributes` only applies to signals: also pass `signal_type`.'));
				if (args.create_only && args.uid) return fail(new Error('Pass either create_only or uid, not both.'));
				if (args.uid && args.initial_data) return fail(new Error('initial_data only applies when creating a conversation; drop uid.'));
				target = await resolveTarget(args, { requireConversation: false });
				const client = clientFor(target);
				const message: DeliveredMessage = args.signal_type
					? { kind: 'signal', type: args.signal_type, body: args.message, ...(args.attributes ? { attributes: args.attributes } : {}) }
					: { kind: 'user', body: args.message };
				const admission = await client.send({
					message,
					...(args.initial_data ? { initialData: args.initial_data } : {}),
					...(args.create_only ? { uid: null } : args.uid ? { uid: args.uid } : {}),
					...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
					signal: ctx.mcpReq.signal,
				});
				const base = replyFrom(target, admission);
				if (args.wait === false) {
					const out: ReplyOutput = { ...base, outcome: 'pending', activity: [] };
					return ok(out, replyMarkdown(out), args.response_format);
				}
				const seconds = args.timeout_seconds ?? DEFAULT_WAIT_SECONDS;
				const progress = progressReporter(ctx.mcpReq._meta?.progressToken, (notification) => ctx.mcpReq.notify(notification));
				await progress?.(`message accepted (submission ${admission.submissionId})`);
				const outcome = await waitForReply(client, admission, { timeoutMs: seconds * 1000, signal: ctx.mcpReq.signal, progress });
				if (outcome.kind === 'timeout') {
					const out: ReplyOutput = { ...base, outcome: 'pending', activity: outcome.tracker.activity() };
					return ok(out, replyMarkdown(out, seconds), args.response_format);
				}
				const text = truncate(outcome.reply.text);
				const out: ReplyOutput = {
					...base,
					outcome: 'completed',
					text: text.text,
					data: outcome.reply.data,
					...(outcome.reply.metadata ? { metadata: outcome.reply.metadata } : {}),
					...(outcome.tracker.answeredBy ? { answered_by_submission_id: outcome.tracker.answeredBy } : {}),
					activity: outcome.tracker.activity(),
					...(text.truncated ? { truncated: true } : {}),
				};
				return ok(out, replyMarkdown(out), args.response_format);
			} catch (err) {
				return fail(err, target);
			}
		},
	);

	server.registerTool(
		'flue_read_reply',
		{
			title: 'Read a Flue submission reply',
			description: `Wait for (or fetch) the reply to an earlier flue_send_message submission — typically one that came back "pending", or one sent with wait: false. Safe to call repeatedly: a settled submission returns immediately. Streams progress like flue_send_message.

Args:
  - agent | url | conversation_url, plus conversation_id: the conversation.
  - submission_id: from the earlier result.
  - timeout_seconds (optional): max wait, default ${DEFAULT_WAIT_SECONDS}.`,
			inputSchema: z.object({
				...targetFields,
				conversation_id: conversationId.optional(),
				submission_id: z.string().min(1).describe('Submission id returned by flue_send_message.'),
				timeout_seconds: waitSeconds,
				response_format: responseFormat,
			}),
			outputSchema: replyOutput,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args, ctx) => {
			let target: ResolvedTarget | undefined;
			try {
				target = await resolveTarget(args, { requireConversation: true });
				const client = clientFor(target);
				const seconds = args.timeout_seconds ?? DEFAULT_WAIT_SECONDS;
				const progress = progressReporter(ctx.mcpReq._meta?.progressToken, (notification) => ctx.mcpReq.notify(notification));
				const outcome = await waitForReply(client, args.submission_id, { timeoutMs: seconds * 1000, signal: ctx.mcpReq.signal, progress });
				const base = replyFrom(target, { submissionId: args.submission_id });
				if (outcome.kind === 'timeout') {
					const out: ReplyOutput = { ...base, outcome: 'pending', activity: outcome.tracker.activity() };
					return ok(out, replyMarkdown(out, seconds), args.response_format);
				}
				const text = truncate(outcome.reply.text);
				const out: ReplyOutput = {
					...base,
					...(outcome.reply.uid ? { uid: outcome.reply.uid } : {}),
					outcome: 'completed',
					text: text.text,
					data: outcome.reply.data,
					...(outcome.reply.metadata ? { metadata: outcome.reply.metadata } : {}),
					...(outcome.tracker.answeredBy ? { answered_by_submission_id: outcome.tracker.answeredBy } : {}),
					activity: outcome.tracker.activity(),
					...(text.truncated ? { truncated: true } : {}),
				};
				return ok(out, replyMarkdown(out), args.response_format);
			} catch (err) {
				return fail(err, target);
			}
		},
	);

	server.registerTool(
		'flue_get_conversation',
		{
			title: 'Get a Flue conversation',
			description: `Read a conversation's transcript: user and assistant messages, signals, tool calls with inputs/outputs (large values previewed), data parts, and each submission's outcome. Use it to review what an agent did, debug a failed turn, or pick up a conversation someone else started. A conversation that doesn't exist yet returns exists: false.

Args:
  - agent | url | conversation_url, plus conversation_id: the conversation.
  - last (optional): how many recent messages to return (default ${DEFAULT_HISTORY_MESSAGES}, max ${MAX_HISTORY_MESSAGES}).
  - include_hidden (optional): also return runtime plumbing and diagnostic messages (default false: visible messages only).`,
			inputSchema: z.object({
				...targetFields,
				conversation_id: conversationId.optional(),
				last: z.number().int().min(1).max(MAX_HISTORY_MESSAGES).optional().describe('Most recent messages to return.'),
				include_hidden: z.boolean().optional().describe('Include hidden and diagnostic messages.'),
				response_format: responseFormat,
			}),
			outputSchema: z.object({
				agent: z.string(),
				conversation_url: z.string(),
				conversation_id: z.string(),
				exists: z.boolean(),
				message_count: z.number(),
				messages: z.array(z.record(z.string(), z.unknown())),
				settlements: z.array(z.record(z.string(), z.unknown())),
				truncated: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args, ctx) => {
			let target: ResolvedTarget | undefined;
			try {
				target = await resolveTarget(args, { requireConversation: true });
				let snapshot: FlueConversationSnapshot | undefined;
				try {
					snapshot = await clientFor(target).history({ signal: ctx.mcpReq.signal });
				} catch (err) {
					if (!(err instanceof FlueApiError && err.status === 404 && hasEnvelopeType(err.body, 'stream_not_found'))) throw err;
				}
				const visible = (snapshot?.messages ?? []).filter((message) => args.include_hidden || message.display === 'visible');
				const limit = args.last ?? DEFAULT_HISTORY_MESSAGES;
				const messages: HistoryMessage[] = visible.slice(-limit).map(projectMessage);
				const structured = {
					agent: target.label,
					conversation_url: target.conversationUrl,
					conversation_id: target.conversationId,
					exists: snapshot !== undefined,
					message_count: visible.length,
					messages,
					settlements: (snapshot?.settlements ?? []).map(projectSettlement),
					...(messages.length < visible.length ? { truncated: true } : {}),
				};
				return ok(structured, historyMarkdown(target.label, target.conversationUrl, snapshot, messages, visible.length), args.response_format);
			} catch (err) {
				return fail(err, target);
			}
		},
	);

	server.registerTool(
		'flue_abort',
		{
			title: 'Abort a Flue conversation',
			description: `Abort all in-flight and queued work in a Flue conversation (the running submission and anything queued behind it). The conversation and its history remain; new messages can be sent afterwards. Returns aborted: false when the conversation was idle.

Args:
  - agent | url | conversation_url, plus conversation_id: the conversation.`,
			inputSchema: z.object({
				...targetFields,
				conversation_id: conversationId.optional(),
			}),
			outputSchema: z.object({ agent: z.string(), conversation_url: z.string(), conversation_id: z.string(), aborted: z.boolean() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		async (args, ctx) => {
			let target: ResolvedTarget | undefined;
			try {
				target = await resolveTarget(args, { requireConversation: true });
				const { aborted } = await clientFor(target).abort({ signal: ctx.mcpReq.signal });
				const structured = { agent: target.label, conversation_url: target.conversationUrl, conversation_id: target.conversationId, aborted };
				return ok(structured, aborted ? `Aborting the running and queued work in \`${target.conversationId}\`; those submissions settle as aborted.` : `\`${target.conversationId}\` was idle; nothing to abort.`);
			} catch (err) {
				return fail(err, target);
			}
		},
	);
}

function hasEnvelopeType(body: unknown, type: string): boolean {
	const error = (body as { error?: { type?: unknown } } | null)?.error;
	return error?.type === type;
}
