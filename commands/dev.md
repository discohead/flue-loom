---
description: Start the Flue dev server in the background
argument-hint: "[--target node|cloudflare] [--port N] [--env path]…"
allowed-tools: ["Bash", "Read", "Monitor"]
---

Start `flue dev` for the current workspace as a background process.

Arguments: $ARGUMENTS

## Steps

1. Resolve flags from `$ARGUMENTS` (defaults: `--target node`, `--port 3583`).
2. Resolve the `flue` CLI binary via `${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh` — checks `$FLUE_CLI_BIN`, then walks up to `node_modules/.bin/flue`, then PATH.
3. Verify the workspace (`./.flue/` or `./agents/`). Fail with a hint to run `/flue:init` if missing.
4. Spawn with `Bash` `run_in_background: true`:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh" dev --target $target --port $port
   ```
5. Use `Monitor` on the bash shell id to watch for `Server listening on http://localhost:$port` (or equivalent). Wait up to 30s.
6. Once the server is up, fetch the agent list:
   ```bash
   curl -s "http://localhost:$port/agents"
   ```
7. Report:
   - Background shell id (for the user to KillShell later, or `/flue:dev --stop` if implemented)
   - Port + URL
   - Number of agents loaded + names
   - Suggested next steps: `/flue:talk <agent>` or `/flue:run <agent>`

## Stopping the dev server

If a previous `/flue:dev` background process is already running, prefer that one (don't spawn another). Track the shell id in the conversation. To stop, use `KillShell` with the tracked shell id.

## Pitfalls

- Multiple dev servers on the same port → port collision. Default port is 3583; surface the error clearly.
- `flue dev` exits immediately if the workspace has no agents → check `.flue/agents/` is non-empty before spawning.
- Env files: pass `--env <path>` repeatable; later wins on collision; shell vars override file values.
