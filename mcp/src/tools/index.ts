import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { HttpError, httpJson, mapFlueError } from '../http.ts';
import { postSse, parseSse } from '../sse.ts';
import {
	addEndpoint,
	listEndpoints,
	removeEndpoint,
	resolveEndpoint,
} from '../registry.ts';
import {
	formatAgentsMarkdown,
	formatEndpointsMarkdown,
	formatInvokeMarkdown,
	formatStreamMarkdown,
} from '../format.ts';
import {
	CHARACTER_LIMIT,
	DEFAULT_STREAM_TIMEOUT_MS,
	MAX_EVENTS,
} from '../constants.ts';

// ─── Shared output sub-schemas ───────────────────────────────────────────────

const AgentSummary = z
	.object({
		name: z.string(),
		triggers: z.unknown().optional(),
	})
	.passthrough();

const EndpointEntry = z.object({
	name: z.string(),
	url: z.string(),
});

const RegistryShape = z.object({
	endpoints: z.array(EndpointEntry),
	defaultName: z.string().optional(),
});

const ResponseFormat = z
	.enum(['json', 'markdown'])
	.optional()
	.describe(
		'Format of the text content. "json" (default) returns a stringified JSON envelope; "markdown" returns a human-readable formatted block. structuredContent is identical regardless.',
	);

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ToolReturn = {
	content: Array<{ type: 'text'; text: string }>;
	structuredContent: Record<string, unknown>;
	isError?: boolean;
};

function jsonText(output: Record<string, unknown>): ToolReturn {
	return {
		content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
		structuredContent: output,
	};
}

function errorText(message: string, structured: Record<string, unknown>): ToolReturn {
	return {
		content: [{ type: 'text', text: message }],
		structuredContent: structured,
		isError: true,
	};
}

// ─── Tool registration ───────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
	server.registerTool(
		'flue_list_agents',
		{
			title: 'List Flue Agents',
			description: `List all Flue agents registered at a Flue HTTP endpoint.

Calls GET /agents on the endpoint (local \`flue dev\` or a deployed Cloudflare Worker URL) and returns the manifest — every agent discovered, with its parsed triggers. Use before flue_invoke_agent or flue_stream_agent to discover what's invokable.

Args:
  - endpoint (string, optional): Endpoint URL or registered endpoint name. Resolution order: explicit URL → name in registry → registry default → http://localhost:3583. Use flue_list_endpoints to see registered names.
  - response_format ('json' | 'markdown', optional): Default 'json'.

Returns:
  {
    "endpoint": string,         // The resolved URL
    "agents": [
      {
        "name": string,         // Agent name (filename minus extension)
        "triggers": {           // Parsed at build time from agent source
          "webhook"?: true,
          "cron"?: string
        }
      }
    ]
  }

Examples:
  - "What agents are running?" → flue_list_agents (no args)
  - "List agents on prod" → flue_list_agents endpoint="prod-cf"
  - "What's at https://example.workers.dev?" → flue_list_agents endpoint="https://example.workers.dev"

Errors:
  - "Endpoint '<name>' not found in registry" → register it first with flue_add_endpoint
  - HTTP 404 / connection refused → endpoint is down or URL is wrong; verify with curl`,
			inputSchema: {
				endpoint: z
					.string()
					.optional()
					.describe(
						'Endpoint URL (http://… or https://…) or registered endpoint name. Falls back to registry default, then http://localhost:3583.',
					),
				response_format: ResponseFormat,
			},
			outputSchema: {
				endpoint: z.string(),
				agents: z.array(AgentSummary),
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async ({ endpoint, response_format }) => {
			let url: string;
			try {
				url = await resolveEndpoint(endpoint);
			} catch (err) {
				return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? "" });
			}
			try {
				const data = await httpJson<{ agents?: unknown }>(`${url}/agents`);
				const agents = Array.isArray(data?.agents) ? data.agents : [];
				const output: Record<string, unknown> = { endpoint: url, agents };
				if (response_format === 'markdown') {
					return {
						content: [{ type: 'text', text: formatAgentsMarkdown(url, agents) }],
						structuredContent: output,
					};
				}
				return jsonText(output);
			} catch (err) {
				return errorText(mapFlueError(err, { endpoint: url }), { endpoint: url });
			}
		},
	);

	server.registerTool(
		'flue_invoke_agent',
		{
			title: 'Invoke Flue Agent',
			description: `Invoke a Flue agent and return its result.

POSTs to /agents/:name/:id on the Flue HTTP endpoint. Two modes:
  - sync (default): waits for the agent to finish, returns the result body
  - webhook: fire-and-forget, returns HTTP 202 immediately

The session id is the conversation thread — the same id reuses message history; a new id starts fresh. Defaults to "default".

Args:
  - endpoint (string, optional): Endpoint URL or registered name.
  - agent (string, required): Agent name (matches .flue/agents/<name>.{ts,js,mts,mjs}).
  - sessionId (string, optional): Session id. Default: "default".
  - payload (any, optional): JSON-serializable value passed to the agent handler as ctx.payload.
  - mode ('sync' | 'webhook', optional): Default: 'sync'.
  - response_format ('json' | 'markdown', optional): Default 'json'.

Returns (sync):
  { "endpoint": string, "agent": string, "sessionId": string, "mode": "sync", "result": <agent return value> }

Returns (webhook):
  { "endpoint": string, "agent": string, "sessionId": string, "mode": "webhook", "status": 202 }

Examples:
  - "Run the hello agent" → agent="hello"
  - "Invoke greeter with payload" → agent="greeter", payload={"name":"Ada"}
  - "Fire off scheduler async" → agent="scheduler", mode="webhook"
  - "Continue thread-1's conversation with hello" → agent="hello", sessionId="thread-1"

Errors:
  - 404 with envelope type \`agent_not_webhook\` → trigger-less agent in production mode; the endpoint must run with FLUE_MODE=local (\`flue dev\` / \`flue run\` set this automatically) or the agent must export \`triggers = { webhook: true }\`. flue_invoke_agent surfaces this hint automatically via mapFlueError.
  - 404 with envelope type \`agent_not_found\` → agent name is wrong; try flue_list_agents.
  - Network timeout (default 60s, currently not user-configurable) → consider flue_stream_agent for long-running agents.`,
			inputSchema: {
				endpoint: z
					.string()
					.optional()
					.describe('Endpoint URL or registered endpoint name. Falls back to default.'),
				agent: z
					.string()
					.describe('Agent name (matches the file at .flue/agents/<name>.{ts,js,mts,mjs}).'),
				sessionId: z
					.string()
					.optional()
					.describe('Session id; defaults to "default". Reuse to continue a conversation thread.'),
				payload: z
					.unknown()
					.optional()
					.describe('JSON-serializable payload passed to the agent handler as ctx.payload.'),
				mode: z
					.enum(['sync', 'webhook'])
					.optional()
					.describe(
						'Invocation mode. "sync" returns the result body; "webhook" is fire-and-forget (HTTP 202). Default: sync.',
					),
				response_format: ResponseFormat,
			},
			outputSchema: {
				endpoint: z.string(),
				agent: z.string(),
				sessionId: z.string(),
				mode: z.enum(['sync', 'webhook']),
				result: z.unknown().optional(),
				status: z.number().optional(),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ endpoint, agent, sessionId, payload, mode, response_format }) => {
			let url: string;
			try {
				url = await resolveEndpoint(endpoint);
			} catch (err) {
				return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? "" });
			}
			const sid = sessionId ?? 'default';
			const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
			const m = mode ?? 'sync';

			try {
				if (m === 'webhook') {
					// 60s bound on the dispatch; reject non-2xx so the LLM doesn't see
					// a failed dispatch as a successful fire-and-forget.
					const ctl = new AbortController();
					const timer = setTimeout(() => ctl.abort(), 60_000);
					let res: Response;
					try {
						res = await fetch(path, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json', 'x-webhook': 'true' },
							body: JSON.stringify(payload ?? {}),
							signal: ctl.signal,
						});
					} finally {
						clearTimeout(timer);
					}
					if (!res.ok) {
						const text = await res.text().catch(
							(readErr: unknown) =>
								`${res.statusText} (response body unreadable: ${readErr instanceof Error ? readErr.message : String(readErr)})`,
						);
						let body: unknown = text;
						try {
							body = JSON.parse(text);
						} catch {
							/* keep as text */
						}
						throw new HttpError(res.status, res.statusText, body, path);
					}
					const output: Record<string, unknown> = {
						endpoint: url,
						agent,
						sessionId: sid,
						mode: 'webhook' as const,
						status: res.status,
					};
					if (response_format === 'markdown') {
						return {
							content: [{ type: 'text', text: formatInvokeMarkdown(url, agent, sid, 'webhook', output) }],
							structuredContent: output,
						};
					}
					return jsonText(output);
				}

				const data = await httpJson(path, { method: 'POST', body: payload ?? {} });
				// Unwrap Flue's `{ result }` envelope so callers see agent fields
				// directly. Convention: any object body with a `result` key is the
				// envelope; an agent that legitimately returns `{ result, other }`
				// will lose `other` here. Document loudly if that ever surfaces.
				const unwrapped =
					data && typeof data === 'object' && data !== null && 'result' in data
						? (data as { result: unknown }).result
						: data;
				const output: Record<string, unknown> = {
					endpoint: url,
					agent,
					sessionId: sid,
					mode: 'sync' as const,
					result: unwrapped,
				};
				if (response_format === 'markdown') {
					return {
						content: [{ type: 'text', text: formatInvokeMarkdown(url, agent, sid, 'sync', unwrapped) }],
						structuredContent: output,
					};
				}
				return jsonText(output);
			} catch (err) {
				return errorText(
					mapFlueError(err, { endpoint: url, agent, sessionId: sid }),
					{ endpoint: url, agent, sessionId: sid },
				);
			}
		},
	);

	server.registerTool(
		'flue_stream_agent',
		{
			title: 'Stream Flue Agent',
			description: `Invoke a Flue agent with SSE streaming and return the accumulated output.

Like flue_invoke_agent in sync mode, but uses Server-Sent Events to stream the agent's progress. Useful for long-running agents (multi-turn LLM work) where you want to see text incrementally and inspect tool calls. Returns the final assembled state once the stream completes (or the timeout triggers).

The events log can grow large for long agents; if the JSON-stringified response exceeds the character limit (~25 KB), the events array is halved and a truncation note is added. The 'text' field and 'result' are kept in full.

Args:
  - endpoint (string, optional): Same as flue_invoke_agent.
  - agent (string, required): Agent name.
  - sessionId (string, optional): Session id. Default: "default".
  - payload (any, optional): Agent payload.
  - timeoutMs (number, optional): Max wall-clock time for the stream. Default: 300000 (5 min).
  - response_format ('json' | 'markdown', optional): Default 'json'.

Returns:
  {
    "endpoint": string,
    "agent": string,
    "sessionId": string,
    "text": string,                  // Concatenated 'text_delta' event payloads (the LLM's streaming text)
    "result": <unknown>,              // Unwrapped 'result' event payload (the agent's return value)
    "events": [                       // Full event log for replay/inspection
      { "event": string, "data": <unknown> }
    ],
    "truncated"?: boolean            // True if MAX_EVENTS cap or CHARACTER_LIMIT halving fired
  }

Event types in 'events' (Flue SDK FlueEvent + HTTP-layer synthesized events):
  - 'agent_start': agent handler entered
  - 'text_delta': streaming LLM text chunk (data.text accumulates into the 'text' field above)
  - 'tool_start' / 'tool_end': agent called a tool (with toolName, args, isError, result)
  - 'turn_end': a single LLM turn finished
  - 'command_start' / 'command_end': session.shell() or scoped command ran
  - 'task_start' / 'task_end': session.task() spawned a child session
  - 'compaction_start' / 'compaction_end': message-history compaction fired
  - 'idle': agent paused (HTTP layer synthesizes one if the handler returns without idling)
  - 'result': handler's return value (HTTP-layer synthesized; the agent's return is unwrapped from data.data into the 'result' field above)
  - 'error': agent threw — surfaced as isError with the Flue envelope (HTTP-layer synthesized)

Examples:
  - "Run hello with streaming" → agent="hello"
  - "Watch tool calls during a turn" → look at events[] for event === 'tool_start' / 'tool_end'

Errors:
  - HTTP non-2xx maps to actionable Flue messages via mapFlueError (404 + envelope type 'agent_not_webhook' → trigger-less hint, 'agent_not_found' → name hint).
  - Mid-stream 'error' events (agent threw during execution) surface as isError with the Flue envelope details and any partial text/result captured so far.
  - Stalled stream → aborted at timeoutMs with a clear message.`,
			inputSchema: {
				endpoint: z
					.string()
					.optional()
					.describe('Endpoint URL or registered endpoint name. Falls back to default.'),
				agent: z.string().describe('Agent name.'),
				sessionId: z
					.string()
					.optional()
					.describe('Session id; defaults to "default".'),
				payload: z
					.unknown()
					.optional()
					.describe('JSON-serializable payload passed to the agent handler.'),
				timeoutMs: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Wall-clock timeout in milliseconds. Default: 300000 (5 minutes).'),
				response_format: ResponseFormat,
			},
			outputSchema: {
				endpoint: z.string(),
				agent: z.string(),
				sessionId: z.string(),
				text: z.string(),
				result: z.unknown().optional(),
				events: z.array(
					z.object({
						event: z.string(),
						data: z.unknown(),
					}),
				),
				truncated: z.boolean().optional(),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ endpoint, agent, sessionId, payload, timeoutMs, response_format }) => {
			let url: string;
			try {
				url = await resolveEndpoint(endpoint);
			} catch (err) {
				return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? "" });
			}
			const sid = sessionId ?? 'default';
			const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
			const ms = timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ms);

			const events: Array<{ event: string; data: unknown }> = [];
			let textBuffer = '';
			let resultPayload: unknown = undefined;
			let streamErrorEnvelope:
				| { type?: unknown; message?: unknown; details?: unknown }
				| null = null;
			let totalEventsSeen = 0;
			let cappedEarly = false;

			try {
				const stream = await postSse(path, payload ?? {}, { signal: controller.signal });

				for await (const ev of parseSse(stream)) {
					totalEventsSeen++;
					let parsed: unknown = ev.data;
					try {
						parsed = JSON.parse(ev.data);
					} catch {
						/* keep as raw string */
					}
					// Cap the events log; text and result still accumulate past it.
					if (events.length < MAX_EVENTS) {
						events.push({ event: ev.event, data: parsed });
					} else if (!cappedEarly) {
						events.push({
							event: '__truncated__',
							data: { reason: `event log capped at ${MAX_EVENTS} entries`, droppedFromHere: true },
						});
						cappedEarly = true;
					}

					// Flue emits FlueEvent.type as the SSE event name. Streaming
					// LLM text comes through as 'text_delta' with a `text` payload
					// (see packages/sdk/src/types.ts:397).
					if (ev.event === 'text_delta') {
						if (parsed && typeof parsed === 'object' && 'text' in parsed) {
							textBuffer += String((parsed as { text: unknown }).text ?? '');
						} else if (typeof ev.data === 'string') {
							// Some servers may send raw text without the JSON wrapper.
							textBuffer += ev.data;
						}
					}
					if (ev.event === 'result') {
						// Flue wraps as { type: 'result', data: <agent return> }; unwrap
						// to match sync semantics (see build-plugin-node.ts:222-226).
						resultPayload =
							parsed && typeof parsed === 'object' && parsed !== null && 'data' in parsed
								? (parsed as { data: unknown }).data
								: parsed;
					}
					if (ev.event === 'error') {
						// HTTP layer emits 'error' when the agent throws mid-stream
						// (build-plugin-node.ts:227-232). Payload is the Flue error
						// envelope. Capture and surface as isError after the loop —
						// preserve any partial text/result the LLM already produced.
						if (parsed && typeof parsed === 'object') {
							streamErrorEnvelope = parsed as {
								type?: unknown;
								message?: unknown;
								details?: unknown;
							};
						}
					}
				}
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') {
					return errorText(
						`Stream timed out after ${ms}ms talking to agent "${agent}" (session "${sid}") at ${url}. ` +
							`Increase timeoutMs or check why the agent stalled (try flue_invoke_agent in sync mode for a fresh attempt).`,
						{ endpoint: url, agent, sessionId: sid, timedOutAt: ms, partialEvents: events.length },
					);
				}
				return errorText(
					mapFlueError(err, { endpoint: url, agent, sessionId: sid }),
					{ endpoint: url, agent, sessionId: sid, partialEvents: events.length },
				);
			} finally {
				clearTimeout(timer);
			}

			// Mid-stream agent failure: surface as isError with whatever partial
			// text/result we captured before the error event.
			if (streamErrorEnvelope) {
				const type = String(streamErrorEnvelope.type ?? 'unknown');
				const message = String(streamErrorEnvelope.message ?? 'Agent error during stream');
				return errorText(
					`Flue stream error [${type}]: ${message} (agent "${agent}", session "${sid}", endpoint ${url})`,
					{
						endpoint: url,
						agent,
						sessionId: sid,
						errorType: type,
						errorMessage: message,
						partialText: textBuffer,
						partialResult: resultPayload,
						eventsSeen: totalEventsSeen,
					},
				);
			}

			// Truncate the events log if the JSON envelope would blow the character limit.
			let finalEvents = events;
			let truncated = false;
			let truncationNote: string | undefined;
			let envelope = JSON.stringify(
				{ endpoint: url, agent, sessionId: sid, text: textBuffer, result: resultPayload, events },
				null,
				2,
			);
			while (envelope.length > CHARACTER_LIMIT && finalEvents.length > 1) {
				finalEvents = finalEvents.slice(0, Math.max(1, Math.floor(finalEvents.length / 2)));
				truncated = true;
				envelope = JSON.stringify(
					{ endpoint: url, agent, sessionId: sid, text: textBuffer, result: resultPayload, events: finalEvents },
					null,
					2,
				);
			}
			if (truncated) {
				truncationNote = `Event log truncated from ${events.length} to ${finalEvents.length} events to fit ${CHARACTER_LIMIT} char limit. Text and result are complete; use sync mode for less verbose responses.`;
			} else if (cappedEarly) {
				truncationNote = `Event log capped at MAX_EVENTS=${MAX_EVENTS} during streaming (saw ${totalEventsSeen} events total). Text and result are complete.`;
			}

			const output: Record<string, unknown> = {
				endpoint: url,
				agent,
				sessionId: sid,
				text: textBuffer,
				result: resultPayload,
				events: finalEvents,
				truncated: truncated || cappedEarly,
			};

			if (response_format === 'markdown') {
				return {
					content: [
						{
							type: 'text',
							text: formatStreamMarkdown(url, agent, sid, textBuffer, resultPayload, events.length, truncated, truncationNote),
						},
					],
					structuredContent: output,
				};
			}
			return jsonText(output);
		},
	);

	server.registerTool(
		'flue_add_endpoint',
		{
			title: 'Add Flue Endpoint',
			description: `Register a Flue endpoint by name for later reuse.

Persists to \$FLUE_LOOM_HOME/endpoints.json (default: ~/.config/flue-loom/endpoints.json). Once registered, refer to the endpoint by name in other tools instead of the full URL.

Args:
  - name (string, required): Short name, e.g. "local", "prod-cf", "staging".
  - url (string, required): Full URL. Validated with new URL() — must be http(s)://. Trailing slashes are stripped.
  - default (boolean, optional): If true, set as the default endpoint. The first registered endpoint becomes default automatically.

Returns:
  { "ok": true, "registry": { "endpoints": [...], "defaultName"?: string } }

Examples:
  - "Save localhost as 'local' default" → name="local", url="http://localhost:3583", default=true
  - "Register the prod worker" → name="prod-cf", url="https://my-agents.example.workers.dev"

Errors:
  - Invalid URL → "Invalid URL: <url>. Expected http(s)://host[:port][/path]."`,
			inputSchema: {
				name: z
					.string()
					.min(1, 'name cannot be empty')
					.describe('Short name for the endpoint, e.g. "local" or "prod-cf".'),
				url: z
					.string()
					.describe('Full URL to the Flue HTTP endpoint, e.g. http://localhost:3583.'),
				default: z
					.boolean()
					.optional()
					.describe('If true, set as the default endpoint for endpoint-less calls.'),
			},
			outputSchema: {
				ok: z.literal(true),
				registry: RegistryShape,
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ name, url, default: makeDefault }) => {
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(url);
			} catch {
				return errorText(
					`Invalid URL: "${url}". Expected http(s)://host[:port][/path].`,
					{ name, url, ok: false },
				);
			}
			if (!/^https?:$/.test(parsedUrl.protocol)) {
				return errorText(
					`Unsupported URL protocol "${parsedUrl.protocol}". Expected http: or https:.`,
					{ name, url, ok: false },
				);
			}

			const state = await addEndpoint(name, url, makeDefault);
			const output: Record<string, unknown> = { ok: true as const, registry: state };
			return jsonText(output);
		},
	);

	server.registerTool(
		'flue_list_endpoints',
		{
			title: 'List Flue Endpoints',
			description: `List all registered Flue endpoints and the current default.

Reads \$FLUE_LOOM_HOME/endpoints.json. Use to see which endpoints are configured before referencing one by name in flue_invoke_agent / flue_list_agents.

Args:
  - response_format ('json' | 'markdown', optional): Default 'json'.

Returns:
  {
    "endpoints": [{ "name": string, "url": string }],   // empty array on cold start
    "defaultName"?: string                               // omitted when no default is set
  }

Examples:
  - "Which endpoints are configured?"
  - "What URL is 'prod-cf' pointing to?" → look at endpoints[] for the matching name

Errors: none in normal operation. A corrupted registry file logs to stderr and returns an empty list (so subsequent flue_add_endpoint can repair).`,
			inputSchema: {
				response_format: ResponseFormat,
			},
			outputSchema: {
				endpoints: z.array(EndpointEntry),
				defaultName: z.string().optional(),
			},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ response_format }) => {
			const state = await listEndpoints();
			const output: Record<string, unknown> = {
				endpoints: state.endpoints,
				...(state.defaultName !== undefined ? { defaultName: state.defaultName } : {}),
			};
			if (response_format === 'markdown') {
				return {
					content: [{ type: 'text', text: formatEndpointsMarkdown(state) }],
					structuredContent: output,
				};
			}
			return jsonText(output);
		},
	);

	server.registerTool(
		'flue_remove_endpoint',
		{
			title: 'Remove Flue Endpoint',
			description: `Remove a registered Flue endpoint by name.

If the removed endpoint was the default, the default switches to the first remaining endpoint (or undefined if none remain). Removing a non-existent name is a no-op — the registry is returned unchanged.

Args:
  - name (string, required): Name of the endpoint to remove.

Returns:
  { "ok": true, "registry": { "endpoints": [...], "defaultName"?: string } }

Examples:
  - "Forget the staging endpoint" → name="staging"`,
			inputSchema: {
				name: z.string().min(1, 'name cannot be empty').describe('Name of the endpoint to remove.'),
			},
			outputSchema: {
				ok: z.literal(true),
				registry: RegistryShape,
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ name }) => {
			const state = await removeEndpoint(name);
			const output: Record<string, unknown> = { ok: true as const, registry: state };
			return jsonText(output);
		},
	);
}
