---
name: new
description: Create a Flue 2 component from flue-loom's verified templates — agent, tool, harness tool, durable tool, skill, subagent, MCP connection, custom hook, or test — and wire it in (app.ts mount, Cloudflare migration, dependencies).
argument-hint: "<agent|tool|harness-tool|durable-tool|skill|subagent|mcp|hook|test> [name] [what it should do]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(node *flue-models.mjs *)
---

# /flue-loom:new

Arguments: `$ARGUMENTS`

Templates live in `${CLAUDE_PLUGIN_ROOT}/templates/` and are verified against Flue 2.1.1 (type-check, build, lint). Read the template, fill every `{{placeholder}}`, adapt it to the request, and write it into the project. Nothing unreplaced may remain.

## 1. Orient

- Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs --no-lint` to learn the project root, **source root** (`.flue/` → `src/` → project root; written `<src>` below), target, existing agents and mounts. No project → suggest `/flue-loom:init`.
- Read one or two neighboring files and match their conventions (tabs, `.ts` import extensions, `import type`, directory names).
- Parse the kind and name from the arguments. Missing kind → ask. Missing name → derive one from the description or ask.
- A multi-agent system or a vague "build me an agent that…" → use `/flue-loom:compose` instead (architect first); this command makes one component.

## 2. Pick the template

| Kind | Template | Writes | Names |
|---|---|---|---|
| `agent` | `agent.ts.tmpl` (plain) or `agent-with-tools.ts.tmpl` (sandbox, tools, persistent state, gated tool, response metadata) | `<src>/agents/<name>.ts` | `{{Name}}` identity |
| `tool` | `tool.ts.tmpl` | `<src>/tools/<name>.ts` | `{{exportName}}`, `{{tool_name}}` |
| `harness-tool` | `harness-tool.ts.tmpl` — model work + sandbox inside a tool, structured `result` | `<src>/tools/<name>.ts` | same |
| `durable-tool` | `durable-tool.ts.tmpl` — side effects in `step.do`, replay-safe | `<src>/tools/<name>.ts` | same |
| `skill` | `skill/SKILL.md.tmpl` | `<src>/skills/<name>/SKILL.md` | `{{name}}`, `{{camelName}}` |
| `subagent` | `subagent.ts.tmpl` | `<src>/subagents/<name>.ts` | `{{Name}}`, `{{exportName}}`, `{{tool_name}}` |
| `mcp` | `mcp-connection.ts.tmpl` | `<src>/mcp/<name>.ts` | `{{exportName}}`, `{{tool_name}}`, `{{URL}}`, `{{ENV_VAR}}` |
| `hook` | `custom-hook.ts.tmpl` | `<src>/hooks/<hookName>.ts` | `{{hookName}}` (`use` + Pascal), `{{name}}` |
| `test` | `tool.test.ts.tmpl` (+ `vitest.config.ts.tmpl` if the project has none) | `<src>/test/<name>.test.ts` | `{{exportName}}`, `{{file}}`, `{{tool_name}}` |

Follow the project's existing directory names if they differ. Don't use `agent-with-tools` unless the request needs those pieces — delete the parts it doesn't.

## 3. Fill placeholders

- `{{Name}}` — PascalCase. For agents it is the **durable identity** (URL-safe, matches `^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$`, unique across the project). Renaming later orphans stored conversations and, on Cloudflare, the Durable Object class.
- `{{name}}` — kebab-case file/directory name. For skills it must equal the directory name (≤ 64 chars, lowercase, single hyphens).
- `{{exportName}}` — camelCase export; `{{tool_name}}` — the snake_case name the model sees. Never `task`, `activate_skill`, `read_skill_resource`, `finish`, `give_up`, or a sandbox tool name (`read`, `write`, `edit`, `bash`, `grep`, `glob`) when a sandbox is mounted.
- `{{MODEL}}` — `provider/model-id`; default `anthropic/claude-sonnet-5` (`claude-haiku-4-5` for cheap/fast work, `claude-opus-5` for hard reasoning). Check it: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs --check <spec>`.
- `{{DESCRIPTION}}` — model-facing: what it does, when to use it, what it returns. `{{INSTRUCTIONS}}` — the real instructions from the request, not filler (escape backticks and `${` inside template literals).
- Replace the template's example schema, state, and bodies with what the request needs; keep the explanatory comments that still apply and drop the rest.

## 4. Wire it in

- **Agent, HTTP server present** (`app.ts` exists): add `import { <Name> } from './agents/<name>.ts';` and `app.route('/agents/<name>', createAgentRouter(<Name>));` next to the existing mounts (keep any auth middleware pattern already used). Agents reached only via `dispatch()` or `flue run` don't need a mount — ask if unclear.
- **Agent on Cloudflare**: append a migration to `wrangler.jsonc` — `{ "tag": "v<N+1>", "new_sqlite_classes": ["Flue<Name>Agent"] }` — never edit existing entries.
- **Tool / subagent / MCP / hook / skill**: mount it where the user asked (`useTool(x)`, `useSubagent(x)`, `useMcpConnection(x)`, `useX()`, `import x from '../skills/<name>/SKILL.md'` + `useSkill(x)`). Harness tools that touch `harness.sandbox` need `useSandbox(...)` on that agent.
- **Dependencies** (use the project's package manager): `valibot` for schemas; `just-bash` for `bash(() => new Bash(...))` sandboxes; `vitest@^5` (dev) plus a `"test": "vitest run"` script for tests. Environment variables go in `.env` (Node) or `.dev.vars` / Worker secrets (Cloudflare); tell the user, never write secret values.

## 5. Verify

1. The edit hook lints each file as you write it — fix every ✗ it reports.
2. `npx tsc --noEmit` (or the project's `check:types`).
3. Agents: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs` shows it with the expected mount; with a key, `npx flue run <src>/agents/<name>.ts -m "…"`. Tests: `npx vitest run`.

Report the files created or changed, how to reach the component (mount URL, `flue run` command, or which agent mounts it), and anything left for the user (API keys, secrets).
