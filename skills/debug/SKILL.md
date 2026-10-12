---
name: debug
description: Diagnose a failing Flue 2 agent — build or scan errors, HTTP 404/400s, error envelopes, failed submissions, model, tool, state, or Cloudflare problems — via the flue-debugger subagent, then apply the fix with the user's OK and verify it.
argument-hint: "[agent | conversation-url] [symptom…]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
---

# /flue-loom:debug

Arguments: `$ARGUMENTS`

1. **Collect evidence** from the conversation before delegating: the failing command and its full output, the agent/module or conversation URL, what was expected, and whether a dev server from this conversation is running (its URL). Ask one question if the symptom is unknown.
2. **Diagnose.** Spawn `flue-loom:flue-debugger` (Agent tool):
   > Diagnose `<agent / URL>` in the Flue project at `<root>`. Symptom: `<symptom>`. Evidence: `<commands + output>`. Dev server: `<URL or none>`. Reproduce with flue run or flue-talk, find the root cause with evidence, and return the diagnosis with a minimal fix and verification commands. Don't edit files.
3. **Present** the diagnosis: root cause, evidence, proposed fix.
4. **Fix** after the user agrees (or immediately when they asked for a fix): apply the minimal change yourself; for a larger rewrite, delegate to `flue-loom:flue-author`. Destructive steps (deleting data, dropping Durable Object classes, resetting `node_modules/.cache/flue/*.db`) need explicit confirmation.
5. **Verify** with the debugger's commands (`flue run … --json`, `flue-talk … --json`, `flue-inspect`, `tsc`) and report the before/after.

If the root cause is a Flue bug, summarize the evidence and installed versions so the user can open an issue at https://github.com/withastro/flue/issues.
