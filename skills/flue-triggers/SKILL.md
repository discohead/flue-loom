---
name: flue-triggers
description: Use when defining the triggers export, understanding webhook vs cron triggers, debugging "agent not invokable" errors, or working with FLUE_MODE=local.
---

# Triggers: how Flue routes invocations

Each agent file declares its triggers via a top-level `export const triggers = {...}`. Triggers shape the HTTP routing in the generated server entry: webhook agents get HTTP routes; cron agents go in a manifest; trigger-less agents are CLI-only.

## The two recognized triggers

```typescript
export const triggers = {
  webhook: true,            // HTTP POST /agents/<name>/<id>
  cron: '0 9 * * *',         // manifest entry; deploy tool executes
};
```

Only `webhook: true` and `cron: '<expr>'` are parsed. Anything else is ignored.

## The regex (build-time, not a full TS parse)

From `packages/sdk/src/build.ts:283`:

```javascript
/export\s+const\s+triggers\s*=\s*\{([^}]*)\}/
```

This means **the literal source must look like** `export const triggers = { ... }`. Anti-patterns that break the regex:

```typescript
// ❌ all of these silently parse as no triggers
const t = { webhook: true };
export default t;

export const triggers = makeTriggers();

export const triggers = {
  ...defaults,        // spread breaks the regex (nested braces)
  webhook: true,
};
```

The plugin's PostToolUse hook (`scripts/post-edit-flue.mjs`) uses the **same regex** to lint your file when you save it.

## Webhook agents

`webhook: true` registers an HTTP route. On Node:
- `POST /agents/<name>/<id>` — invoke
- Modes via headers:
  - `x-webhook: true` → fire-and-forget, returns 202
  - `Accept: text/event-stream` → SSE stream
  - default → sync JSON response

On Cloudflare, each webhook agent becomes a Durable Object class. Same routing.

## Cron agents

`cron: '<expr>'` does NOT register an HTTP route. Cron lives in `dist/manifest.json` for the deploy platform to act on. On Cloudflare, `wrangler.jsonc` cron triggers are configured separately — Flue doesn't auto-wire them. The cron string is metadata; you still need to wire your Worker's `scheduled()` handler.

An agent can have both `webhook: true` and `cron: '...'` — useful for an endpoint that's both manually invokable and scheduled.

## Trigger-less agents (CLI-only)

```typescript
// no triggers export, or triggers = {}
export default async function ({ init }: FlueContext) { ... }
```

Trigger-less agents are valid but **gated by `FLUE_MODE=local`** at routing time. From `packages/sdk/src/build-plugin-node.ts:88-89`:

```typescript
const isLocalMode = process.env.FLUE_MODE === 'local';
// validation rejects non-webhook agents unless isLocalMode
```

`flue dev` and `flue run` both set `FLUE_MODE=local`. Production deployments don't — trigger-less agents simply aren't reachable in production. This makes them ideal for one-off CLI scripts or tests that you don't want exposed.

## Debugging "my agent isn't invokable"

1. Check `dist/manifest.json` after build — agent should be listed.
2. If the agent is missing the `triggers` block: the regex didn't match. Reshape to `export const triggers = { ... }` exactly.
3. If `triggers: {}` (empty): the `triggers` block parsed but no recognized keys. Add `webhook: true` or `cron: '...'`.
4. If 403/404 on POST: agent is trigger-less and you're not in local mode. Set `FLUE_MODE=local` (or use `flue dev` / `flue run`).

## Related

- `flue-lifecycle` — what `flue dev` / `flue run` do with FLUE_MODE
- `flue-node` / `flue-cloudflare` — routing semantics per target
- `flue-debugging` — trigger-related diagnostics
