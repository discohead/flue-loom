import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';

import { httpJson } from '../http.ts';
import { postSse, parseSse } from '../sse.ts';
import {
	addEndpoint,
	listEndpoints,
	removeEndpoint,
	resolveEndpoint,
} from '../registry.ts';

// ─── Tool schemas (valibot → JSON Schema for MCP listTools) ──────────────────

const ListAgentsInput = v.object({
	endpoint: v.optional(
		v.string('Endpoint URL or registered endpoint name. Falls back to default.'),
	),
});

const InvokeAgentInput = v.object({
	endpoint: v.optional(v.string()),
	agent: v.string('Agent name (matches the file at .flue/agents/<name>.{ts,js})'),
	sessionId: v.optional(v.string('Session id; defaults to "default".')),
	payload: v.optional(v.any()),
	mode: v.optional(
		v.picklist(['sync', 'webhook'], 'Invocation mode. "sync" returns the result; "webhook" is fire-and-forget (returns 202).'),
	),
});

const StreamAgentInput = v.object({
	endpoint: v.optional(v.string()),
	agent: v.string(),
	sessionId: v.optional(v.string()),
	payload: v.optional(v.any()),
});

const GetManifestInput = v.object({
	endpoint: v.optional(v.string()),
});

const AddEndpointInput = v.object({
	name: v.string('Short name for the endpoint, e.g. "local" or "prod-cf".'),
	url: v.string('Full URL to the Flue HTTP endpoint, e.g. http://localhost:3583.'),
	default: v.optional(v.boolean('If true, set as the default endpoint.')),
});

const ListEndpointsInput = v.object({});

const RemoveEndpointInput = v.object({
	name: v.string(),
});

// ─── Tool implementations ────────────────────────────────────────────────────

async function callListAgents(input: v.InferOutput<typeof ListAgentsInput>) {
	const url = await resolveEndpoint(input.endpoint);
	const data = await httpJson<{ agents?: Array<{ name: string; triggers?: unknown }> }>(
		`${url}/agents`,
	);
	return {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({ endpoint: url, ...data }, null, 2),
			},
		],
	};
}

async function callInvokeAgent(input: v.InferOutput<typeof InvokeAgentInput>) {
	const url = await resolveEndpoint(input.endpoint);
	const sessionId = input.sessionId ?? 'default';
	const path = `${url}/agents/${encodeURIComponent(input.agent)}/${encodeURIComponent(sessionId)}`;

	if (input.mode === 'webhook') {
		const res = await fetch(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-webhook': 'true' },
			body: JSON.stringify(input.payload ?? {}),
		});
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify({ status: res.status, mode: 'webhook' }),
				},
			],
		};
	}

	const data = await httpJson(path, { method: 'POST', body: input.payload ?? {} });
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
	};
}

async function callStreamAgent(input: v.InferOutput<typeof StreamAgentInput>) {
	const url = await resolveEndpoint(input.endpoint);
	const sessionId = input.sessionId ?? 'default';
	const path = `${url}/agents/${encodeURIComponent(input.agent)}/${encodeURIComponent(sessionId)}`;

	const stream = await postSse(path, input.payload ?? {});

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

		if (ev.event === 'text' && parsed && typeof parsed === 'object' && 'text' in parsed) {
			textBuffer += String((parsed as { text: unknown }).text ?? '');
		}
		if (ev.event === 'result') {
			resultPayload = parsed;
		}
	}

	return {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify(
					{
						endpoint: url,
						agent: input.agent,
						sessionId,
						text: textBuffer,
						result: resultPayload,
						events,
					},
					null,
					2,
				),
			},
		],
	};
}

async function callGetManifest(input: v.InferOutput<typeof GetManifestInput>) {
	// /agents IS the manifest at runtime; we just expose it under a clearer name.
	const url = await resolveEndpoint(input.endpoint);
	const data = await httpJson(`${url}/agents`);
	return {
		content: [{ type: 'text' as const, text: JSON.stringify({ endpoint: url, ...((data as object) ?? {}) }, null, 2) }],
	};
}

async function callAddEndpoint(input: v.InferOutput<typeof AddEndpointInput>) {
	const state = await addEndpoint(input.name, input.url, input.default);
	return {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({ ok: true, registry: state }, null, 2),
			},
		],
	};
}

async function callListEndpoints(_input: v.InferOutput<typeof ListEndpointsInput>) {
	const state = await listEndpoints();
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }],
	};
}

async function callRemoveEndpoint(input: v.InferOutput<typeof RemoveEndpointInput>) {
	const state = await removeEndpoint(input.name);
	return {
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({ ok: true, registry: state }, null, 2),
			},
		],
	};
}

// ─── Registry ────────────────────────────────────────────────────────────────

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: object;
	call: (input: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

function makeTool<TSchema extends v.GenericSchema>(
	name: string,
	description: string,
	schema: TSchema,
	call: (input: v.InferOutput<TSchema>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
): ToolDef {
	return {
		name,
		description,
		inputSchema: toJsonSchema(schema) as object,
		call: async (raw: unknown) => {
			const parsed = v.parse(schema, raw ?? {});
			return call(parsed);
		},
	};
}

export const tools: ToolDef[] = [
	makeTool(
		'list_agents',
		'List all agents at a Flue HTTP endpoint (manifest from GET /agents).',
		ListAgentsInput,
		callListAgents,
	),
	makeTool(
		'invoke_agent',
		'Invoke a Flue agent in sync mode (default) or as a webhook (fire-and-forget). Returns the result envelope.',
		InvokeAgentInput,
		callInvokeAgent,
	),
	makeTool(
		'stream_agent',
		'Invoke a Flue agent and stream events via SSE. Returns the accumulated text, structured result, and full event log.',
		StreamAgentInput,
		callStreamAgent,
	),
	makeTool(
		'get_manifest',
		'Fetch the agent manifest from a Flue endpoint. Currently equivalent to list_agents; kept distinct for future fields.',
		GetManifestInput,
		callGetManifest,
	),
	makeTool(
		'add_endpoint',
		'Register a Flue endpoint by name. Persisted to $FLUE_LOOM_HOME/endpoints.json.',
		AddEndpointInput,
		callAddEndpoint,
	),
	makeTool(
		'list_endpoints',
		'List all registered Flue endpoints and the current default.',
		ListEndpointsInput,
		callListEndpoints,
	),
	makeTool(
		'remove_endpoint',
		'Remove a registered endpoint by name.',
		RemoveEndpointInput,
		callRemoveEndpoint,
	),
];
