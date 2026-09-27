# Changelog

## 0.2.0 — Flue 2

A rewrite for Flue 2 (verified against 2.1.1) and current Claude Code plugin conventions. Flue 2 replaced the 0.x handler API wholesale, so nothing from 0.1.0's Flue guidance carries over.

### Plugin

- **Knowledge skills** rewritten from scratch for Flue 2: 20 skills covering `'use agent'` modules and identity, hooks, tools (plain, harness, durable), skills, subagents, sandboxes, models, routing and auth, the conversation protocol and `@flue/sdk`, workflows and schedules, durability, channels, Node and Cloudflare targets, observability, testing with faux models, debugging, and migration from 0.x and 1.0-beta. They point at the version-matched docs shipped in `@flue/cli`.
- **Commands are now skills** (`/flue-loom:<name>`, not model-invocable): `init`, `new`, `dev`, `run`, `talk`, `build`, `deploy`, `review`, `debug`, `explore`, `compose`, plus new `add` (official blueprints), `docs`, `migrate`, and `models`. They use `vite dev`/`vite build`, `flue init`/`run`/`add`/`docs`, and grant `allowed-tools` only for plugin-owned read-only helpers.
- **Subagents** rewritten for Flue 2 with current frontmatter: preloaded skills, `model: inherit`, colors, least-privilege tool lists. The deployer now prepares and dry-runs but never deploys; the deploy command asks first.
- **Hooks**: SessionStart maps the project (target, versions, agents and mounts, persistence, missing Cloudflare migrations, agents Flue will silently skip, pre-2.0 code); PostToolUse lints edits using the project's own `@flue/vite` scanner (directive placement, async agents, identities and Durable Object name collisions, pre-2.0 APIs, unmounted agents, wrangler/vite/flue config wiring, Agent Skills frontmatter). Exec-form hook commands.
- **Templates** replaced with verified Flue 2 components: agent, agent with tools/state, tool, harness tool, durable tool, SKILL.md, subagent, MCP connection, custom hook, Vitest config, tool test.
- **Scripts**: `flue-talk.mjs` (zero-dependency conversation client), `flue-inspect.mjs` (project report), `flue-models.mjs` (installed model catalog and id checks), `run-evals.sh`; removed `sse-invoke.sh`, `detect-workspace.sh`, `post-edit-flue.mjs`.
- **Manifest and distribution**: `marketplace.json` (install with `/plugin marketplace add discohead/flue-loom`), MCP registration moved to `.mcp.json` (the old `.claude-plugin/mcp.json` was never loaded), maintainer notes moved to `.claude/CLAUDE.md`.
- **Tests and evals**: 53 `node:test` tests for the scripts; a `claude plugin eval` suite with four scaffolded cases.

### MCP server (`@flue-loom/mcp` 0.2.0)

- Rebuilt on MCP SDK v2 (`serveStdio`, zod 4) and `@flue/sdk` for Flue 2's conversation protocol. New tools: `flue_list_agents` (registry + the local project's `app.ts` mounts), `flue_send_message` (user messages or signals, creation data, idempotency keys; waits with progress notifications), `flue_read_reply`, `flue_get_conversation`, `flue_abort`, `flue_add_agent`, `flue_remove_agent`. Removed the 0.x endpoint tools.
- Credentials only through registry entries naming `FLUE_*` environment variables.
- Fixed: error results no longer carry non-conforming `structuredContent` (strict clients raised protocol errors); cancellation reaches in-flight requests; `dist/server.mjs` is fully bundled (it previously failed to start without `mcp/node_modules`).
- Adds a Claude Desktop bundle (`pnpm pack:mcpb`), third-party license notices, a deterministic Flue fixture app, end-to-end tests with v2 and v1 clients, and a ten-question evaluation.
- Registry file is now `agents.json`; 0.1's `endpoints.json` is ignored.

## 0.1.0

Initial release for Flue 0.3.x.
