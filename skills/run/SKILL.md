---
name: run
description: Run one Flue 2 agent module locally with `flue run` — send a message, print the reply, and optionally continue the same durable conversation — without starting a server.
argument-hint: "<agent-module-or-Name> <message> [--id <conversation>] [--data <json>] [--env <file>]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(bash *flue-cli.sh run *)
---

# /flue-loom:run

Arguments: `$ARGUMENTS`

`flue run` loads one agent module (never `app.ts`) in a local Node process, submits one message, streams activity to stderr, prints the reply to stdout, and exits — no server, no build output. It works in Cloudflare projects too, unless the module imports `cloudflare:*` APIs (then use `/flue-loom:dev`).

## Steps

1. **Resolve the module.** Accept a path (`src/agents/support.ts`) or an agent identity (`Support`): find the file with `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs --json --no-lint` (`projects[].agents[]` → `file`). A module exporting several agents needs `--name <identity>` (its `agentName` static, else the function name).
2. **Message** is required. Take it from the arguments; ask if missing.
3. **Run** from the project root with the CLI resolver:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh run <module> -m "<message>" --json [--name <Identity>] [--id <conversation>] [--data '<json>'] [--env <file>]
   ```
   - `--json` prints one envelope on stdout — `{ id, agent, submissionId, outcome, message | error, uid }`, `outcome` ∈ `completed | failed | aborted | error` (setup failure) — parse it for the reply, the conversation id (for follow-ups), and `error.type`. Exit codes: 0 completed, 1 failed/setup error, 130 aborted. Drop `--json` for plain reply text.
   - `--id` continues a conversation (created if new); keep reusing the printed `id` for multi-turn runs. `--new` rejects an existing id; `--uid` pins one incarnation.
   - `--data` is creation data read with `useInitialData()`, validated by the agent's `initialData` schema; ignored when continuing.
   - `.env` in the project root loads automatically (shell wins); `--env <file>` loads an alternate instead.
4. **Report** the reply, the conversation id, and how to continue (`/flue-loom:run <module> "<next message>" --id <id>`).

## Failures

- Missing provider key → the error names the variable; the user adds it to `.env` (never ask for the value).
- `outcome` other than completed → report the `error.type`/`message`; `/flue-loom:debug` digs in.
- Model id typo → `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs --check <spec>` suggests the right id.
- Unknown agent / several agents in the module → pass `--name` with the exact identity.
- Conversations persist between runs — in `db.ts`'s database when the project has one, else `node_modules/.cache/flue/run.db` — so `--id` works across invocations; use a fresh id (with `--new` to be sure) to start clean.
