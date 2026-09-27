---
name: dev
description: Start (or stop) the Flue 2 dev server — `vite dev` in the background — wait until it's ready, and report the agents, their conversation URLs, and any startup errors.
argument-hint: "[--port N] [--mode <mode>] | stop"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(npx vite dev *)
---

# /flue-loom:dev

Arguments: `$ARGUMENTS`

Flue 2 has no `flue dev`: the `flue()` Vite plugin serves `src/app.ts` under `vite dev` (default port 5173; Cloudflare projects run inside workerd through `@cloudflare/vite-plugin`).

## Stop

If the argument is `stop`: stop the dev server this conversation started with `TaskStop` (its background task id) and confirm. If you didn't start it, say which process holds the port (`lsof -i :<port>` or `ss -ltnp`) and ask before killing anything.

## Start

1. **Orient** — `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs --no-lint`. Stop with guidance when:
   - there's no `vite.config.*` / `app.ts` (a Node project created without `--deploy`): run agents with `/flue-loom:run`, or add the server pieces (`flue-project` skill);
   - dependencies aren't installed (`node_modules` missing): install first;
   - it's a pre-2.0 project: `/flue-loom:migrate`.
2. **Reuse** — if a dev server from this conversation is still running, reuse it instead of starting another.
3. **Launch** with Bash `run_in_background: true` from the project root, passing through `--port`/`--mode`:
   ```bash
   npx vite dev --port <port> --strictPort
   ```
   `--strictPort` makes a busy port fail loudly instead of silently moving; on that error, pick a free port or ask.
4. **Wait for ready** (≤ 30 s): the output shows Vite's `Local:` URL. Poll with a background `until curl -s -o /dev/null --max-time 1 http://localhost:<port>/; do sleep 0.5; done` loop (or Monitor), then read the task output. Report errors verbatim if it exits or logs `[flue]`/`Error` lines — common ones: `[flue] No app entry found` (missing `app.ts`), agent scan errors (fix per the edit-lint message), port in use.
5. **Report**:
   - URL and background task id (stop with `/flue-loom:dev stop`).
   - Each mounted agent's conversation URL: `http://localhost:<port><mount>/<conversation-id>` — any new id creates a conversation.
   - Next: `/flue-loom:talk http://localhost:<port>/agents/<name>/try-1 "Hello"`; the plugin's MCP tools work too (`flue_list_agents` finds these mounts, `flue_send_message` talks to them).
6. **Optional watch** — when the user will iterate, arm a Monitor on the task output filtered to `error|Error|ERR_|warn|\[flue\]` so runtime failures surface while you work.

## Facts worth knowing

- Edits to agent modules reload automatically. Adding/removing an agent or changing its identity regenerates the agent set (Cloudflare restarts the dev server). Restart after changing `vite.config.*`, `flue.config.*`, or `.env`.
- Node: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local` load into `process.env` (shell wins). Cloudflare: Worker vars come from `.dev.vars` or `.env` — one or the other; `.dev.vars` wins when present.
- Dev conversations persist in `node_modules/.cache/flue/dev.db` across reloads and reset on a cold start (unless `db.ts` points elsewhere). The built server defaults to in-memory SQLite.
- Dev CORS allows localhost origins; deployed servers add none — see `flue-routing`.
- `vite preview` serves the built artifact (`/flue-loom:build` first) with production defaults.
