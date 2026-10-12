---
name: flue-cloudflare
description: Use when targeting Cloudflare Workers with Flue 2 — flue() + cloudflare({ config: flueWorkerConfig() }), wrangler.jsonc and the Flue<Name>Agent Durable Object migrations you own, generated FLUE_*_AGENT bindings, src/cloudflare.ts, extend() for Agents SDK hooks, Workers AI, Cloudflare Sandbox/Computer, service bindings, .dev.vars and secrets, tracing, and vite build + wrangler deploy.
user-invocable: false
---

# Cloudflare target

Each agent becomes one **Durable Object class** (SQLite-backed) holding its conversations; `app.ts` becomes the Worker's fetch handler. Durable admission, recovery, and ordering are built in (no `db.ts` — it's a build error here).

## Wiring (verified at 2.1.1)

```ts
// vite.config.ts — flue() first; cloudflare() MUST receive flueWorkerConfig()
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [flue(), cloudflare({ config: flueWorkerConfig() })] });
```

Bare `cloudflare()` (shown on some older doc pages) fails: "The Cloudflare plugin is not receiving Flue's Worker configuration". `package.json` needs `"type": "module"`; devDeps `@cloudflare/vite-plugin`, `wrangler`, `vite`, `@flue/vite`. Flue 2.1.1 generates no `.flue-vite*` files — the customizer injects `main`, the per-agent DO bindings, and `nodejs_compat`, and validates `compatibility_date ≥ 2026-04-01`. Gitignore `dist/` and `.wrangler/`.

## Identity → Durable Object names → migrations (you own these)

| Agent identity | Class | Binding (`env.…`) |
|---|---|---|
| `export function Support()` | `FlueSupportAgent` | `FLUE_SUPPORT_AGENT` |
| `IssueTriage` | `FlueIssueTriageAgent` | `FLUE_ISSUE_TRIAGE_AGENT` |
| `Support.agentName = 'help-desk'` | `FlueHelpDeskAgent` | `FLUE_HELP_DESK_AGENT` |

```jsonc
// wrangler.jsonc (project root)
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "my-agents",
	"compatibility_date": "2026-06-01",
	"compatibility_flags": ["nodejs_compat"],
	"observability": { "enabled": true, "traces": { "enabled": true } },
	"migrations": [
		{ "tag": "v1", "new_sqlite_classes": ["FlueSupportAgent"] },
		{ "tag": "v2", "new_sqlite_classes": ["FlueIssueTriageAgent"] }, // adding an agent = module + mount + migration
		// { "tag": "v3", "renamed_classes": [{ "from": "FlueSupportAgent", "to": "FlueHelpDeskAgent" }] },
		// { "tag": "v4", "deleted_classes": ["FlueIssueTriageAgent"] }
	],
}
```

- **Append-only**: never rewrite or reorder deployed entries; each tag unique.
- Flue classes need `new_sqlite_classes` (never legacy `new_classes`).
- Renaming the agent **function** (or editing `agentName`) is a class rename → `renamed_classes` keeps its conversations; renaming the file or moving the mount needs nothing. Removing an agent → `deleted_classes`, or wrangler rejects the deploy.
- **Never hand-write `FLUE_*_AGENT` bindings** (reserved; build error). Declare only your own resources (R2, Queues, KV, Hyperdrive, your DOs, containers, `ai`).
- flue-loom's lint warns when a scanned agent has no live migration and prints the entry to append.

## Develop and deploy

```bash
npx vite dev                    # workerd via the Cloudflare plugin; regenerates on agent-set/wrangler changes
npx vite build                  # → dist/<worker>/wrangler.json (+ generated bindings) and a .wrangler deploy redirect
npx wrangler deploy --dry-run   # validates bundle + bindings, no credentials needed
npx wrangler deploy             # from the project root — no --config flag
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler tail               # live logs
```

Local secrets live in `.dev.vars` (or `.env` — not both); never commit either. `flue run` is Node-only: modules importing `cloudflare:*` fail there — use `vite dev`. Route middleware sees the original request; after admission, work runs inside the DO with no access to the caller's headers — authenticate before admission.

If one Worker also serves static assets, list every agent/channel prefix in `assets.run_worker_first` (e.g. `["/api/*", "/agents/*", "/channels/*"]`).

## `src/cloudflare.ts` — Worker-level code

```ts
export { Sandbox } from '@cloudflare/sandbox'; // named exports → top-level Worker exports (your DOs, Workflows)
export default {
	async scheduled(controller) { await dispatch(Reporter, { id: 'daily', message: { kind: 'signal', type: 'schedule', body: '…' } }); },
}; // non-HTTP handlers only — never `fetch` (HTTP stays in app.ts)
```

Declare your own DO bindings/migrations/containers in `wrangler.jsonc`; Cron Triggers go under `"triggers": { "crons": [...] }` (UTC).

## Per-agent Agents SDK hooks: `extend()`

```ts
'use agent';
import { extend } from '@flue/runtime/cloudflare';
export function Heartbeat() { useModel('anthropic/claude-sonnet-5'); return '…'; }
export const cloudflare = extend({
	base: (Base) => class extends Base { async onStart() { await this.scheduleEvery(60, 'heartbeat'); } async heartbeat() { /* … */ } },
	wrap: (Final) => Sentry.instrumentDurableObjectWithSentry((env) => ({ dsn: env.SENTRY_DSN }), Final),
});
```

Applies to every agent class in that module. Don't override `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()`. `schedule()` callbacks share the DO's alarm with agent work (they fire after a running response settles). `getCloudflareContext()` and `getDurableObjectIdentity()` are available inside DO handlers for advanced adapters.

## Models, sandboxes, calling agents

- Workers AI: `useModel('cloudflare/@cf/moonshotai/kimi-k2.6')` + `"ai": { "binding": "AI" }` — no API key, AI Gateway on by default; customize via `cloudflareBindingProvider()` (`flue-models`). With `flue({ providers: [...] })`, include `'cloudflare'`.
- Virtual sandbox (`bash(...)`) works as-is. Durable SQLite workspace: `npx flue add sandbox cloudflare-computer --print`. Full Linux containers: `@cloudflare/sandbox` + `useSandbox(cloudflareSandbox(getSandbox(env.Sandbox, id)))` (`import { env } from 'cloudflare:workers'`), Sandbox DO + `containers` + migration + Dockerfile (`FROM docker.io/cloudflare/sandbox:<version matching the package>`); containers need Workers Paid and Docker for local dev. Prefer outbound Workers for secret injection over env vars in the container.
- Private agents: reach another Worker's agents through a service binding — `createFlueClient({ url: 'https://agent.internal/agents/support/t1', fetch: (i, init) => env.AGENT_APP.fetch(new Request(i, init)) })`.
- `createMcpConnection()` at module top level is forbidden on Workers (no global-scope I/O) — use `useMcpConnection()`.

## Observability

Workers Traces get agent spans (`invoke_agent`, `chat`, `execute_tool`) automatically once traces are enabled — content included by default. Customize with `instrument(createCloudflareTracing({ content: false }))` in `app.ts`, or `tracing: false` in `flue.config.ts`. Each `observe()` subscriber sees only its own DO isolate. See `flue-observability`.

## Persisted-format boundary

Each DO database is stamped with Flue's format version; a newer/unknown stamp refuses to open (e.g. after a rollback). Pre-2.0 state cannot be migrated — retire old classes with `deleted_classes` (`flue-migration`).

Docs: `flue docs read guide/cloudflare-target`, `ecosystem/deploy/cloudflare`, `ecosystem/sandboxes/cloudflare`, `reference/configuration` (flueWorkerConfig).
