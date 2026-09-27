# flue-loom

A Claude Code plugin — plus a portable MCP server — for building, running, debugging, and shipping agents with [Flue](https://flueframework.com) 2 ([withastro/flue](https://github.com/withastro/flue)).

Flue 2 agents are plain TypeScript functions in `'use agent'` modules, composed with hooks (`useModel`, `useTool`, `useSandbox`, `useSubagent`, …), served by Vite, and reached over durable conversation URLs. flue-loom gives Claude Code the version-matched knowledge, workflows, and guardrails to work on that model fluently, and gives every MCP host a way to talk to the agents you build.

Verified against Flue **2.1.1** and Claude Code **2.1.x**.

## What's inside

**20 knowledge skills** (loaded automatically when relevant) — agents and identity, hooks, tools (plain, harness, durable), skills, subagents, sandboxes, models, routing and auth, the HTTP client and wire protocol, workflows and schedules, durability, channels, Node and Cloudflare targets, observability, testing with faux models, debugging, and migrating from Flue 0.x / 1.0-beta. Each cites the version-matched docs that ship with `@flue/cli` (`flue docs read <path>`).

**15 commands** (`/flue-loom:<name>`):

| Command | Does |
|---|---|
| `init` | Scaffold a project with `flue init` (Node or Cloudflare), install, verify |
| `new` | Add an agent, tool, harness/durable tool, skill, subagent, MCP connection, custom hook, or test from verified templates — and wire it in |
| `dev` | Run `vite dev` in the background, wait for ready, list conversation URLs; `dev stop` |
| `run` | One-shot `flue run` against an agent module, continuing conversations by id |
| `talk` | Multi-turn conversation with a running agent (tool activity streamed) |
| `build` | `vite build` with output checks and an optional smoke test |
| `deploy` | Pre-flight + build + dry run via the deployer, then deploy after you confirm |
| `review` | Mechanical scan + a reviewer pass, findings by severity |
| `debug` | Reproduce, root-cause, fix, and verify a failing agent |
| `explore` | Map an unfamiliar Flue project |
| `compose` | Design (architect) → build (author/orchestrator) → verify a multi-agent system |
| `add` | Apply an official `flue add` blueprint (Slack/GitHub/… channels, databases, sandboxes, tooling) |
| `docs` | Answer from the docs matching your installed version |
| `migrate` | Plan and execute a pre-2.0 → Flue 2 migration, one agent at a time |
| `models` | Search and validate `provider/model` ids against the installed catalog |

**7 subagents** — `flue-architect` (designs, read-only), `flue-author` and `flue-orchestrator` (write code), `flue-reviewer` (read-only), `flue-explorer` and `flue-debugger` (diagnostic commands only), `flue-deployer` (prepares a deploy but never runs it). Each preloads the knowledge it needs.

**Hooks**
- *SessionStart* — a compact map of the Flue project you're in: target, versions, agents and their mounts, persistence, missing Cloudflare migrations, agents Flue will silently skip, pre-2.0 code that needs migrating.
- *PostToolUse (Edit/Write)* — edit-time lint using your project's own `@flue/vite` scanner: misplaced `'use agent'`, async agents, invalid or colliding identities, missing `useModel`, pre-2.0 APIs, unmounted agents, Durable Object migrations, `wrangler.jsonc`/`vite.config`/`flue.config` wiring, and Agent Skills frontmatter.

**Tools** in `scripts/` (zero dependencies, used by the commands and handy on their own): `flue-talk.mjs` (conversation client), `flue-inspect.mjs` (project report), `flue-models.mjs` (model catalog), `flue-cli.sh` (finds the project's `flue`).

**MCP server** (`flue`) — registered automatically: `flue_list_agents`, `flue_send_message` (waits with progress), `flue_read_reply`, `flue_get_conversation`, `flue_abort`, `flue_add_agent`/`flue_remove_agent`. It discovers the current project's mounts, keeps a registry of deployed agents whose credentials come only from `FLUE_*` environment variables, and runs unchanged in Claude Desktop (one-click `.mcpb`), Cursor, and other hosts. See [mcp/README.md](mcp/README.md).

## Install

Requires Node ≥ 22.19 (Flue's floor).

```text
/plugin marketplace add discohead/flue-loom
/plugin install flue-loom@flue-loom
```

Or from a local checkout: `claude --plugin-dir /path/to/flue-loom`.

For the MCP server alone in another host, see [mcp/README.md](mcp/README.md#install).

## Quickstart

```text
> /flue-loom:init my-agents --target node --deploy
> /flue-loom:new agent Support "answers order questions with a lookup_order tool"
> /flue-loom:dev
> /flue-loom:talk http://localhost:5173/agents/support/first-chat "Where is order 42?"
> /flue-loom:review
> /flue-loom:deploy
```

Or just describe what you want — "add a tool that files GitHub issues", "why does my agent 404?", "move this project to Flue 2" — and the skills, subagents, and hooks do their part.

## Layout

```
.claude-plugin/   plugin.json, marketplace.json
.mcp.json         MCP server registration (mcp/dist/server.mjs)
skills/           flue-* knowledge skills + command skills (init, new, dev, …)
agents/           specialist subagents
hooks/            SessionStart + PostToolUse wiring
scripts/          hook entry points, lint, flue-talk/inspect/models, tests
templates/        verified Flue 2 component templates used by /flue-loom:new
evals/            `claude plugin eval` suite (scripts/run-evals.sh)
mcp/              @flue-loom/mcp — the MCP server, its tests, MCPB bundle, fixture app
```

## Develop

See [.claude/CLAUDE.md](.claude/CLAUDE.md) for maintainer notes. In short:

```bash
node --test scripts/test/*.test.mjs                      # lint, hooks, CLI tools (53 tests)
cd mcp && pnpm install && pnpm build && pnpm test        # MCP server (needs eval/fixture: npm install)
claude plugin validate .claude-plugin/plugin.json --strict
scripts/run-evals.sh --runs 1                            # plugin evals (uses your Claude credential)
```

## License

MIT
