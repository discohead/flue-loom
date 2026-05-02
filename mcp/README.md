# @flue-loom/mcp

MCP server that talks to Flue HTTP endpoints (local `flue dev` or deployed Cloudflare Workers). Use it from any MCP host: Claude Code, Claude Desktop, ChatGPT desktop, Cursor.

This is the **operator face** of `flue-loom`. The authoring face (skills, subagents, slash commands) lives in the parent plugin and only works inside Claude Code.

## What it provides

| Tool | Purpose |
|---|---|
| `flue_list_agents` | `GET /agents` — manifest of agents at an endpoint |
| `flue_invoke_agent` | `POST /agents/:name/:id` — sync or webhook |
| `flue_stream_agent` | SSE stream of an invocation; returns accumulated text + result |
| `flue_add_endpoint` | Register a named endpoint (persisted) |
| `flue_list_endpoints` | List registered endpoints + default |
| `flue_remove_endpoint` | Remove a registered endpoint |

All tool names use the `flue_` service prefix to avoid collisions when this MCP server is loaded alongside others in the same host.

Endpoints are persisted at `$FLUE_LOOM_HOME/endpoints.json` (default `~/.config/flue-loom/endpoints.json`).

## Install — Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or your platform's equivalent:

```json
{
  "mcpServers": {
    "flue-loom-mcp-server": {
      "command": "npx",
      "args": ["-y", "@flue-loom/mcp"]
    }
  }
}
```

(Or, if installed from source: `"command": "node", "args": ["/path/to/flue-loom/mcp/dist/server.mjs"]`.)

## Install — ChatGPT desktop

Add via the GUI's MCP integration panel; point it to the same npx command. Some builds support both stdio and SSE transports — this server is stdio.

## Install — Cursor / Zed

Both support MCP via similar config entries; consult their docs for the exact JSON shape, but the `command` + `args` pair is identical.

## Build from source

```bash
cd mcp
pnpm install
pnpm build
# produces dist/server.js
```

## Resolving endpoints

Endpoints can be referenced three ways:

1. **Explicit URL**: `endpoint: "http://localhost:3583"`
2. **Registered name**: `endpoint: "prod-cf"` (after `flue_add_endpoint`)
3. **Default**: omit `endpoint` — uses the default name from registry, falling back to `http://localhost:3583`

## Talking to a deployed Cloudflare Worker

```
flue_add_endpoint name=prod-cf url=https://my-agents.example.workers.dev default=true
flue_list_agents
flue_invoke_agent agent=hello sessionId=user-1 payload={"q":"hi"}
```

Same tools, same UX. The MCP server is endpoint-agnostic.

## License

MIT
