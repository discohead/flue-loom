---
name: flue-migration
description: Use when upgrading an older Flue project to Flue 2 — 0.x code (FlueContext handlers, export const triggers, init()/session.prompt, roles, Type.Object tools, flue dev/build, @flue/sdk/client) or 1.0-beta code (defineAgent config bags, workflows, auto-router, deployment-wide SDK client). Covers the persisted-state reset, a step-by-step plan, and a full API mapping.
user-invocable: false
---

# Migrating to Flue 2

Flue 2 is a redesign, not a version bump: agents are functions composed with hooks, Vite owns dev/build, `app.ts` owns routing, and the HTTP protocol is conversation-based. Plan a rewrite of agent modules and **every client** that calls them over HTTP.

## Recognize the era

| Signal | Era |
|---|---|
| `export default async function ({ init, payload }: FlueContext)`, `export const triggers`, `@flue/sdk/client`, `flue dev`/`flue build`, `.flue/roles/*.md`, `POST /agents/:name/:id` returning `{ result }` | **0.x** (≤ 0.11) |
| `defineAgent(async (ctx) => ({ model, tools, … }))`, `defineWorkflow`, `app.route('/', flue())`, `client.agents.send(...)`, `@flue/runtime@1.0.0-beta.*` | **1.0-beta** |
| `'use agent'`, `useModel(...)`, `createAgentRouter(...)`, `vite dev` | **2.x** (current) |

## Hard boundary: persisted state resets

Flue 2 stores schema version 8; any pre-2.0 database is **rejected at startup** — no in-place migration. Export conversation data you need through the *old* app first. On Cloudflare, retire old Durable Object classes (`deleted_classes`, including 1.0-beta's `FlueRegistry` and `Flue<Name>Workflow` classes) and introduce fresh `Flue<Name>Agent` classes with `new_sqlite_classes`.

## Procedure

1. **Inventory** — `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs` (or dispatch flue-explorer): agents, their triggers/tools/sandbox/model/roles, skills, custom tools, schedules, wrangler config, and every client of the HTTP API.
2. **Decide per agent**: HTTP-mounted (was `webhook: true`) · dispatch-only (webhooks, channels, schedules) · `flue run` only (was trigger-less/CLI).
3. **New toolchain** — in a scratch dir run `npx -y @flue/cli@latest init tmp --target <node|cloudflare> --deploy` and copy what you need (`flue.config.ts`, `vite.config.ts`, `tsconfig.json`, scripts, deps) into the project; don't `--force` over a real project. Remove 0.x `@flue/sdk` as an authoring dep (it's now the HTTP client), add `@flue/runtime`, `@flue/cli`, `@flue/vite`, `vite`, `hono`, `valibot` (+ `just-bash` for virtual sandboxes). Scripts: `vite dev`, `vite build`.
4. **Convert each agent** with the mapping in [mapping.md](mapping.md): one `'use agent'` module per agent family, exported PascalCase function, one `useModel`, hooks for capabilities, returned instructions. Handler logic that orchestrated `session.prompt/skill/task/shell` becomes (a) instructions + tools the model drives, (b) harness tools for code-driven model steps, (c) subagents for delegation.
5. **Tools**: `parameters: Type.Object` + `execute` → `input: v.object(...)` + `run({ data })` returning `{ output }`.
6. **Roles** → subagent definitions (role body = subagent instructions, role `model` = subagent `model`) or `useInstruction`/custom hooks for per-agent personas.
7. **Routing**: write `src/app.ts` mounts (keep old `/agents/<name>` paths if clients depend on them) plus auth middleware; add `db.ts` on Node.
8. **Schedules**: `cron: '…'` triggers → croner in `app.ts` (Node) or Cron Triggers + `scheduled()` in `src/cloudflare.ts` (Cloudflare), both calling `dispatch()`.
9. **Clients**: rewrite HTTP callers for the conversation protocol (`POST` → 202 admission, then `read()`/history) — use `@flue/sdk` (`flue-client`). There is no `GET /agents` manifest and no synchronous result mode.
10. **Verify**: plugin lint clean on every module, `check:types`, `npx flue run <module> -m "…"` per agent, `vite build`, then `flue-talk` against `vite dev`; Cloudflare: `wrangler deploy --dry-run`.

Work incrementally — convert and verify one agent end-to-end before the rest. Keep the old app deployable until clients have moved.

Docs: `flue docs read guide/migration` (1.0-beta → 2 in depth), [mapping.md](mapping.md) (0.x and beta → 2 tables).
