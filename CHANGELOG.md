# Changelog

## 0.3.0 — Flue 2.3

Verified against Flue 2.3.0 (was 2.1.1).

### Plugin

- **Flue 2.3.0**: re-verified the agent scanner, the templates (type check, tests, build), the Cloudflare build and dry run, and the CLI and docs the skills cite. The skills cover what 2.2 and 2.3 added: bounded history reads (`history({ limit })`, `historyBefore()`, `?limit`/`?before`, `410 history_cursor_not_found`), server timestamps on messages and settlements, PDF attachments (`documents`), Node subpath imports for Markdown and skills, the Azure provider rename (`azure/…`), the `-`/`.` model-id fallback, the commented Workers AI binding in Cloudflare scaffolds, and the E2B blueprint v2 update. They also warn about the `useAgentFinish` regression in 2.2.0–2.2.2.
- **Models**: recommendations follow the current Claude lineup: Sonnet 5.5 by default, Haiku 5.5 for cheap or fast steps and subagents, Opus 5.5 and Fable 5.1 for hard reasoning, each with the Flue version it needs. The Fable/Opus 5.x, Sonnet 5.5, and Haiku 5.5 models can't disable thinking, so `thinkingLevel: 'off'` runs them at the default `high` effort. The skills, the architect, and the reviewer recommend `'low'` instead.
- **`flue-models.mjs`**: `--details` lists the thinking levels each model accepts. `--check` says when Flue would resolve an id that differs only in `-`/`.` version separators (with a warning).
- **`flue-talk.mjs`**: `--history --limit N` reads only the newest messages, transcripts show server timestamps, and replies come from the newest messages rather than the whole conversation.
- **`npx flue` → `npx @flue/cli`** throughout (skills, agents, lint messages): in a project without `@flue/cli` installed, a bare `npx flue` downloads an unrelated npm package named `flue`. The SessionStart docs hint uses the project's package manager (`pnpm exec flue`, `yarn flue`, `bunx @flue/cli`).
- **Testing skill**: covers Pi 1.x faux transcripts. Instructions arrive as `system` messages (there is no `context.systemPrompt`), and the `@earendil-works/pi-ai` version must match the runtime's.
- 55 script tests.

### MCP server (`@flue-loom/mcp` 0.3.0)

- `@flue/sdk` 2.3.0.
- `flue_get_conversation` reads the newest messages and pages back only as far as `last` needs on Flue ≥ 2.2 (older runtimes still return everything). `message_count` is present only when the whole conversation was read, `settlements` cover the returned window, and messages and settlements carry server `timestamp`s.
- `flue_send_message` reads the reply from the newest 50 messages instead of downloading the whole transcript, and falls back to a full read when the reply isn't among them.
- The eval fixture runs on Flue 2.3.0 and Pi 1.1.

## 0.2.0 — Flue 2

A rewrite for Flue 2 (verified against 2.1.1) and current Claude Code plugin conventions. Flue 2 replaced the 0.x handler API wholesale, so nothing from 0.1.0's Flue guidance carries over.

### Plugin

- **Knowledge skills** rewritten from scratch for Flue 2: 20 skills covering `'use agent'` modules and identity, hooks, tools (plain, harness, durable), skills, subagents, sandboxes, models, routing and auth, the conversation protocol and `@flue/sdk`, workflows and schedules, durability, channels, Node and Cloudflare targets, observability, testing with faux models, debugging, and migration from 0.x and 1.0-beta. They point at the version-matched docs shipped in `@flue/cli`.
- **Commands are now skills** (`/flue-loom:<name>`, not model-invocable): `init`, `new`, `dev`, `run`, `talk`, `build`, `deploy`, `review`, `debug`, `explore`, `compose`, plus new `add` (official blueprints), `docs`, `migrate`, and `models`. They use `vite dev`/`vite build`, `flue init`/`run`/`add`/`docs`, and grant `allowed-tools` only for plugin-owned read-only helpers.
- **Subagents** rewritten for Flue 2 with current frontmatter: preloaded skills, `model: inherit`, colors, least-privilege tool lists. The deployer now prepares and dry-runs but never deploys; the deploy command asks first.
- **Hooks**: SessionStart maps the project (target, versions, agents and mounts, persistence, missing Cloudflare migrations, agents Flue will silently skip, pre-2.0 code); PostToolUse lints edits using the project's own `@flue/vite` scanner (directive placement, async agents, identities and Durable Object name collisions, pre-2.0 APIs, unmounted agents, wrangler/vite/flue config wiring, Agent Skills frontmatter). Exec-form hook commands.
- **Templates** replaced with verified Flue 2 components: agent, agent with tools/state, tool, harness tool, durable tool, SKILL.md, subagent, MCP connection, custom hook, Vitest config, tool test.
- **Scripts**: `flue-talk.mjs` (zero-dependency conversation client), `flue-inspect.mjs` (project report), `flue-models.mjs` (installed model catalog and id checks), `run-evals.sh`; removed `sse-invoke.sh`, `detect-workspace.sh`, `post-edit-flue.mjs`.
- **Manifest and distribution**: `marketplace.json` (install with `/plugin marketplace add discohead/flue-loom`), MCP server registered inline in `plugin.json` (the old `.claude-plugin/mcp.json` was never loaded), maintainer notes moved to `.claude/CLAUDE.md`.
- **Tests and evals**: 53 `node:test` tests for the scripts; a `claude plugin eval` suite with four scaffolded cases.

### MCP server (`@flue-loom/mcp` 0.2.0)

- Rebuilt on MCP SDK v2 (`serveStdio`, zod 4) and `@flue/sdk` for Flue 2's conversation protocol. New tools: `flue_list_agents` (registry + the local project's `app.ts` mounts), `flue_send_message` (user messages or signals, creation data, idempotency keys; waits with progress notifications), `flue_read_reply`, `flue_get_conversation`, `flue_abort`, `flue_add_agent`, `flue_remove_agent`. Removed the 0.x endpoint tools.
- Credentials only through registry entries naming `FLUE_*` environment variables.
- Fixed: error results no longer carry non-conforming `structuredContent` (strict clients raised protocol errors); cancellation reaches in-flight requests; `dist/server.mjs` is fully bundled (it previously failed to start without `mcp/node_modules`).
- Adds a Claude Desktop bundle (`pnpm pack:mcpb`), third-party license notices, a deterministic Flue fixture app, end-to-end tests with v2 and v1 clients, and a ten-question evaluation.
- Registry file is now `agents.json`; 0.1's `endpoints.json` is ignored.

## 0.1.0

Initial release for Flue 0.3.x.
