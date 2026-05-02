import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { httpJson } from '../http.ts';
import { postSse, parseSse } from '../sse.ts';
import {
	addEndpoint,
	listEndpoints,
	removeEndpoint,
	resolveEndpoint,
} from '../registry.ts';

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
		async ({ endpoint }) => {
			const url = await resolveEndpoint(endpoint);
			const data = await httpJson<{ agents?: unknown }>(`${url}/agents`);
			const agents = Array.isArray(data?.agents) ? data.agents : [];
			const output = { endpoint: url, agents } as { endpoint: string; agents: unknown[] };
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
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
  - 404 → agent not found; try flue_list_agents to see available names
  - 403 → trigger-less agent in production mode; the endpoint must be running with FLUE_MODE=local (\`flue dev\` and \`flue run\` set this automatically)
  - Network timeout (60s) → consider flue_stream_agent for long-running agents`,
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
		async ({ endpoint, agent, sessionId, payload, mode }) => {
			const url = await resolveEndpoint(endpoint);
			const sid = sessionId ?? 'default';
			const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
			const m = mode ?? 'sync';

			if (m === 'webhook') {
				const res = await fetch(path, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-webhook': 'true' },
					body: JSON.stringify(payload ?? {}),
				});
				const output = {
					endpoint: url,
					agent,
					sessionId: sid,
					mode: 'webhook' as const,
					status: res.status,
				};
				return {
					content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
					structuredContent: output,
				};
			}

			const data = await httpJson(path, { method: 'POST', body: payload ?? {} });
			const output = {
				endpoint: url,
				agent,
				sessionId: sid,
				mode: 'sync' as const,
				result: data,
			};
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		'flue_stream_agent',
		{
			title: 'Stream Flue Agent',
			description: `Invoke a Flue agent with SSE streaming and return the accumulated output.

Like flue_invoke_agent in sync mode, but uses Server-Sent Events to stream the agent's progress. Useful for long-running agents (multi-turn LLM work) where you want to see text incrementally and inspect tool calls. Returns the final assembled state once the stream completes.

Args:
  - endpoint (string, optional): Same as flue_invoke_agent.
  - agent (string, required): Agent name.
  - sessionId (string, optional): Session id. Default: "default".
  - payload (any, optional): Agent payload.

Returns:
  {
    "endpoint": string,
    "agent": string,
    "sessionId": string,
    "text": string,                  // Concatenated 'text' event payloads
    "result": <unknown>,              // Final 'result' event payload
    "events": [                       // Full event log for replay/inspection
      { "event": string, "data": <unknown> }
    ]
  }

Event types in 'events':
  - 'start': agent began
  - 'text': streaming LLM text chunk
  - 'tool_use': agent called a tool
  - 'idle': agent paused (tool result expected)
  - 'result': final return value
  - 'error': failure

Examples:
  - "Run hello with streaming" → agent="hello"
  - "Watch tool calls during a turn" → events[] where event === 'tool_use'
  - Long-running agents that exceed the sync 60s timeout

Errors:
  - HTTP failures: same status codes as flue_invoke_agent
  - Connection drops mid-stream: 'events' contains everything received so far
  - No client-side timeout currently (added in v0.2)`,
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
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ endpoint, agent, sessionId, payload }) => {
			const url = await resolveEndpoint(endpoint);
			const sid = sessionId ?? 'default';
			const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;

			const stream = await postSse(path, payload ?? {});

			const events: Array<{ event: string; data: unknown }> = [];
			let textBuffer = '';
			let resultPayload: unknown = undefined;

			for await (const ev of parseSse(stream)) {
				let parsed: unknown = ev.data;
				try {
					parsed = JSON.parse(ev.data);
				} catch {
					// keep as string
				}
				events.push({ event: ev.event, data: parsed });

				if (
					ev.event === 'text' &&
					parsed &&
					typeof parsed === 'object' &&
					'text' in parsed
				) {
					textBuffer += String((parsed as { text: unknown }).text ?? '');
				}
				if (ev.event === 'result') {
					resultPayload = parsed;
				}
			}

			const output = {
				endpoint: url,
				agent,
				sessionId: sid,
				text: textBuffer,
				result: resultPayload,
				events,
			};
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		'flue_get_manifest',
		{
			title: 'Get Flue Manifest',
			description: `Fetch the agent manifest from a Flue endpoint.

Currently equivalent to flue_list_agents — both call GET /agents and return the same shape. Kept as a separate tool for forward compatibility (a future Flue version may differentiate manifest metadata from runtime registry).

Args:
  - endpoint (string, optional): Endpoint URL or registered endpoint name.

Returns: same shape as flue_list_agents.

Note: this tool may be removed in a future version. Prefer flue_list_agents.`,
			inputSchema: {
				endpoint: z
					.string()
					.optional()
					.describe('Endpoint URL or registered endpoint name. Falls back to default.'),
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
		async ({ endpoint }) => {
			const url = await resolveEndpoint(endpoint);
			const data = await httpJson<{ agents?: unknown }>(`${url}/agents`);
			const agents = Array.isArray(data?.agents) ? data.agents : [];
			const output = { endpoint: url, agents } as { endpoint: string; agents: unknown[] };
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
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
  - url (string, required): Full URL to the Flue HTTP endpoint. Trailing slashes are stripped.
  - default (boolean, optional): If true, set as the default endpoint. The first registered endpoint becomes default automatically.

Returns:
  { "ok": true, "registry": { "endpoints": [...], "defaultName"?: string } }

Examples:
  - "Save localhost as 'local' default" → name="local", url="http://localhost:3583", default=true
  - "Register the prod worker" → name="prod-cf", url="https://my-agents.example.workers.dev"

Errors:
  - URL validation: malformed URLs are accepted as strings in v0.1; v0.2 adds new URL() validation.`,
			inputSchema: {
				name: z
					.string()
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
			const state = await addEndpoint(name, url, makeDefault);
			const output = { ok: true as const, registry: state };
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		'flue_list_endpoints',
		{
			title: 'List Flue Endpoints',
			description: `List all registered Flue endpoints and the current default.

Reads \$FLUE_LOOM_HOME/endpoints.json. Use to see which endpoints are configured before referencing one by name in flue_invoke_agent / flue_list_agents.

Args: (none)

Returns:
  {
    "endpoints": [{ "name": string, "url": string }],
    "defaultName"?: string
  }

Examples:
  - "Which endpoints are configured?"
  - "What URL is 'prod-cf' pointing to?" → look at endpoints[] for the matching name`,
			inputSchema: {},
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
		async () => {
			const state = await listEndpoints();
			const output = {
				endpoints: state.endpoints,
				...(state.defaultName !== undefined ? { defaultName: state.defaultName } : {}),
			};
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
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
				name: z.string().describe('Name of the endpoint to remove.'),
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
			const output = { ok: true as const, registry: state };
			return {
				content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
				structuredContent: output,
			};
		},
	);
}
