---
name: migrate
description: Upgrade a pre-2.0 Flue project (0.x FlueContext handlers with triggers and roles, or 1.0-beta defineAgent/workflows) to Flue 2 — inventory, a per-agent plan the user approves, then incremental conversion and verification one agent at a time.
argument-hint: "[path] [--plan-only]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(git status *)
---

# /flue-loom:migrate

Arguments: `$ARGUMENTS`

Load the `flue-loom:flue-migration` skill (procedure) and read its `mapping.md` (`${CLAUDE_PLUGIN_ROOT}/skills/flue-migration/mapping.md`, API tables) before starting. Flue 2 is a redesign: agents become hook-composed functions, Vite owns dev/build, `app.ts` owns routing, and the HTTP protocol changes — so every HTTP client of these agents changes too.

## 1. Inventory

- `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs <path>` — era (0.x vs 1.0-beta) and legacy APIs per file.
- For larger projects spawn `flue-loom:flue-explorer` to map agents, triggers, roles, tools, skills, sandboxes, models, schedules, and wrangler config.
- Find every client of the old HTTP API (grep for `/agents/`, `@flue/sdk/client`, `client.agents`, `fetch(` to the agent host) — they need rewriting too.
- `git status` — work on a branch with a clean tree so every step is reviewable and revertible.

## 2. Plan (confirm before changing anything)

Present a table: old agent → new identity, how it's reached (mount / dispatch / flue run / channel), model, sandbox, tools, roles → subagents/instructions, schedules, state that will reset. Call out the hard facts:
- Persisted state from pre-2.0 databases is **rejected**, not migrated — export anything needed through the old app first.
- Cloudflare: new `Flue<Name>Agent` Durable Object classes via `new_sqlite_classes`; old classes need `deleted_classes` (destroys their data) — only with the user's explicit OK.
- Endpoint and payload changes for clients (`POST` → 202 admission + read; no `GET /agents`, no sync result mode).

Stop here with `--plan-only`.

## 3. Convert incrementally

1. Toolchain: follow the procedure's step 3 (scratch `flue init`, merge config and dependencies, scripts → `vite dev` / `vite build`). Install.
2. One agent end to end first: convert it with `mapping.md` (or delegate to `flue-loom:flue-author` with the old file, the mapping, and the plan row), mount or wire it, then verify — lint clean, `npx tsc --noEmit`, `npx flue run <module> -m "…"`.
3. Then the rest, one at a time, verifying each. Roles → subagents or `useInstruction`; `Type.Object` tools → valibot `defineTool`; triggers → mounts/dispatch/schedules; custom sandboxes → `useSandbox` factories.
4. Clients: rewrite callers for the conversation protocol with `@flue/sdk` (`flue-client`).
5. Remove legacy dependencies and dead files only after everything passes.

## 4. Verify and hand off

`flue-inspect` shows no legacy APIs and a clean lint; `npx vite build` passes; `/flue-loom:dev` + `/flue-loom:talk` exercises each HTTP agent; Cloudflare: `npx wrangler deploy --dry-run`. Report what changed per agent, what the user must do (data export, secrets, client rollout, old-class deletion), and suggest `/flue-loom:review`.
