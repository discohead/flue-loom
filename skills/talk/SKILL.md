---
name: talk
description: Hold a multi-turn conversation with a running Flue 2 agent — local `vite dev` or a deployment — over its conversation URL, with streamed tool activity, signals, history, and abort.
argument-hint: "<conversation-url | AgentName> [message]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-talk.mjs *)
  - Bash(node *flue-inspect.mjs *)
---

# /flue-loom:talk

Arguments: `$ARGUMENTS`

Driver: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-talk.mjs` (zero-dependency; `--help` for every flag). Protocol background: the `flue-client` skill.

## 1. Resolve the conversation URL

A conversation URL is the agent's `app.ts` mount + a conversation id: `http://localhost:5173/agents/support/ticket-42`.

- A full URL → use it.
- An agent identity or mount name → look up its mount with `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs --json --no-lint` (`agents[].mount`). Base URL: the dev server this conversation started (`/flue-loom:dev`), else `http://localhost:5173`. No mount → the agent isn't reachable over HTTP; use `/flue-loom:run` or add a mount.
- Conversation id: reuse the one from earlier in this conversation for the same agent (so it keeps context); otherwise pick a fresh readable one (`talk-<short-timestamp>`). Say which id you're using.

## 2. Send and wait

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-talk.mjs <url> -m "<message>"
```

Stdout is the agent's reply; stderr shows tool calls and data parts as they happen. Show the reply faithfully (quote it; don't paraphrase), and mention notable tool activity. Then wait for the user's next message and send it to the **same URL** — each message is a new submission in the same durable conversation.

Useful flags: `--json` (one envelope with `submissionId`, `outcome`, `text`, `data`, error), `--signal <type> --attr k=v` (deliver an event as `kind:"signal"` instead of a user turn), `--data '<json>' --new` (creation data for a new conversation), `--history [--all]`, `--abort`, `--no-wait` then `--read <submissionId>` for long jobs, `--timeout <s>`.

## 3. Auth for deployed agents

Protected routes take a bearer token: put it in an environment variable and pass `--token-env <VAR>` (default `$FLUE_TOKEN`), or `-H 'name: value'` for custom headers. Never echo tokens into the conversation.

## 4. When it fails

| Output | Meaning → action |
|---|---|
| `404` with no error envelope | Nothing mounted at that path → check `app.ts` mounts (`flue-inspect`) and the base URL/port. |
| `stream_not_found` / `agent_instance_not_found` | No such conversation, or a `--uid` mismatch → new id, or drop `--uid`. |
| `agent_instance_exists` (409) | `--new` on an existing id → drop `--new` or pick another id. |
| `invalid_request` (400) | Body rejected — often `initialData` failing the agent's schema; read `error.details`. |
| `runtime_unavailable` (503) | Dev server reloading → retry in a moment. |
| `failed` outcome with an error type | Runtime failure (model key, tool error, timeout) → `/flue-loom:debug`. |
| Connection refused | Server not running → `/flue-loom:dev`. |
| Timeout (exit 124) | Still working → `--read <submissionId>` to re-attach, or `--abort`. |

MCP hosts (Claude Desktop, Cursor, …) get the same operations as typed tools from the plugin's MCP server (`flue_send_message`, `flue_read_reply`, `flue_get_conversation`, `flue_abort`).
