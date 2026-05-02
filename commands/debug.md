---
description: Investigate a failing Flue agent
argument-hint: "<agent> [--id X] [--symptom 'description']"
allowed-tools: ["Task", "Read", "Bash", "Monitor", "Glob", "Grep"]
---

Debug a Flue agent via the `flue-debugger` subagent.

Arguments: $ARGUMENTS

## Dispatch

Invoke `flue-debugger` (Task tool, `subagent_type: flue-debugger`) with:

> Diagnose the failing agent `<agent>` (id: `<id or none>`).
> User-reported symptom: `<symptom or 'unspecified'>`.
> Workspace cwd: `<cwd>`.
> Run the standard diagnostic flow (manifest → /agents → sync invoke → SSE → targeted reads).
> Report root cause + minimal fix + verification.

## When to use

- An agent fails to invoke or returns unexpected results.
- Build-time discovery issues ("agent missing from manifest").
- Mid-turn errors (model resolution, tool collision, sandbox issues).
- Production failures with structured error envelopes from PR #18.

## What the debugger does

1. Reads the failing agent file.
2. Inspects `dist/manifest.json` if present.
3. Probes `/agents` if a dev server is running.
4. Runs sync + SSE invocations.
5. Cross-references against the symptom catalog (trigger regex, FLUE_MODE, model resolution, tool name collision, sandbox kind, env file path resolution, CF compat date).
6. Reports root cause with citations.

## Constraints

- The debugger does NOT auto-fix unless asked. It reports, you decide.
- Destructive ops (rm, drop sessions) require explicit confirmation.
