---
name: explore
description: Map a Flue project — target, versions, agents and how each is reached, tools, skills, subagents, MCP connections, persistence, auth, conventions, and risks — using flue-inspect and the flue-explorer subagent.
argument-hint: "[path]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
---

# /flue-loom:explore

Arguments: `$ARGUMENTS`

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs <path or .>` and show its summary. No Flue project found → say so (nested projects are listed when present) and offer `/flue-loom:init`. Pre-2.0 project → point at `/flue-loom:migrate`.
2. For more than a trivial project (several agents, shared components, channels, or custom routes), spawn `flue-loom:flue-explorer` (Agent tool):
   > Map the Flue project at `<root>`. Cite a file path for every claim; end with risks and surprises.
3. Present the map. Keep the agents table and the risks; offer next steps that fit what you found (`/flue-loom:review` for risks, `/flue-loom:dev` to run it, `/flue-loom:talk` for a mounted agent, `/flue-loom:new` to extend it).
