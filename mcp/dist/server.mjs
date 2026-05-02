#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
const AgentSummary = z.object({
	name: z.string(),
	triggers: z.unknown().optional()
}).passthrough();
const EndpointEntry = z.object({
	name: z.string(),
	url: z.string()
});
const RegistryShape = z.object({
	endpoints: z.array(EndpointEntry),
	defaultName: z.string().optional()
});
function registerTools(server) {
	server.registerTool("list_agents", {
		title: "List Agents",
		description: "List all agents at a Flue HTTP endpoint (manifest from GET /agents).",
		inputSchema: { endpoint: z.string().optional().describe("Endpoint URL or registered endpoint name. Falls back to default.") },
		outputSchema: {
			endpoint: z.string(),
			agents: z.array(AgentSummary)
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		}
	}, async ({ endpoint }) => {
		const url = await resolveEndpoint(endpoint);
		const data = await httpJson(`${url}/agents`);
		const output = {
			endpoint: url,
			agents: Array.isArray(data?.agents) ? data.agents : []
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
	server.registerTool("invoke_agent", {
		title: "Invoke Agent",
		description: "Invoke a Flue agent in sync mode (default) or as a webhook (fire-and-forget). Returns the result envelope.",
		inputSchema: {
			endpoint: z.string().optional().describe("Endpoint URL or registered endpoint name. Falls back to default."),
			agent: z.string().describe("Agent name (matches the file at .flue/agents/<name>.{ts,js,mts,mjs})."),
			sessionId: z.string().optional().describe("Session id; defaults to \"default\"."),
			payload: z.unknown().optional().describe("JSON-serializable payload passed to the agent handler as ctx.payload."),
			mode: z.enum(["sync", "webhook"]).optional().describe("Invocation mode. \"sync\" returns the result body; \"webhook\" is fire-and-forget (HTTP 202). Default: sync.")
		},
		outputSchema: {
			endpoint: z.string(),
			agent: z.string(),
			sessionId: z.string(),
			mode: z.enum(["sync", "webhook"]),
			result: z.unknown().optional(),
			status: z.number().optional()
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		}
	}, async ({ endpoint, agent, sessionId, payload, mode }) => {
		const url = await resolveEndpoint(endpoint);
		const sid = sessionId ?? "default";
		const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
		if ((mode ?? "sync") === "webhook") {
			const output = {
				endpoint: url,
				agent,
				sessionId: sid,
				mode: "webhook",
				status: (await fetch(path, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-webhook": "true"
					},
					body: JSON.stringify(payload ?? {})
				})).status
			};
			return {
				content: [{
					type: "text",
					text: JSON.stringify(output, null, 2)
				}],
				structuredContent: output
			};
		}
		const output = {
			endpoint: url,
			agent,
			sessionId: sid,
			mode: "sync",
			result: await httpJson(path, {
				method: "POST",
				body: payload ?? {}
			})
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
	server.registerTool("stream_agent", {
		title: "Stream Agent",
		description: "Invoke a Flue agent and stream events via SSE. Returns the accumulated text, structured result, and full event log.",
		inputSchema: {
			endpoint: z.string().optional().describe("Endpoint URL or registered endpoint name. Falls back to default."),
			agent: z.string().describe("Agent name."),
			sessionId: z.string().optional().describe("Session id; defaults to \"default\"."),
			payload: z.unknown().optional().describe("JSON-serializable payload passed to the agent handler.")
		},
		outputSchema: {
			endpoint: z.string(),
			agent: z.string(),
			sessionId: z.string(),
			text: z.string(),
			result: z.unknown().optional(),
			events: z.array(z.object({
				event: z.string(),
				data: z.unknown()
			}))
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		}
	}, async ({ endpoint, agent, sessionId, payload }) => {
		const url = await resolveEndpoint(endpoint);
		const sid = sessionId ?? "default";
		const stream = await postSse(`${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`, payload ?? {});
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
		const output = {
			endpoint: url,
			agent,
			sessionId: sid,
			text: textBuffer,
			result: resultPayload,
			events
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
	server.registerTool("get_manifest", {
		title: "Get Manifest",
		description: "Fetch the agent manifest from a Flue endpoint. Currently equivalent to list_agents; kept distinct for future fields.",
		inputSchema: { endpoint: z.string().optional().describe("Endpoint URL or registered endpoint name. Falls back to default.") },
		outputSchema: {
			endpoint: z.string(),
			agents: z.array(AgentSummary)
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		}
	}, async ({ endpoint }) => {
		const url = await resolveEndpoint(endpoint);
		const data = await httpJson(`${url}/agents`);
		const output = {
			endpoint: url,
			agents: Array.isArray(data?.agents) ? data.agents : []
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
	server.registerTool("add_endpoint", {
		title: "Add Endpoint",
		description: "Register a Flue endpoint by name. Persisted to $FLUE_LOOM_HOME/endpoints.json.",
		inputSchema: {
			name: z.string().describe("Short name for the endpoint, e.g. \"local\" or \"prod-cf\"."),
			url: z.string().describe("Full URL to the Flue HTTP endpoint, e.g. http://localhost:3583."),
			default: z.boolean().optional().describe("If true, set as the default endpoint for endpoint-less calls.")
		},
		outputSchema: {
			ok: z.literal(true),
			registry: RegistryShape
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async ({ name, url, default: makeDefault }) => {
		const output = {
			ok: true,
			registry: await addEndpoint(name, url, makeDefault)
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
	server.registerTool("list_endpoints", {
		title: "List Endpoints",
		description: "List all registered Flue endpoints and the current default.",
		inputSchema: {},
		outputSchema: {
			endpoints: z.array(EndpointEntry),
			defaultName: z.string().optional()
		},
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async () => {
		const state = await listEndpoints();
		const output = {
			endpoints: state.endpoints,
			...state.defaultName !== void 0 ? { defaultName: state.defaultName } : {}
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
	server.registerTool("remove_endpoint", {
		title: "Remove Endpoint",
		description: "Remove a registered endpoint by name.",
		inputSchema: { name: z.string().describe("Name of the endpoint to remove.") },
		outputSchema: {
			ok: z.literal(true),
			registry: RegistryShape
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async ({ name }) => {
		const output = {
			ok: true,
			registry: await removeEndpoint(name)
		};
		return {
			content: [{
				type: "text",
				text: JSON.stringify(output, null, 2)
			}],
			structuredContent: output
		};
	});
}

//#endregion
//#region src/server.ts
const server = new McpServer({
	name: "flue-loom",
	version: "0.1.0"
});
registerTools(server);
const transport = new StdioServerTransport();
await server.connect(transport);

//#endregion
export {  };