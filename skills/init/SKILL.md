---
name: init
description: Scaffold a new Flue 2 project with `flue init` (Node or Cloudflare, with or without the HTTP server), install dependencies, and verify the starter agent.
argument-hint: "[directory] [--target node|cloudflare] [--deploy]"
disable-model-invocation: true
allowed-tools:
  - Bash(node --version)
  - Bash(node *flue-inspect.mjs *)
  - Bash(npx -y @flue/cli@latest init *)
---

# /flue-loom:init

Arguments: `$ARGUMENTS`

`flue init` owns the project skeleton — never hand-write it. It only writes files; you install, configure credentials, and verify. Background: the `flue-project` skill.

## 1. Decide the shape

- **Directory**: the first non-flag argument; default `.`.
- **Target**: `--target node|cloudflare`. If missing, ask the user with one multiple-choice question:
  - **Node + HTTP server** (`--target node --deploy`, recommended): `vite dev` / `vite build`, routes in `src/app.ts`; works with `/flue-loom:dev` and `/flue-loom:talk`.
  - **Node, agents only** (`--target node`): run agents with `flue run` (scripts, CI, cron). The server can be added later.
  - **Cloudflare** (`--target cloudflare`): Workers + one Durable Object per agent; the server is always included.
- Check `node --version` ≥ 22.19 (Flue's engine floor). If older, stop and say so.

## 2. Pre-flight the directory

- Missing or empty → scaffold into it.
- Already a Flue project (`@flue/*` in package.json) → don't re-init. Suggest `/flue-loom:explore`, or `/flue-loom:migrate` when `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs <dir>` reports pre-2.0 code.
- Non-empty otherwise → `flue init` refuses without `--force`, and `--force` **overwrites** `package.json`, `README.md`, `.gitignore`, `tsconfig.json`, `vite.config.ts`, `src/app.ts`, and friends. Never pass `--force` over files that matter. Scaffold into a scratch subdirectory instead (`flue init ./flue-scaffold …`), merge the pieces in by hand (dependencies and scripts into the existing `package.json`, `.gitignore` entries, the tsconfig settings from `flue-project`), and remove the scratch directory once the user confirms.

## 3. Scaffold

```bash
npx -y @flue/cli@latest init <dir> --target <node|cloudflare> [--deploy]
```

Always pass `--target`: the command prompts for it otherwise and fails without a TTY.

## 4. Install

Use the package manager the user already uses (their request, a lockfile, or a workspace root above `<dir>`); otherwise `npm install`. Run it inside `<dir>`.

## 5. Credentials

`flue init` writes `.env` (gitignored) with an empty `ANTHROPIC_API_KEY=`. Ask the user to fill it in themselves — never ask them to paste a key into the conversation, and never print `.env` contents. Any provider works (`/flue-loom:models`); the starter agent uses `anthropic/claude-haiku-4-5`. On Cloudflare, local Worker variables come from `.env` or `.dev.vars` (use one — when `.dev.vars` exists, `.env` is ignored), and production keys are Worker secrets (`wrangler secret put ANTHROPIC_API_KEY`).

## 6. Verify

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs <dir>` — target, versions, the `Hello` agent, its `/agents/hello` mount, clean lint.
2. `npx tsc --noEmit` in `<dir>`.
3. With a key in place: `npx flue run src/agents/hello.ts -m "Say hello!"`. Without one, say it's pending.

## 7. Report

What was created (target, server yes/no, files), what's still needed (API key), and next steps:
- `/flue-loom:new agent <Name>` — add an agent from the templates.
- `/flue-loom:dev`, then `/flue-loom:talk http://localhost:5173/agents/hello/first-chat "Hi"`.
- `/flue-loom:add` — blueprints for channels, databases, sandboxes, and tooling.
