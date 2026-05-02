---
description: Create a new agent / role / skill / tool from a template
argument-hint: "<kind> [name]  — kind ∈ {agent, role, skill, tool}"
allowed-tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
---

Create a new Flue component from the bundled templates.

Arguments: $ARGUMENTS

## Dispatch

1. Parse `<kind>` and `[name]` from arguments. If `<kind>` is missing or invalid, error with the supported list (`agent`, `role`, `skill`, `tool`).
2. If `[name]` is missing, ask the user for a kebab-case name.
3. Verify the workspace exists (`.flue/` or `agents/` at cwd) — fail clearly if not, suggest `/flue:init`.
4. **For non-trivial agents**: invoke the `flue-architect` subagent first to produce a spec, then `flue-author` to write the file. For simple cases (a barebones role, a stub skill), just copy the template directly.
5. Use the appropriate template:
   - `agent` → `${CLAUDE_PLUGIN_ROOT}/templates/minimal-agent.ts.tmpl` or `rich-agent.ts.tmpl` (architect chooses)
   - `role` → `${CLAUDE_PLUGIN_ROOT}/templates/role.md.tmpl`
   - `skill` → `${CLAUDE_PLUGIN_ROOT}/templates/skill.md.tmpl`
   - `tool` → `${CLAUDE_PLUGIN_ROOT}/templates/custom-tool.ts.tmpl` (this is reference; `flue-author` adds it to an existing agent file)
6. Substitute `{{NAME}}` and any other placeholders.
7. Write to:
   - `agent` → `.flue/agents/<name>.ts`
   - `role` → `.flue/roles/<name>.md`
   - `skill` → `.agents/skills/<name>/SKILL.md`
   - `tool` → suggest the user pick which agent to add it to; flue-author edits.
8. Print the created path and a one-line next step.

## Conventions

- kebab-case for filenames; matching name in frontmatter where applicable.
- For agents, default to `webhook: true` triggers, `anthropic/claude-haiku-4-5` model, `'empty'` sandbox unless the spec demands otherwise.

## Pitfalls to avoid

- Don't put `.agents/skills/` under `.flue/` — it lives at the project root.
- Don't write trigger shapes that won't match the build regex (`/export\s+const\s+triggers\s*=\s*\{[^}]*\}/`).
- If the user wants a complex agent, dispatch flue-architect first instead of guessing.
