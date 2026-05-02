#!/usr/bin/env node
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
			return `Flue error [${String(inner.code ?? "unknown")}]: ${String(inner.message ?? "no message")} (HTTP ${error.status} from ${where})`;
		}
		switch (error.status) {
			case 404: return context.agent ? `Agent "${context.agent}" not found at ${context.endpoint}. Try flue_list_agents to see available agents.` : `Endpoint not found: ${context.endpoint}. Verify the URL is correct and the server is running.`;
			case 401:
			case 403: return `Endpoint rejected the call (HTTP ${error.status}) for ${where}. Common cause: trigger-less agent in production mode. The endpoint must run with FLUE_MODE=local (\`flue dev\` and \`flue run\` set this automatically) or the agent must export \`triggers = { webhook: true }\`.`;
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
async function postSse(url, body, options = {}) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...options.headers
		},
		body: JSON.stringify(body ?? {}),
		signal: options.signal
	});
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
*
* Goes through the mutation chain so it serializes against concurrent
* add/remove writes — otherwise a list_agents call interleaved with an
* in-flight add_endpoint can read the pre-write registry and miss the
* just-added entry.
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
		}
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
			return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? null });
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
  - 404 → agent not found; try flue_list_agents to see available names
  - 403 → trigger-less agent in production mode; the endpoint must be running with FLUE_MODE=local (\`flue dev\` and \`flue run\` set this automatically)
  - Network timeout (60s) → consider flue_stream_agent for long-running agents`,
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
			return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? null });
		}
		const sid = sessionId ?? "default";
		const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
		const m = mode ?? "sync";
		try {
			if (m === "webhook") {
				const res = await fetch(path, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-webhook": "true"
					},
					body: JSON.stringify(payload ?? {})
				});
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
			const output = {
				endpoint: url,
				agent,
				sessionId: sid,
				mode: "sync",
				result: data
			};
			if (response_format === "markdown") return {
				content: [{
					type: "text",
					text: formatInvokeMarkdown(url, agent, sid, "sync", data)
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
    "text": string,                  // Concatenated 'text' event payloads
    "result": <unknown>,              // Final 'result' event payload
    "events": [                       // Full event log for replay/inspection
      { "event": string, "data": <unknown> }
    ],
    "truncated"?: boolean            // True if events were dropped to fit
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
  - "Watch tool calls during a turn" → look at events[] for event === 'tool_use'
  - Long-running agents that exceed the 60s sync timeout

Errors:
  - HTTP failures map to actionable Flue messages (404 → flue_list_agents hint, 403 → FLUE_MODE hint, etc.)
  - Stalled stream → aborted at timeoutMs with a clear message`,
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
			return errorText(err instanceof Error ? err.message : String(err), { endpoint: endpoint ?? null });
		}
		const sid = sessionId ?? "default";
		const path = `${url}/agents/${encodeURIComponent(agent)}/${encodeURIComponent(sid)}`;
		const ms = timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ms);
		const events = [];
		let textBuffer = "";
		let resultPayload = void 0;
		try {
			const stream = await postSse(path, payload ?? {}, { signal: controller.signal });
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
		const output = {
			endpoint: url,
			agent,
			sessionId: sid,
			text: textBuffer,
			result: resultPayload,
			events: finalEvents,
			...truncated ? { truncated: true } : {}
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
    "endpoints": [{ "name": string, "url": string }],
    "defaultName"?: string
  }

Examples:
  - "Which endpoints are configured?"
  - "What URL is 'prod-cf' pointing to?" → look at endpoints[] for the matching name`,
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
const transport = new StdioServerTransport();
await server.connect(transport);
const registryHome = process.env.FLUE_LOOM_HOME ?? `${homedir()}/.config/flue-loom`;
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready · registry: ${registryHome}/endpoints.json`);

//#endregion
export {  };