#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";

//#region src/http.ts
async function httpJson(url, opts = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6e4);
	try {
		const res = await fetch(url, {
			method: opts.method ?? "GET",
			headers: {
				"Content-Type": "application/json",
				...opts.headers
			},
			body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0,
			signal: controller.signal
		});
		const text = await res.text();
		const parsed = (res.headers.get("content-type") ?? "").includes("application/json") && text ? JSON.parse(text) : text;
		if (!res.ok) {
			const message = typeof parsed === "object" && parsed !== null && "error" in parsed ? JSON.stringify(parsed.error) : typeof parsed === "string" ? parsed : res.statusText;
			throw new Error(`${res.status} ${res.statusText}: ${message}`);
		}
		return parsed;
	} finally {
		clearTimeout(timeout);
	}
}

//#endregion
//#region src/sse.ts
async function* parseSse(body) {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	let event = "";
	let dataLines = [];
	const flush = () => {
		if (event === "" && dataLines.length === 0) return void 0;
		const e = {
			event: event || "message",
			data: dataLines.join("\n")
		};
		event = "";
		dataLines = [];
		return e;
	};
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).replace(/\r$/, "");
			buffer = buffer.slice(nl + 1);
			if (line === "") {
				const e = flush();
				if (e) yield e;
				continue;
			}
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			const rawValue = colon === -1 ? "" : line.slice(colon + 1);
			const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
			if (field === "event") event = value;
			else if (field === "data") dataLines.push(value);
		}
	}
	const trailing = flush();
	if (trailing) yield trailing;
}
async function postSse(url, body, headers = {}) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...headers
		},
		body: JSON.stringify(body ?? {})
	});
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(`SSE POST failed: ${res.status} ${res.statusText}: ${text}`);
	}
	if (!res.body) throw new Error("SSE response has no body");
	return res.body;
}

//#endregion
//#region src/registry.ts
function registryPath() {
	return `${process.env.FLUE_LOOM_HOME ?? `${homedir()}/.config/flue-loom`}/endpoints.json`;
}
async function readRegistry() {
	try {
		const raw = await readFile(registryPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.endpoints)) parsed.endpoints = [];
		return parsed;
	} catch {
		return { endpoints: [] };
	}
}
async function writeRegistry(state) {
	const path = registryPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
let mutationChain = Promise.resolve();
function withMutation(work) {
	const next = mutationChain.then(work, work);
	mutationChain = next.catch(() => {});
	return next;
}
async function listEndpoints() {
	return withMutation(() => readRegistry());
}
async function addEndpoint(name, url, makeDefault) {
	return withMutation(async () => {
		const state = await readRegistry();
		const existing = state.endpoints.findIndex((e) => e.name === name);
		if (existing >= 0) state.endpoints[existing] = {
			name,
			url
		};
		else state.endpoints.push({
			name,
			url
		});
		if (makeDefault) state.defaultName = name;
		if (!state.defaultName && state.endpoints.length === 1) state.defaultName = name;
		await writeRegistry(state);
		return state;
	});
}
async function removeEndpoint(name) {
	return withMutation(async () => {
		const state = await readRegistry();
		state.endpoints = state.endpoints.filter((e) => e.name !== name);
		if (state.defaultName === name) state.defaultName = state.endpoints[0]?.name;
		await writeRegistry(state);
		return state;
	});
}
/**
* Resolve an endpoint reference to a URL.
*
* Order:
*   1. Explicit URL (starts with http:// or https://)
*   2. Registry by name
*   3. Registry default
*   4. Built-in fallback (http://localhost:3583)
*/
async function resolveEndpoint(ref) {
	if (ref && /^https?:\/\//.test(ref)) return ref.replace(/\/$/, "");
	const state = await readRegistry();
	if (ref) {
		const match = state.endpoints.find((e) => e.name === ref);
		if (match) return match.url.replace(/\/$/, "");
		throw new Error(`Endpoint "${ref}" not found in registry. Add it with add_endpoint.`);
	}
	if (state.defaultName) {
		const match = state.endpoints.find((e) => e.name === state.defaultName);
		if (match) return match.url.replace(/\/$/, "");
	}
	return "http://localhost:3583";
}

//#endregion
//#region src/tools/index.ts
const ListAgentsInput = v.object({ endpoint: v.optional(v.string("Endpoint URL or registered endpoint name. Falls back to default.")) });
const InvokeAgentInput = v.object({
	endpoint: v.optional(v.string()),
	agent: v.string("Agent name (matches the file at .flue/agents/<name>.{ts,js})"),
	sessionId: v.optional(v.string("Session id; defaults to \"default\".")),
	payload: v.optional(v.any()),
	mode: v.optional(v.picklist(["sync", "webhook"], "Invocation mode. \"sync\" returns the result; \"webhook\" is fire-and-forget (returns 202)."))
});
const StreamAgentInput = v.object({
	endpoint: v.optional(v.string()),
	agent: v.string(),
	sessionId: v.optional(v.string()),
	payload: v.optional(v.any())
});
const GetManifestInput = v.object({ endpoint: v.optional(v.string()) });
const AddEndpointInput = v.object({
	name: v.string("Short name for the endpoint, e.g. \"local\" or \"prod-cf\"."),
	url: v.string("Full URL to the Flue HTTP endpoint, e.g. http://localhost:3583."),
	default: v.optional(v.boolean("If true, set as the default endpoint."))
});
const ListEndpointsInput = v.object({});
const RemoveEndpointInput = v.object({ name: v.string() });
async function callListAgents(input) {
	const url = await resolveEndpoint(input.endpoint);
	const data = await httpJson(`${url}/agents`);
	return { content: [{
		type: "text",
		text: JSON.stringify({
			endpoint: url,
			...data
		}, null, 2)
	}] };
}
async function callInvokeAgent(input) {
	const url = await resolveEndpoint(input.endpoint);
	const sessionId = input.sessionId ?? "default";
	const path = `${url}/agents/${encodeURIComponent(input.agent)}/${encodeURIComponent(sessionId)}`;
	if (input.mode === "webhook") {
		const res = await fetch(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-webhook": "true"
			},
			body: JSON.stringify(input.payload ?? {})
		});
		return { content: [{
			type: "text",
			text: JSON.stringify({
				status: res.status,
				mode: "webhook"
			})
		}] };
	}
	const data = await httpJson(path, {
		method: "POST",
		body: input.payload ?? {}
	});
	return { content: [{
		type: "text",
		text: JSON.stringify(data, null, 2)
	}] };
}
async function callStreamAgent(input) {
	const url = await resolveEndpoint(input.endpoint);
	const sessionId = input.sessionId ?? "default";
	const stream = await postSse(`${url}/agents/${encodeURIComponent(input.agent)}/${encodeURIComponent(sessionId)}`, input.payload ?? {});
	const events = [];
	let textBuffer = "";
	let resultPayload = void 0;
	for await (const ev of parseSse(stream)) {
		let parsed = ev.data;
		try {
			parsed = JSON.parse(ev.data);
		} catch {}
		events.push({
			event: ev.event,
			data: parsed
		});
		if (ev.event === "text" && parsed && typeof parsed === "object" && "text" in parsed) textBuffer += String(parsed.text ?? "");
		if (ev.event === "result") resultPayload = parsed;
	}
	return { content: [{
		type: "text",
		text: JSON.stringify({
			endpoint: url,
			agent: input.agent,
			sessionId,
			text: textBuffer,
			result: resultPayload,
			events
		}, null, 2)
	}] };
}
async function callGetManifest(input) {
	const url = await resolveEndpoint(input.endpoint);
	const data = await httpJson(`${url}/agents`);
	return { content: [{
		type: "text",
		text: JSON.stringify({
			endpoint: url,
			...data ?? {}
		}, null, 2)
	}] };
}
async function callAddEndpoint(input) {
	const state = await addEndpoint(input.name, input.url, input.default);
	return { content: [{
		type: "text",
		text: JSON.stringify({
			ok: true,
			registry: state
		}, null, 2)
	}] };
}
async function callListEndpoints(_input) {
	const state = await listEndpoints();
	return { content: [{
		type: "text",
		text: JSON.stringify(state, null, 2)
	}] };
}
async function callRemoveEndpoint(input) {
	const state = await removeEndpoint(input.name);
	return { content: [{
		type: "text",
		text: JSON.stringify({
			ok: true,
			registry: state
		}, null, 2)
	}] };
}
function makeTool(name, description, schema, call) {
	return {
		name,
		description,
		inputSchema: toJsonSchema(schema),
		call: async (raw) => {
			return call(v.parse(schema, raw ?? {}));
		}
	};
}
const tools = [
	makeTool("list_agents", "List all agents at a Flue HTTP endpoint (manifest from GET /agents).", ListAgentsInput, callListAgents),
	makeTool("invoke_agent", "Invoke a Flue agent in sync mode (default) or as a webhook (fire-and-forget). Returns the result envelope.", InvokeAgentInput, callInvokeAgent),
	makeTool("stream_agent", "Invoke a Flue agent and stream events via SSE. Returns the accumulated text, structured result, and full event log.", StreamAgentInput, callStreamAgent),
	makeTool("get_manifest", "Fetch the agent manifest from a Flue endpoint. Currently equivalent to list_agents; kept distinct for future fields.", GetManifestInput, callGetManifest),
	makeTool("add_endpoint", "Register a Flue endpoint by name. Persisted to $FLUE_LOOM_HOME/endpoints.json.", AddEndpointInput, callAddEndpoint),
	makeTool("list_endpoints", "List all registered Flue endpoints and the current default.", ListEndpointsInput, callListEndpoints),
	makeTool("remove_endpoint", "Remove a registered endpoint by name.", RemoveEndpointInput, callRemoveEndpoint)
];

//#endregion
//#region src/server.ts
const server = new Server({
	name: "flue-loom",
	version: "0.1.0"
}, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((t) => ({
	name: t.name,
	description: t.description,
	inputSchema: t.inputSchema
})) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const tool = tools.find((t) => t.name === request.params.name);
	if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
	try {
		return await tool.call(request.params.arguments);
	} catch (err) {
		return {
			content: [{
				type: "text",
				text: `Error: ${err instanceof Error ? err.message : String(err)}`
			}],
			isError: true
		};
	}
});
const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.resume();

//#endregion
export {  };