# flue-loom

A Claude Code plugin and MCP server that turn Claude Code (and any other MCP host) into a deep operator of the [Flue SDK](https://github.com/withastro/flue).

Flue is "Claude Code as an SDK" — a framework for building Claude-Code-like agents that run on Node or Cloudflare. **`flue-loom` inverts the relationship**: it teaches Claude Code (the agent) to author, deploy, compose, and converse with Flue agents (the substrate) through natural language.

## Two faces

**Authoring** (Claude Code only)
- 14 progressive-disclosure skills covering the full SDK surface
- 7 specialist subagents (architect, author, reviewer, debugger, deployer, orchestrator, explorer)
- 11 slash commands for the agent lifecycle
- Workspace detection on session start; trigger-shape lint on edit

**Operating** (any MCP host — Claude Code, Claude Desktop, ChatGPT desktop, Cursor, …)
- Bundled MCP server (`@flue-loom/mcp`) that speaks to any Flue HTTP endpoint
- `flue_list_agents`, `flue_invoke_agent`, `flue_stream_agent`, endpoint registry
- Works against `flue dev` locally or a deployed Cloudflare Worker URL

The two faces are deliberately split: inside Claude Code, slash commands compose `flue` + `curl` + `Monitor` + `run_in_background` directly because the unix toolbelt is more flexible than typed MCP tools. Outside Claude Code, MCP is the only portable interface.

## Install

In Claude Code:

```bash
claude /plugin install /path/to/flue-loom
```

In Claude Desktop / ChatGPT desktop / Cursor (operator face only — uses the bundled MCP server):

```json
{
  "mcpServers": {
    "flue-loom": {
      "command": "node",
      "args": ["/path/to/flue-loom/mcp/dist/server.mjs"]
    }
  }
}
```

After publish to npm:

```json
{
  "mcpServers": {
    "flue-loom": { "command": "npx", "args": ["-y", "@flue-loom/mcp"] }
  }
}
```

## Quickstart

```bash
# scaffold a workspace
mkdir my-agents && cd my-agents
claude
> /flue:init node
> /flue:new agent greeter
> /flue:dev

# in another claude session (or claude desktop)
> /flue:talk greeter
```

## Layout

```
.claude-plugin/    plugin manifest + MCP wiring
skills/            14 SKILL.md modules (progressive disclosure)
agents/            7 specialist subagents
commands/          11 slash commands
hooks/             SessionStart workspace detection + PostToolUse trigger lint
scripts/           shell + node helpers (detection, lint, sse-invoke, flue-cli)
templates/         workspace + agent + role + skill scaffolds
mcp/               @flue-loom/mcp — MCP server subpackage
```

## Status

v0.1.0 — alpha. Built against `@flue/sdk@0.3.5`. Requires `flue` CLI on PATH or in workspace `node_modules/.bin`.

## License

MIT
