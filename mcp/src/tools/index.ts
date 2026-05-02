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
		'list_agents',
		{
			title: 'List Agents',
			description: 'List all agents at a Flue HTTP endpoint (manifest from GET /agents).',
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
		'invoke_agent',
		{
			title: 'Invoke Agent',
			description:
				'Invoke a Flue agent in sync mode (default) or as a webhook (fire-and-forget). Returns the result envelope.',
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
					.describe('Session id; defaults to "default".'),
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
		'stream_agent',
		{
			title: 'Stream Agent',
			description:
				'Invoke a Flue agent and stream events via SSE. Returns the accumulated text, structured result, and full event log.',
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
		'get_manifest',
		{
			title: 'Get Manifest',
			description:
				'Fetch the agent manifest from a Flue endpoint. Currently equivalent to list_agents; kept distinct for future fields.',
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
		'add_endpoint',
		{
			title: 'Add Endpoint',
			description: 'Register a Flue endpoint by name. Persisted to $FLUE_LOOM_HOME/endpoints.json.',
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
		'list_endpoints',
		{
			title: 'List Endpoints',
			description: 'List all registered Flue endpoints and the current default.',
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
		'remove_endpoint',
		{
			title: 'Remove Endpoint',
			description: 'Remove a registered endpoint by name.',
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
