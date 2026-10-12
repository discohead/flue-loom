# @flue-loom/mcp

An MCP server for talking to [Flue](https://flueframework.com) 2 agents — locally under `vite dev` or deployed — from any MCP host: Claude Code, Claude Desktop, Cursor, ChatGPT desktop, and others.

It's the operator side of the [flue-loom](../README.md) Claude Code plugin (the plugin registers it automatically as the `flue` server). The authoring side — skills, subagents, commands, lint — lives in the plugin.

## How Flue 2 agents are addressed

An agent has no global name on the wire: it's reached at the **mount** its app gives it in `app.ts` (`app.route('/agents/support', createAgentRouter(Support))`), and a **conversation** is that mount plus an id you choose: `https://api.example.com/agents/support/ticket-42`. Conversations are durable — reuse the id to continue with full context.

Every tool takes one of:

- `agent` — a name registered with `flue_add_agent`, or a mount discovered in the local project (`flue_list_agents`);
- `url` — a mount URL (`https://…/agents/support`, or `/agents/support` relative to the local dev server);
- `conversation_url` — mount + id in one string;

plus `conversation_id` where a conversation is needed (`flue_send_message` generates one when omitted and returns it).

## Tools

| Tool | What it does |
|---|---|
| `flue_list_agents` | Registered agents (with credential status) + the local project's `app.ts` mounts |
| `flue_send_message` | Deliver a user message or a signal (`signal_type`, `attributes`), with optional `initial_data`, `create_only`/`uid`, `idempotency_key`; waits for the reply (default 300 s) with progress notifications for tool calls and reply text; returns text, data parts, metadata, tool activity, ids — or `pending` if the agent is still working |
| `flue_read_reply` | Re-attach to a submission (`pending` results, `wait: false` sends) and return its reply |
| `flue_get_conversation` | Transcript: messages, signals, tool calls with inputs/outputs, data parts, submission outcomes |
| `flue_abort` | Abort running and queued work in a conversation |
| `flue_add_agent` / `flue_remove_agent` | Manage the shared agent registry |

Errors say what to do next: unreachable server (start `vite dev`), plain 404 (nothing mounted there), 401/403 (register credentials), invalid `initial_data` (the agent's schema rejected it), `agent_instance_exists`, `submission_conflict`, failed or aborted submissions with the agent's error type. Error results carry text only (no `structuredContent`), which keeps strict clients happy.

## Registry and credentials

Registered agents live in `$FLUE_LOOM_HOME/agents.json` (default `~/.config/flue-loom/agents.json`), shared by every host on the machine:

```json
{ "version": 1, "agents": [{ "name": "prod-support", "url": "https://api.example.com/agents/support", "token_env": "FLUE_PROD_TOKEN" }] }
```

Secrets are never stored or accepted as tool arguments. An entry names environment variables of the MCP server process instead — `token_env` (sent as `Authorization: Bearer …`) and `header_env` (header → variable, for API-key headers). **Only `FLUE_*` variables are honored**, so a tool call can never be steered into sending unrelated secrets to a URL. A mount discovered locally picks up the credentials of a registered agent at the same URL.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FLUE_LOOM_PROJECT_DIR` | server's working directory | Flue project whose `app.ts` mounts are discoverable by name (the plugin sets it to the Claude Code project) |
| `FLUE_LOOM_BASE_URL` | `http://localhost:5173` | Where that project is served; also the base for relative `url`s |
| `FLUE_LOOM_HOME` | `~/.config/flue-loom` | Registry directory |
| `FLUE_*` | — | Credential variables referenced by registry entries |

## Install

**Claude Code** — install the flue-loom plugin (the server comes with it), or add just the server:

```bash
claude mcp add flue -e FLUE_PROD_TOKEN=… -- npx -y @flue-loom/mcp
```

**Claude Desktop** — open `flue-loom-<version>.mcpb` (built with `pnpm pack:mcpb`); it asks for the registry directory, an optional local project, the dev server URL, and an optional token (stored in the OS keychain, exposed as `FLUE_TOKEN`). Or configure it by hand:

```json
{
	"mcpServers": {
		"flue": {
			"command": "npx",
			"args": ["-y", "@flue-loom/mcp"],
			"env": { "FLUE_PROD_TOKEN": "…" }
		}
	}
}
```

**Cursor, ChatGPT desktop, others** — the same `command`/`args`/`env` in the host's MCP settings. The server speaks stdio and answers both the 2025-era `initialize` handshake and the 2026-07-28 `server/discover` opening.

Until `@flue-loom/mcp` is published to npm, run it from a checkout instead of `npx`: `"command": "node", "args": ["/path/to/flue-loom/mcp/dist/server.mjs"]`.

## Develop

```bash
pnpm install
pnpm build            # tsdown → dist/server.mjs (self-contained) + dist/THIRD_PARTY_LICENSES.md
pnpm check:types
(cd eval/fixture && npm install)
pnpm test             # drives dist/server.mjs with v2 and v1 MCP clients against the fixture app
pnpm pack:mcpb        # flue-loom-<version>.mcpb
```

`dist/` is committed: the plugin runs `dist/server.mjs` straight from its install directory, where there's no `node_modules`. Every dependency is bundled (see `dist/THIRD_PARTY_LICENSES.md`); `@flue/sdk` supplies the protocol client.

`eval/` holds a deterministic Flue fixture app (faux models, no API keys) and ten evaluation questions — see [eval/README.md](eval/README.md).

## License

MIT
