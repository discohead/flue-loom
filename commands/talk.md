---
description: Have a turn-by-turn conversation with a running Flue agent
argument-hint: "<agent> [--id X] [--url URL] [--stream]"
allowed-tools: ["Bash", "Read"]
---

Talk to a running Flue agent (sync mode by default; SSE with `--stream`).

Arguments: $ARGUMENTS

## Steps

1. Parse `<agent>`, `--id` (default `talk-$(date +%s)`), `--url` (default `http://localhost:3583`), `--stream` flag.
2. Verify the agent is reachable:
   ```bash
   curl -sf "$url/health" >/dev/null && curl -s "$url/agents" | jq -r '.agents[].name' | grep -qx "$agent"
   ```
   If not reachable, suggest `/flue:dev` first.
3. Prompt the user for the message (or take from a follow-up).
4. **Sync mode** (default):
   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d "$(jq -n --arg q "$message" '{prompt: $q}')" \
     "$url/agents/$agent/$id" | jq .
   ```
5. **SSE mode** (with `--stream`):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/sse-invoke.sh" \
     "$url/agents/$agent/$id" "$(jq -n --arg q "$message" '{prompt: $q}')"
   ```
   The script streams `text` events to stdout and prints the final `result` JSON at the end.
6. Loop: ask the user for the next message, reuse the same `$id` so the session continues.

## Multi-endpoint support

The `--url` argument lets you talk to:
- Local dev: `http://localhost:3583` (default)
- Deployed Cloudflare worker: `https://my-agents.example.workers.dev`
- Remote dev server: any reachable URL

If the user has the MCP server registered (Claude Desktop, etc.), they can use the `flue-loom` MCP server's `add_endpoint` tool to register URLs by name. Slash commands here use raw URLs; the MCP server uses named endpoints.

## Payload customization

The default payload is `{ "prompt": "<message>" }`. If the agent expects a different shape (read its `FlueContext<TPayload>` type or its handler code to verify), the user can pass a custom payload via a follow-up message saying "use payload {...}".

## Pitfalls

- Agent name typo → `/agents` lookup fails. Suggest checking with `/flue:explore`.
- Agent expects custom payload → first call may error with structured error envelope. Adjust.
- Trigger-less agent in production → 403/404 (FLUE_MODE not local). Hit a dev server or use a webhook trigger.
- SSE buffering → if events seem stuck, check the dev server logs via Monitor on the dev shell id.
