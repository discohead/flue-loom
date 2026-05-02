# CLAUDE.md — flue-loom maintainer notes

This file is for Claude Code (and humans) working *on* the plugin. The plugin's own skills under `skills/` are for users working in Flue workspaces.

## Repo shape

Greenfield, no monorepo machinery. Two publishable artifacts:

1. The Claude Code plugin (this directory; installed via `claude /plugin install .`)
2. `@flue-loom/mcp` — the MCP server subpackage at `mcp/`. Builds with tsdown to `mcp/dist/server.mjs`. Has its own `package.json`. The plugin manifest in `.claude-plugin/mcp.json` references the same `dist/` artifact.

The MCP server is **operator face only**. It does not contain authoring tools — those are Claude-Code-specific (skills, subagents, slash commands).

## Why slash commands use Bash + curl, not the MCP server

Inside Claude Code, slash commands have direct access to `Bash`, `Monitor`, `run_in_background`, and `KillShell`. These compose more flexibly than MCP tools (pipes, jq, backgrounding, log tailing). The MCP server is for *clients that don't have those primitives* — Claude Desktop, ChatGPT, Cursor.

This is a deliberate split. The plugin manifest registers the MCP server so CC users can also use it if they prefer typed tools, but the first-class authoring UX inside CC is the slash commands.

## Trigger lint regex

`scripts/post-edit-flue.mjs` uses the **exact same regex** as `packages/sdk/src/build.ts:283` in the upstream Flue repo. If Flue's regex changes, update this file. Pin checked: `@flue/sdk@0.3.5`.

```
/export\s+const\s+triggers\s*=\s*\{([^}]*)\}/
```

## Skills cite real Flue files

Every skill in `skills/` references real files at specific line numbers in the Flue repo. When `@flue/sdk` is bumped, skim each SKILL.md and update line numbers if needed. Symbols are stable; line numbers drift.

## Subagent tool least-privilege

Read-only subagents (architect, reviewer, explorer) must NOT have Write/Edit. Bash is for diagnostic-only subagents (debugger, explorer). Authoring subagents (author, deployer, orchestrator) get Write/Edit.

## Adding components

- New skill: `skills/<slug>/SKILL.md`. Match existing frontmatter shape (`name`, `description`).
- New subagent: `agents/<slug>.md`. Frontmatter must include `name`, `description`, `tools` (comma-separated).
- New slash command: `commands/<slug>.md`. Frontmatter: `description`, `argument-hint`, `allowed-tools`.
- New MCP tool: `mcp/src/tools/<name>.ts`. Register in `mcp/src/tools/index.ts`. Rebuild `dist/`.

## Releasing

```bash
# bump plugin version in .claude-plugin/plugin.json
# bump mcp version in mcp/package.json (track plugin)
cd mcp && pnpm build && cd ..
git add -A && git commit -m "release vX.Y.Z" && git tag vX.Y.Z
# publish MCP package: cd mcp && npm publish --access=public
```

## Dogfooding

Maintaining this plugin is a Flue-relevant activity in itself: the maintainer (you, me, future-us) gets to apply the plugin's expertise to its own dev. When extending the plugin, write a SKILL.md or test a new subagent against `examples/hello-world/` in the upstream Flue repo first.
