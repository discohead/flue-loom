---
name: flue-overview
description: Use when the user mentions Flue, the Flue SDK, @flue/sdk, @flue/cli, "flue agent", or is in a directory that contains a .flue/ workspace. The gateway skill that establishes the Flue mental model.
---

# Flue: Claude Code as an SDK

Flue (`@flue/sdk` + `@flue/cli`) is a framework for building Claude-Code-like agents. Where Claude Code is a single agent shipped as a CLI, Flue is the building blocks: you write small TypeScript handlers that compose sessions, sandboxes, roles, skills, tools, and triggers, then deploy them to Node or Cloudflare.

## The mental model

```
@flue/sdk/client          ← agent handler imports (FlueContext, init, Type)
       │
   ┌───┴────┐
   │  init  │  resolves sandbox + persistence + model
   └───┬────┘
       │
  FlueAgent  ← scoped to one request; vends sessions
       │
   ┌───┴───────────────────────────┐
   │   FlueSession                  │
   │   prompt() · skill() · task()  │  ← LLM-driven turns
   │   shell()                      │  ← non-LLM ops in sandbox
   └────────────────────────────────┘
```

Every agent is a `default export async function ({ init }: FlueContext)`. Inside, `init()` returns an agent, `agent.session()` returns a session, and you drive the session with prompts/skills/tasks/shell.

## Two faces in flue-loom

This plugin (`flue-loom`) gives you two ways to work with Flue:

1. **Authoring** (Claude Code only) — slash commands and subagents that scaffold/review/refactor code in a Flue workspace. Use when you're writing or editing agents.
2. **Operating** (Claude Code + any MCP host) — a bundled MCP server that lets Claude Code (or Claude Desktop, ChatGPT, Cursor) talk to a running Flue HTTP endpoint. Use when you want to *invoke* an agent rather than write one.

## Related skills

- `flue-workspace-layout` — directory structure and resolution waterfall
- `flue-agent-authoring` — handler shape, imports, return values
- `flue-sessions` — what `prompt`/`skill`/`task`/`shell` actually do
- `flue-lifecycle` — `flue dev` vs `flue run` vs `flue build`
- `flue-debugging` — common pitfalls and recipes

## Source-of-truth references

When unsure, read these files in the Flue repo (`@flue/sdk@0.3.5`):

- `packages/sdk/src/types.ts` — `FlueContext`, `FlueAgent`, `FlueSession`, `AgentInit`, `SessionEnv`, `ToolDef`, `Role`, `Command`
- `packages/sdk/src/client.ts` — `init()` impl + sandbox waterfall + public re-exports
- `packages/sdk/src/build.ts` — discovery, `parseTriggers`, externalization
- `packages/sdk/src/agent.ts` — built-in tools, `BUILTIN_TOOL_NAMES`
- `examples/hello-world/.flue/` — canonical pattern reference
