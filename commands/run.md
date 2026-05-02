---
description: Invoke a Flue agent once locally (build + run + exit)
argument-hint: "<agent> [--id X] [--payload JSON] [--env path]"
allowed-tools: ["Bash", "Read"]
---

Run a Flue agent one-shot via `flue run`.

Arguments: $ARGUMENTS

## Steps

1. Parse `<agent>`, `--id`, `--payload`, `--env` from `$ARGUMENTS`. Default `--id` to `local-$(date +%s)` if omitted.
2. Resolve the CLI: `${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh`.
3. Verify the agent file exists at `.flue/agents/<agent>.ts` (or extensions). Fail clearly if not.
4. Run synchronously (this command waits for completion):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh" run "$agent" \
     --target node \
     --id "$id" \
     ${payload:+--payload "$payload"} \
     ${env:+--env "$env"}
   ```
5. The CLI prints SSE events as text + the final result. Pass through to the user.

## Behavior notes

- `flue run` is **Node-only**. For Cloudflare-targeted agents, use `/flue:talk` against a deployed worker URL instead.
- `flue run` builds, spawns a transient server, invokes once, exits. No persistent state across runs.
- Sets `FLUE_MODE=local` automatically — trigger-less agents work.
- Requires `ANTHROPIC_API_KEY`. If missing, the CLI throws with a clear message.
- `--env` paths resolve against `--output` (default cwd), not `--workspace`. Use absolute paths to avoid surprises.

## Pitfalls

- Forgetting `--id` → CLI errors. Default it for the user.
- Passing payload that isn't valid JSON → CLI errors. Suggest single-quotes-around-JSON: `--payload '{"q":"hi"}'`.
- Trying to run a CF agent → fails clearly; suggest `/flue:dev --target cloudflare` or deploy + `/flue:talk`.
