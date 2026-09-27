---
name: flue-client
description: Use when calling a Flue 2 agent over HTTP from outside its process — local vite dev or a deployment — the conversation wire protocol (POST 202 admission, GET history and updates, abort), the @flue/sdk createFlueClient API (send/read/wait/observe/history/abort), @flue/react useFlueAgent, error envelopes, and flue-loom's flue-talk script and flue MCP tools.
user-invocable: false
---

# Talking to agents over HTTP

A **conversation URL** is the agent's mount in `app.ts` plus a caller-chosen id: `http://localhost:5173/agents/support/ticket-42` (`vite dev` defaults to port 5173; a built Node server to 3000). There is no deployment-wide client, no agent-name addressing, and no endpoint that lists agents — the URL is the whole contract.

## From Claude Code: `flue-talk` (zero-dependency)

```bash
T=${CLAUDE_PLUGIN_ROOT}/scripts/flue-talk.mjs
node $T http://localhost:5173/agents/support/t1 -m "Where is order 42?"   # send, wait, print reply (exit 0/1/130)
node $T <url> --signal schedule --attr at=2026-09-27 "Run the daily summary"
node $T <url> --data '{"plan":"pro"}' --new -m "Hi"   # creation data, create-only
node $T <url> --no-wait -m "long job"                 # 202 admission JSON; re-attach later with --read <submissionId>
node $T <url> --history [--all] [--json]              # transcript: tool calls, data parts, settlements
node $T <url> --abort
node $T <url> -m "…" --json --token-env PROD_FLUE_TOKEN -H 'x-tenant: acme'
```

Tool calls and data parts stream to stderr; stdout carries only the reply (or one `--json` envelope). The plugin's MCP server (`flue`) exposes the same operations as typed tools for Claude Code, Claude Desktop, Cursor, and other MCP hosts: `flue_list_agents` (registered agents + the local project's app.ts mounts), `flue_send_message` (send and wait, with progress), `flue_read_reply`, `flue_get_conversation`, `flue_abort`, and `flue_add_agent`/`flue_remove_agent` for a shared registry of deployed mounts whose credentials come from `FLUE_*` environment variables.

## Wire protocol (both targets)

```bash
curl -X POST http://localhost:5173/agents/support/t1 -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Hello"}'                    # → 202 {"streamUrl","offset","submissionId","uid"}
curl http://localhost:5173/agents/support/t1               # snapshot (messages, settlements)
curl 'http://localhost:5173/agents/support/t1?view=updates&offset=<offset>&live=long-poll'
curl -X POST http://localhost:5173/agents/support/t1/abort
```

- Body = a `DeliveredMessage` object (`{kind:'user', body}` or `{kind:'signal', type, body, attributes?}`) with optional top-level `initialData` and `uid` (string → continue only that incarnation; `null` → create only). A bare string body is rejected.
- Updates are JSON arrays of chunks (`conversation-reset`, `message-appended`, `message-started`, `message-delta`, `tool-input`, `tool-output`, `tool-output-error`, `data-part`, `message-completed`, `submission-settled`), each with a `position` for dedupe. Resume from the `Stream-Next-Offset` header; offsets are opaque. Long-poll holds ≤ 30 s; `live=sse` streams `data`/`control` events.
- A submission's reply is its final assistant message; if it joined a busy response, the settlement's `answeredBySubmissionId` points at the message that answered it.
- Errors are `{ "error": { "type", "message", "details", "dev"?, "meta"? } }` — branch on `type`: `invalid_request`/`invalid_json` (400), `stream_not_found` (404: no message yet), `agent_instance_not_found` (404: uid mismatch), `agent_instance_exists` (409, `meta.uid`), `method_not_allowed` (405), `runtime_unavailable` (503, dev reload — retry), `internal_error` (500, quote `error.ref`). A 404 **without** an envelope means nothing is mounted at that path.

## `@flue/sdk`

```ts
import { createFlueClient, FlueApiError, FlueExecutionError, readSubmissionReply } from '@flue/sdk';

const conversation = createFlueClient({
	url: 'https://example.com/agents/support/ticket-42', // absolute outside browsers
	token: process.env.FLUE_TOKEN, // or headers: () => ({ authorization: … }) — re-evaluated per request
	// fetch: (input, init) => env.AGENT_APP.fetch(new Request(input, init)), // Cloudflare service binding
});

const admission = await conversation.send({ message: { kind: 'user', body: 'Summarize my case.' } /*, initialData, uid, signal */ });
const reply = await conversation.read(admission, { onEvent: (chunk) => {} }); // { text, data, metadata?, submissionId, uid? }
await conversation.wait(admission); // outcome only
const snapshot = await conversation.history();
const observation = conversation.observe({ live: 'sse' }); // useSyncExternalStore-shaped live state
await conversation.abort(); // aborts ALL in-flight + queued work for the conversation
```

- `send()` resolves at admission; `read()`/`wait()` follow the stream; `read(submissionId)` re-attaches from any process later.
- `FlueApiError` (`status`, `body`, `ref`) = the request was rejected; `FlueExecutionError` (`failure: 'failed' | 'aborted' | 'terminal_event_missing'`, `error`) = admitted but didn't complete. Your own `AbortSignal` rejects with `AbortError`, which only cancels the local wait.
- `observe()` never throws: watch `getSnapshot().phase` (`loading`, `connecting`, `live`, `absent` = 404, `error` = 400/401/403, `closed`).
- Messages carry `role`, `purpose` (`user` | `assistant` | `dispatch` | `advisory`), `display` (`visible` | `hidden` | `diagnostic`), and `parts` (`text`, `reasoning`, `dynamic-tool`, `file`, `data-<name>`).

## React

```tsx
import { useFlueAgent } from '@flue/react';
const agent = useFlueAgent({ url: `/api/agents/support/${conversationId}` }); // or { client } (memoize it)
// agent.messages, agent.status, agent.historyReady, agent.sendMessage(text), agent.refresh()
```

Dormant during SSR and when `url` is omitted. The browser needs the agent mounted and, cross-origin, CORS with the stream headers exposed.

## Inside the Flue process

Don't use HTTP — `dispatch()` / `init(Agent, { id }).dispatch()` + `.read()` (`flue-workflows`).

Docs: `flue docs read sdk/overview`, `sdk/flue-client`, `sdk/errors`, `reference/streaming-protocol`, `guide/react`.
