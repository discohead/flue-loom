---
name: compose
description: Design and build a Flue 2 agent system from a description — flue-architect writes a spec you confirm with the user, flue-orchestrator and flue-author implement it, and the result is linted, type-checked, and exercised.
argument-hint: "<what the agents should do>"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(npx tsc --noEmit *)
---

# /flue-loom:compose

Arguments: `$ARGUMENTS`

## 1. Design

No Flue project yet → scaffold one first by following `${CLAUDE_PLUGIN_ROOT}/skills/init/SKILL.md` (ask the target). Then spawn `flue-loom:flue-architect` (Agent tool):

> Design a Flue 2 system for: `<description>`. Project root: `<root>`. Read what exists first and reuse it. Return the spec in your standard format.

Show the spec. Resolve its **Open questions** with the user (one round of multiple-choice questions) and get a go-ahead on the design before writing code. A complete spec from the user skips this step.

## 2. Build

- Spawn `flue-loom:flue-author` for the leaf components the spec lists (agents, tools, skills, subagents, hooks, MCP connections) — independent components can go to parallel author calls with disjoint files.
- Then spawn `flue-loom:flue-orchestrator` with the spec and the files written so far to implement the composition: mounts, dispatch paths, subagent wiring, schedules, pipelines.
- A single agent with a few tools needs only the author.

Pass each subagent the spec (verbatim) and the project root; ask for the list of files changed.

## 3. Verify

1. Install any dependencies the subagents list (the project's package manager).
2. `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs` — every new agent present, mounted or dispatched as designed, lint clean; Cloudflare migrations added.
3. `npx tsc --noEmit`.
4. Exercise it: `npx flue run <entry agent> -m "<representative request>" --json` with a model key, or `/flue-loom:dev` + `/flue-loom:talk`. Tools with logic get a Vitest test (templates `tool.test.ts.tmpl` + `vitest.config.ts.tmpl` in `${CLAUDE_PLUGIN_ROOT}/templates/`).
5. Fix what fails before reporting.

## 4. Report

The final spec, files created/changed, a numbered flow (who sends what to whom, by which mechanism), how to run and talk to it, and what's left for the user (API keys, secrets, auth decisions). Offer `/flue-loom:review`.

Keep to what the user asked — no extra agents to "round out" the system, no speculative features.
