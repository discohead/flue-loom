---
name: flue-client
description: Use when calling a Flue 2 agent over HTTP from outside its process — local vite dev or a deployment — the conversation wire protocol (POST 202 admission, GET history and updates, bounded history pages, abort), the @flue/sdk createFlueClient API (send/read/wait/observe/history/historyBefore/abort), image and PDF attachments, @flue/react useFlueAgent, error envelopes, and flue-loom's flue-talk script and flue MCP tools.
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
node $T <url> --history [--all] [--limit 20] [--json] # transcript: timestamps, tool calls, data parts, settlements
node $T <url> --abort
node $T <url> -m "…" --json --token-env PROD_FLUE_TOKEN -H 'x-tenant: acme'
```

Tool calls and data parts stream to stderr; stdout carries only the reply (or one `--json` envelope). The plugin's MCP server (`flue`) exposes the same operations as typed tools for Claude Code, Claude Desktop, Cursor, and other MCP hosts: `flue_list_agents` (registered agents + the local project's app.ts mounts), `flue_send_message` (send and wait, with progress), `flue_read_reply`, `flue_get_conversation` (pages back from the newest message only as far as `last` needs), `flue_abort`, and `flue_add_agent`/`flue_remove_agent` for a shared registry of deployed mounts whose credentials come from `FLUE_*` environment variables.

## Wire protocol (both targets)

```bash
curl -X POST http://localhost:5173/agents/support/t1 -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Hello"}'                    # → 202 {"streamUrl","offset","submissionId","uid"}
curl http://localhost:5173/agents/support/t1               # snapshot (messages, settlements)
curl 'http://localhost:5173/agents/support/t1?limit=50'    # newest 50 messages + every settlement + `before` cursor
curl 'http://localhost:5173/agents/support/t1?before=<cursor>&limit=50'   # older page: { v, conversationId, messages, before }
curl 'http://localhost:5173/agents/support/t1?view=updates&offset=<offset>&live=long-poll'
curl -X POST http://localhost:5173/agents/support/t1/abort
```

- Body = a `DeliveredMessage` object (`{kind:'user', body}` or `{kind:'signal', type, body, attributes?}`) with optional top-level `initialData` and `uid` (string → continue only that incarnation; `null` → create only). A bare string body is rejected.
- Updates are JSON arrays of chunks (`conversation-reset`, `message-appended`, `message-started`, `message-delta`, `tool-input`, `tool-output`, `tool-output-error`, `data-part`, `message-completed`, `submission-settled`), each with a `position` for dedupe. Resume from the `Stream-Next-Offset` header; offsets are opaque. Long-poll holds ≤ 30 s; `live=sse` streams `data`/`control` events.
- A submission's reply is its final assistant message; if it joined a busy response, the settlement's `answeredBySubmissionId` points at the message that answered it.
- **Bounded reads** (Flue ≥ 2.2): `limit` counts every message, hidden ones included, and the window can hold more (it reaches back to any response still streaming). `before` is the cursor for the next older page, `null` at the start of the conversation; unbounded reads omit it, and older runtimes ignore the parameters and return everything. `?from=<cursor>` reads from a message through the head. A cursor from before a stream reset fails with `history_cursor_not_found` (410): drop pages read with it and re-read the newest window.
- Errors are `{ "error": { "type", "message", "details", "dev"?, "meta"? } }` — branch on `type`: `invalid_request`/`invalid_json` (400), `stream_not_found` (404: no message yet), `agent_instance_not_found` (404: uid mismatch), `agent_instance_exists` (409, `meta.uid`), `history_cursor_not_found` (410), `method_not_allowed` (405), `runtime_unavailable` (503, dev reload — retry), `internal_error` (500, quote `error.ref`). A 404 **without** an envelope means nothing is mounted at that path.

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
const snapshot = await conversation.history(); // the whole conversation
const recent = await conversation.history({ limit: 50 }); // newest 50 + every settlement + `before` (Flue ≥ 2.2)
const older = recent.before ? await conversation.historyBefore(recent.before, { limit: 50 }) : null; // { messages, before }
const observation = conversation.observe({ live: 'sse' }); // useSyncExternalStore-shaped live state; `limit` bounds it too
await conversation.abort(); // aborts ALL in-flight + queued work for the conversation
```

- `send()` resolves at admission; `read()`/`wait()` follow the stream; `read(submissionId)` re-attaches from any process later.
- `read()` is `wait()` + a whole-conversation `history()` + `readSubmissionReply()`. On long conversations compose them: `wait()`, then `readSubmissionReply(await conversation.history({ limit: 50 }), id)`. It needs a snapshot or observed state (settlements included — not a `historyBefore()` page), and a bounded window only finds replies inside it.
- `FlueApiError` (`status`, `body`, `ref`) = the request was rejected; `FlueExecutionError` (`failure: 'failed' | 'aborted' | 'terminal_event_missing'`, `error`) = admitted but didn't complete. Your own `AbortSignal` rejects with `AbortError`, which only cancels the local wait.
- `observe()` never throws: watch `getSnapshot().phase` (`loading`, `connecting`, `live`, `absent` = 404, `error` = 400/401/403, `closed`).
- Messages carry `role`, `purpose` (`user` | `assistant` | `dispatch` | `advisory`), `display` (`visible` | `hidden` | `diagnostic`), and `parts` (`text`, `reasoning`, `dynamic-tool`, `file`, `data-<name>`). Messages and settlements carry a server `timestamp` (ISO 8601, Flue ≥ 2.2) — not unique or monotonic, so order by array position.
- User messages can carry `attachments`: images and PDF documents, base64 (shapes in `flue-agents`). Durable `file` parts come back with a ready `url` (`conversation.attachmentUrl()`).

## React

```tsx
import { useFlueAgent } from '@flue/react';
const agent = useFlueAgent({ url: `/api/agents/support/${conversationId}` }); // or { client } (memoize it)
// agent.messages, agent.status, agent.historyReady, agent.sendMessage(text, { images, documents }), agent.refresh()
```

Dormant during SSR and when `url` is omitted. The browser needs the agent mounted and, cross-origin, CORS with the stream headers exposed.

## Inside the Flue process

Don't use HTTP — `dispatch()` / `init(Agent, { id }).dispatch()` + `.read()` (`flue-workflows`).

Docs: `flue docs read sdk/overview`, `sdk/flue-client`, `sdk/errors`, `reference/streaming-protocol`, `guide/react`.
