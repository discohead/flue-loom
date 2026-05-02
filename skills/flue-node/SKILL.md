---
name: flue-node
description: Use when targeting Node for deployment, understanding the Hono server entry, debugging local invocation, or configuring the in-memory session store.
---

# Node deployment

Targeting Node produces a self-contained `dist/server.mjs` — a Hono HTTP server that imports all agents/roles, exposes them via `/agents/:name/:id`, and holds session state in memory.

## Build behavior

`packages/sdk/src/build-plugin-node.ts` declares `bundle: 'esbuild'`. Flue runs esbuild after generating the entry, externalizing your project's direct dependencies (resolved from `node_modules` at runtime) and bundling Flue infrastructure inline.

Output: `dist/server.mjs`. Run with `node dist/server.mjs`. Default port `3583` (override via `PORT` env var).

## Routes (Hono)

```
GET  /health                    → { status: 'ok' }
GET  /agents                    → manifest JSON
ALL  /agents/:name/:id          → invoke agent
```

The invoke route supports three modes by header:

| Header | Mode | Response |
|---|---|---|
| `x-webhook: true` | webhook | 202 Accepted, fire-and-forget |
| `Accept: text/event-stream` | SSE | streamed events |
| (none) | sync | JSON `{ result: ... }` |

## SSE event shape

```
event: start
data: {"agent":"hello","id":"thread-1"}

event: text
data: {"text":"Hello..."}

event: tool_use
data: {"name":"read","input":{...}}

event: idle
data: {}

event: result
data: {"result":...}
```

The CLI's SSE consumer (`packages/cli/bin/flue.ts:418`) is the canonical parser. The plugin's `scripts/sse-invoke.sh` is a simplified bash equivalent for tooling.

## FLUE_MODE gate

```typescript
const isLocalMode = process.env.FLUE_MODE === 'local';
```

`flue dev` and `flue run` set `FLUE_MODE=local`. In local mode, trigger-less agents are invokable. In production (no FLUE_MODE), trigger-less agents return 403/404 — they have no route. See `flue-triggers` for details.

## Session store

Default: `InMemorySessionStore` from `packages/sdk/src/session.ts`. Lives in process memory. Process restart = clean slate. Acceptable for dev and stateless agents; not for production multi-instance setups.

For durable state on Node, override:

```typescript
import { init } from '@flue/sdk/client';

const agent = await init({
  persist: myCustomStore,  // implement SessionStore
});
```

A custom `SessionStore` implements `get(agentId, sessionId)`, `set(agentId, sessionId, data)`, `delete(agentId, sessionId)`, etc. Could be Redis, SQLite, Postgres — your call.

## Node version

Requires Node 22+. The build target sets the runtime environment to Node 22. Older versions miss APIs Flue uses (e.g., `node:util.parseEnv`).

## Local sandbox

`init({ sandbox: 'local' })` mounts `process.cwd()` at `/workspace` inside the agent. The agent sees your dev repo. Useful for an agent that operates on the project running it.

`'local'` is Node-only — throws on Cloudflare.

## Custom port

```bash
PORT=4000 node dist/server.mjs
flue dev --port 4000
```

## Deploy patterns

Node deploy is unopinionated — Flue produces a self-contained `server.mjs`. Run it however you run Node services:

- `pm2 start dist/server.mjs`
- `systemd` unit
- Docker (`CMD ["node", "/app/dist/server.mjs"]`)
- `fly.io`, Render, Railway, etc.

Provide `ANTHROPIC_API_KEY` in env. Provide `FLUE_MODE=local` only if you genuinely want trigger-less agents reachable in prod (almost never).

## Common pitfalls

- Missing `ANTHROPIC_API_KEY` → model resolution throws on first call.
- Using port 3583 elsewhere → port collision; pass `--port`.
- Setting `FLUE_MODE=local` in production by accident → exposes intended-internal agents.
- Restarting process = sessions lost (in-memory store).

## Related

- `flue-cloudflare` — the alternative target
- `flue-triggers` — FLUE_MODE gating
- `flue-lifecycle` — `flue dev` watch loop
- `flue-debugging` — Node-specific recipes
