#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";

//#region src/http.ts
var HttpError = class extends Error {
	status;
	statusText;
	body;
	url;
	constructor(status, statusText, body, url) {
		const bodyStr = typeof body === "object" && body !== null ? JSON.stringify(body) : typeof body === "string" ? body : String(body);
		super(`${status} ${statusText}: ${bodyStr}`);
		this.name = "HttpError";
		this.status = status;
		this.statusText = statusText;
		this.body = body;
		this.url = url;
	}
};
async function httpJson(url, opts = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6e4);
	const onCallerAbort = () => controller.abort();
	opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
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
		if (!res.ok) throw new HttpError(res.status, res.statusText, parsed, url);
		return parsed;
	} finally {
		clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", onCallerAbort);
	}
}
/**
* Map a thrown error from a Flue HTTP call to an actionable message that
* surfaces Flue-specific causes (trigger gating, structured error envelope,
* model resolution, etc.) instead of just the raw status code.
*
* Pass `context` so the message can name the agent/session/endpoint.
*/
function mapFlueError(error, context) {
	if (error instanceof HttpError) {
		const where = context.agent ? `agent "${context.agent}" (session "${context.sessionId ?? "default"}") at ${context.endpoint}` : context.endpoint;
		if (typeof error.body === "object" && error.body !== null && "error" in error.body && typeof error.body.error === "object") {
			const inner = error.body.error;
			const type = String(inner.type ?? "unknown");
			const message = String(inner.message ?? "no message");
			if (type === "agent_not_webhook") return `Flue error [agent_not_webhook]: ${message} (HTTP ${error.status} from ${where}). The agent has no \`triggers = { webhook: true }\` export, so it's only invokable when the endpoint runs with FLUE_MODE=local (\`flue dev\` and \`flue run\` set this automatically). Add a webhook trigger to expose it in production.`;
			return `Flue error [${type}]: ${message} (HTTP ${error.status} from ${where})`;
		}
		switch (error.status) {
			case 404: return context.agent ? `Agent "${context.agent}" not found at ${context.endpoint} (HTTP 404). Try flue_list_agents to see available agents, or — if you authored the agent — verify it exports \`triggers = { webhook: true }\` and the endpoint isn't filtering trigger-less agents (FLUE_MODE).` : `Endpoint not found: ${context.endpoint}. Verify the URL is correct and the server is running.`;
			case 401:
			case 403: return `Endpoint rejected the call (HTTP ${error.status}) for ${where}. The endpoint may require authentication credentials.`;
			case 408:
			case 504: return `Timed out talking to ${where}. Consider flue_stream_agent for long-running agents.`;
			case 429: return `Rate limited by ${context.endpoint}. Wait and retry.`;
			case 500:
			case 502:
			case 503: return `Server error (HTTP ${error.status}) at ${where}: ${typeof error.body === "string" ? error.body : JSON.stringify(error.body)}`;
			default: return `HTTP ${error.status} ${error.statusText} from ${where}: ${typeof error.body === "string" ? error.body : JSON.stringify(error.body)}`;
		}
	}
	if (error instanceof Error && error.name === "AbortError") return `Request aborted (timed out or cancelled).`;
	return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
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
	try {
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
	} catch (err) {
		if (dataLines.length > 0 || event !== "") yield {
			event: "__incomplete__",
			data: dataLines.join("\n")
		};
		throw err;
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
}
async function postSse(url, body, options = {}) {
	const ownCtl = options.signal ? null : new AbortController();
	const ownTimer = ownCtl ? setTimeout(() => ownCtl.abort(), 6e4) : null;
	const signal = options.signal ?? ownCtl.signal;
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...options.headers
			},
			body: JSON.stringify(body ?? {}),
			signal
		});
	} finally {
		if (ownTimer) clearTimeout(ownTimer);
	}
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		let parsed = text;
		try {
			parsed = JSON.parse(text);
		} catch {}
		throw new HttpError(res.status, res.statusText, parsed, url);
	}
	if (!res.body) throw new Error("SSE response has no body");
	return res.body;
}

//#endregion
//#region src/registry.ts
function registryPath() {
	return join(process.env.FLUE_LOOM_HOME ?? join(homedir(), ".config", "flue-loom"), "endpoints.json");
}
async function readRegistry() {
	try {
		const raw = await readFile(registryPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.endpoints)) parsed.endpoints = [];
		return parsed;
	} catch (err) {
		if (err?.code !== "ENOENT") {
			const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			console.error(`[flue-loom-mcp-server] registry read failed (${detail}); starting with empty registry`);
		}
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
		const before = state.endpoints.length;
		state.endpoints = state.endpoints.filter((e) => e.name !== name);
		if (state.endpoints.length === before) return state;
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
*   4. Built-in fallback (http://localhost:3583), only when registry is empty
*/
async function resolveEndpoint(ref) {
	if (ref && /^https?:\/\//.test(ref)) return ref.replace(/\/$/, "");
	return withMutation(async () => {
		const state = await readRegistry();
		if (ref) {
			const match = state.endpoints.find((e) => e.name === ref);
			if (match) return match.url.replace(/\/$/, "");
			throw new Error(`Endpoint "${ref}" not found in registry. Add it with flue_add_endpoint.`);
		}
		if (state.defaultName) {
			const match = state.endpoints.find((e) => e.name === state.defaultName);
			if (match) return match.url.replace(/\/$/, "");
			throw new Error(`Default endpoint "${state.defaultName}" is registered but no longer exists in the endpoints list. Add it back with flue_add_endpoint or set a different default.`);
		}
		if (state.endpoints.length > 0) throw new Error(`No default endpoint configured (registry has ${state.endpoints.length} entries: ${state.endpoints.map((e) => `"${e.name}"`).join(", ")}). Pass an explicit endpoint URL/name, or call flue_add_endpoint with default=true.`);
		return "http://localhost:3583";
	});
}

//#endregion
//#region src/format.ts
function formatAgentsMarkdown(endpoint, agents) {
	const lines = [];
	lines.push(`# Agents at \`${endpoint}\``);
	lines.push("");
	if (agents.length === 0) {
		lines.push("_No agents registered._");
		return lines.join("\n");
	}
	lines.push("| Agent | Webhook | Cron |");
	lines.push("|---|---|---|");
	for (const a of agents) {
		const t = a.triggers ?? {};
		lines.push(`| \`${a.name}\` | ${t.webhook ? "✓" : ""} | ${t.cron ? "`" + t.cron + "`" : ""} |`);
	}
	lines.push("");
	lines.push(`_${agents.length} agent${agents.length === 1 ? "" : "s"} total._`);
	return lines.join("\n");
}
function formatEndpointsMarkdown(state) {
	const lines = [];
	lines.push("# Registered Endpoints");
	lines.push("");
	if (state.endpoints.length === 0) {
		lines.push("_No endpoints registered. Use `flue_add_endpoint` to add one._");
		return lines.join("\n");
	}
	lines.push("| Default | Name | URL |");
	lines.push("|---|---|---|");
	for (const e of state.endpoints) {
		const isDefault = e.name === state.defaultName ? "★" : "";
		lines.push(`| ${isDefault} | \`${e.name}\` | ${e.url} |`);
	}
	lines.push("");
	lines.push(`_${state.endpoints.length} endpoint${state.endpoints.length === 1 ? "" : "s"} total._`);
	return lines.join("\n");
}
function formatInvokeMarkdown(endpoint, agent, sessionId, mode, body) {
	const lines = [];
	lines.push(`# Invoke \`${agent}\` (${mode})`);
	lines.push("");
	lines.push(`- **Endpoint**: \`${endpoint}\``);
	lines.push(`- **Session**: \`${sessionId}\``);
	lines.push("");
	if (mode === "webhook") {
		const w = body;
		lines.push(`Webhook accepted (HTTP ${w.status ?? "?"}).`);
	} else {
		lines.push("## Result");
		lines.push("");
		lines.push("```json");
		lines.push(JSON.stringify(body, null, 2));
		lines.push("```");
	}
	return lines.join("\n");
}
function formatStreamMarkdown(endpoint, agent, sessionId, text, result, eventCount, truncated, truncationNote) {
	const lines = [];
	lines.push(`# Stream \`${agent}\``);
	lines.push("");
	lines.push(`- **Endpoint**: \`${endpoint}\``);
	lines.push(`- **Session**: \`${sessionId}\``);
	lines.push(`- **Events**: ${eventCount}${truncated ? " (truncated)" : ""}`);
	lines.push("");
	if (text) {
		lines.push("## Output");
		lines.push("");
		lines.push(text.trim());
		lines.push("");
	}
	if (result !== void 0) {
		lines.push("## Result");
		lines.push("");
		lines.push("```json");
		lines.push(JSON.stringify(result, null, 2));
		lines.push("```");
	}
	if (truncationNote) {
		lines.push("");
		lines.push(`> **Note**: ${truncationNote}`);
	}
	return lines.join("\n");
}

//#endregion
//#region src/constants.ts
const CHARACTER_LIMIT = 25e3;
const DEFAULT_STREAM_TIMEOUT_MS = 3e5;
const MAX_EVENTS = 5e3;

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
const ResponseFormat = z.enum(["json", "markdown"]).optional().describe("Format of the text content. \"json\" (default) returns a stringified JSON envelope; \"markdown\" returns a human-readable formatted block. structuredContent is identical regardless.");
function jsonText(output) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(output, null, 2)
		}],
		structuredContent: output
	};
}
function errorText(message, structured) {
	return {
		content: [{
			type: "text",
			text: message
		}],
		structuredContent: structured,
		isError: true
	};
}
function registerTools(server) {
	server.registerTool("flue_list_agents", {
		title: "List Flue Agents",
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
			endpoint: z.string().optional().describe("Endpoint URL (http://… or https://…) or registered endpoint name. Falls back to registry default, then http://localhost:3583."),
			response_format: ResponseFormat
		},
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
	}, async ({ endpoint, response_format }) => {
		let url;
		try {
			url = await resolveEndpoint(endpoint);
		} catch (err) {
			return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? "" });
		}
		try {
			const data = await httpJson(`${url}/agents`);
			const agents = Array.isArray(data?.agents) ? data.agents : [];
			const output = {
				endpoint: url,
				agents
			};
			if (response_format === "markdown") return {
				content: [{
					type: "text",
					text: formatAgentsMarkdown(url, agents)
				}],
				structuredContent: output
			};
			return jsonText(output);
		} catch (err) {
			return errorText(mapFlueError(err, { endpoint: url }), { endpoint: url });
		}
	});
	server.registerTool("flue_invoke_agent", {
		title: "Invoke Flue Agent",
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
			endpoint: z.string().optional().describe("Endpoint URL or registered endpoint name. Falls back to default."),
			agent: z.string().describe("Agent name (matches the file at .flue/agents/<name>.{ts,js,mts,mjs})."),
			sessionId: z.string().optional().describe("Session id; defaults to \"default\". Reuse to continue a conversation thread."),
			payload: z.unknown().optional().describe("JSON-serializable payload passed to the agent handler as ctx.payload."),
			mode: z.enum(["sync", "webhook"]).optional().describe("Invocation mode. \"sync\" returns the result body; \"webhook\" is fire-and-forget (HTTP 202). Default: sync."),
			response_format: ResponseFormat
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
	}, async ({ endpoint, agent, sessionId, payload, mode, response_format }) => {
		let url;
		try {
			url = await resolveEndpoint(endpoint);
		} catch (err) {
			return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? "" });
		}
		const sid = sessionId ?? "default";
		const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
		const m = mode ?? "sync";
		try {
			if (m === "webhook") {
				const ctl = new AbortController();
				const timer = setTimeout(() => ctl.abort(), 6e4);
				let res;
				try {
					res = await fetch(path, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-webhook": "true"
						},
						body: JSON.stringify(payload ?? {}),
						signal: ctl.signal
					});
				} finally {
					clearTimeout(timer);
				}
				if (!res.ok) {
					const text = await res.text().catch((readErr) => `${res.statusText} (response body unreadable: ${readErr instanceof Error ? readErr.message : String(readErr)})`);
					let body = text;
					try {
						body = JSON.parse(text);
					} catch {}
					throw new HttpError(res.status, res.statusText, body, path);
				}
				const output = {
					endpoint: url,
					agent,
					sessionId: sid,
					mode: "webhook",
					status: res.status
				};
				if (response_format === "markdown") return {
					content: [{
						type: "text",
						text: formatInvokeMarkdown(url, agent, sid, "webhook", output)
					}],
					structuredContent: output
				};
				return jsonText(output);
			}
			const data = await httpJson(path, {
				method: "POST",
				body: payload ?? {}
			});
			const unwrapped = data && typeof data === "object" && data !== null && "result" in data ? data.result : data;
			const output = {
				endpoint: url,
				agent,
				sessionId: sid,
				mode: "sync",
				result: unwrapped
			};
			if (response_format === "markdown") return {
				content: [{
					type: "text",
					text: formatInvokeMarkdown(url, agent, sid, "sync", unwrapped)
				}],
				structuredContent: output
			};
			return jsonText(output);
		} catch (err) {
			return errorText(mapFlueError(err, {
				endpoint: url,
				agent,
				sessionId: sid
			}), {
				endpoint: url,
				agent,
				sessionId: sid
			});
		}
	});
	server.registerTool("flue_stream_agent", {
		title: "Stream Flue Agent",
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
			endpoint: z.string().optional().describe("Endpoint URL or registered endpoint name. Falls back to default."),
			agent: z.string().describe("Agent name."),
			sessionId: z.string().optional().describe("Session id; defaults to \"default\"."),
			payload: z.unknown().optional().describe("JSON-serializable payload passed to the agent handler."),
			timeoutMs: z.number().int().positive().optional().describe("Wall-clock timeout in milliseconds. Default: 300000 (5 minutes)."),
			response_format: ResponseFormat
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
			})),
			truncated: z.boolean().optional()
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		}
	}, async ({ endpoint, agent, sessionId, payload, timeoutMs, response_format }) => {
		let url;
		try {
			url = await resolveEndpoint(endpoint);
		} catch (err) {
			return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? "" });
		}
		const sid = sessionId ?? "default";
		const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
		const ms = timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ms);
		const events = [];
		let textBuffer = "";
		let resultPayload = void 0;
		let streamErrorEnvelope = null;
		let totalEventsSeen = 0;
		let cappedEarly = false;
		try {
			const stream = await postSse(path, payload ?? {}, { signal: controller.signal });
			for await (const ev of parseSse(stream)) {
				totalEventsSeen++;
				let parsed = ev.data;
				try {
					parsed = JSON.parse(ev.data);
				} catch {}
				if (events.length < MAX_EVENTS) events.push({
					event: ev.event,
					data: parsed
				});
				else if (!cappedEarly) {
					events.push({
						event: "__truncated__",
						data: {
							reason: `event log capped at ${MAX_EVENTS} entries`,
							droppedFromHere: true
						}
					});
					cappedEarly = true;
				}
				if (ev.event === "text_delta") {
					if (parsed && typeof parsed === "object" && "text" in parsed) textBuffer += String(parsed.text ?? "");
					else if (typeof ev.data === "string") textBuffer += ev.data;
				}
				if (ev.event === "result") resultPayload = parsed && typeof parsed === "object" && parsed !== null && "data" in parsed ? parsed.data : parsed;
				if (ev.event === "error") {
					if (parsed && typeof parsed === "object") streamErrorEnvelope = parsed;
				}
			}
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") return errorText(`Stream timed out after ${ms}ms talking to agent "${agent}" (session "${sid}") at ${url}. Increase timeoutMs or check why the agent stalled (try flue_invoke_agent in sync mode for a fresh attempt).`, {
				endpoint: url,
				agent,
				sessionId: sid,
				timedOutAt: ms,
				partialEvents: events.length
			});
			return errorText(mapFlueError(err, {
				endpoint: url,
				agent,
				sessionId: sid
			}), {
				endpoint: url,
				agent,
				sessionId: sid,
				partialEvents: events.length
			});
		} finally {
			clearTimeout(timer);
		}
		if (streamErrorEnvelope) {
			const type = String(streamErrorEnvelope.type ?? "unknown");
			const message = String(streamErrorEnvelope.message ?? "Agent error during stream");
			return errorText(`Flue stream error [${type}]: ${message} (agent "${agent}", session "${sid}", endpoint ${url})`, {
				endpoint: url,
				agent,
				sessionId: sid,
				errorType: type,
				errorMessage: message,
				partialText: textBuffer,
				partialResult: resultPayload,
				eventsSeen: totalEventsSeen
			});
		}
		let finalEvents = events;
		let truncated = false;
		let truncationNote;
		let envelope = JSON.stringify({
			endpoint: url,
			agent,
			sessionId: sid,
			text: textBuffer,
			result: resultPayload,
			events
		}, null, 2);
		while (envelope.length > CHARACTER_LIMIT && finalEvents.length > 1) {
			finalEvents = finalEvents.slice(0, Math.max(1, Math.floor(finalEvents.length / 2)));
			truncated = true;
			envelope = JSON.stringify({
				endpoint: url,
				agent,
				sessionId: sid,
				text: textBuffer,
				result: resultPayload,
				events: finalEvents
			}, null, 2);
		}
		if (truncated) truncationNote = `Event log truncated from ${events.length} to ${finalEvents.length} events to fit ${CHARACTER_LIMIT} char limit. Text and result are complete; use sync mode for less verbose responses.`;
		else if (cappedEarly) truncationNote = `Event log capped at MAX_EVENTS=${MAX_EVENTS} during streaming (saw ${totalEventsSeen} events total). Text and result are complete.`;
		const output = {
			endpoint: url,
			agent,
			sessionId: sid,
			text: textBuffer,
			result: resultPayload,
			events: finalEvents,
			truncated: truncated || cappedEarly
		};
		if (response_format === "markdown") return {
			content: [{
				type: "text",
				text: formatStreamMarkdown(url, agent, sid, textBuffer, resultPayload, events.length, truncated, truncationNote)
			}],
			structuredContent: output
		};
		return jsonText(output);
	});
	server.registerTool("flue_add_endpoint", {
		title: "Add Flue Endpoint",
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
			name: z.string().min(1, "name cannot be empty").describe("Short name for the endpoint, e.g. \"local\" or \"prod-cf\"."),
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
		let parsedUrl;
		try {
			parsedUrl = new URL(url);
		} catch {
			return errorText(`Invalid URL: "${url}". Expected http(s)://host[:port][/path].`, {
				name,
				url,
				ok: false
			});
		}
		if (!/^https?:$/.test(parsedUrl.protocol)) return errorText(`Unsupported URL protocol "${parsedUrl.protocol}". Expected http: or https:.`, {
			name,
			url,
			ok: false
		});
		return jsonText({
			ok: true,
			registry: await addEndpoint(name, url, makeDefault)
		});
	});
	server.registerTool("flue_list_endpoints", {
		title: "List Flue Endpoints",
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
		inputSchema: { response_format: ResponseFormat },
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
	}, async ({ response_format }) => {
		const state = await listEndpoints();
		const output = {
			endpoints: state.endpoints,
			...state.defaultName !== void 0 ? { defaultName: state.defaultName } : {}
		};
		if (response_format === "markdown") return {
			content: [{
				type: "text",
				text: formatEndpointsMarkdown(state)
			}],
			structuredContent: output
		};
		return jsonText(output);
	});
	server.registerTool("flue_remove_endpoint", {
		title: "Remove Flue Endpoint",
		description: `Remove a registered Flue endpoint by name.

If the removed endpoint was the default, the default switches to the first remaining endpoint (or undefined if none remain). Removing a non-existent name is a no-op — the registry is returned unchanged.

Args:
  - name (string, required): Name of the endpoint to remove.

Returns:
  { "ok": true, "registry": { "endpoints": [...], "defaultName"?: string } }

Examples:
  - "Forget the staging endpoint" → name="staging"`,
		inputSchema: { name: z.string().min(1, "name cannot be empty").describe("Name of the endpoint to remove.") },
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
		return jsonText({
			ok: true,
			registry: await removeEndpoint(name)
		});
	});
}

//#endregion
//#region src/server.ts
const SERVER_NAME = "flue-loom-mcp-server";
const SERVER_VERSION = "0.1.0";
const server = new McpServer({
	name: SERVER_NAME,
	version: SERVER_VERSION
});
registerTools(server);
await server.connect(new StdioServerTransport());
const registryHome = process.env.FLUE_LOOM_HOME ?? join(homedir(), ".config", "flue-loom");
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready · registry: ${join(registryHome, "endpoints.json")}`);

//#endregion
export {  };