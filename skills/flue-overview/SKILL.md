---
name: flue-overview
description: Start here for anything Flue (withastro/flue, flueframework.com) — @flue/runtime, @flue/vite, @flue/cli, @flue/sdk, 'use agent' modules, useModel/useTool hooks, flue run. The Flue 2 mental model, package map, which flue-loom skill covers what, and how to read version-matched docs.
user-invocable: false
---

# Flue 2: the mental model

Flue is a TypeScript framework for autonomous agents built on the [Pi](https://pi.dev) agent harness. **An agent is a plain, synchronous, exported function** in a module marked `'use agent'`. Hooks called in its body compose its capabilities; the string it returns is its system instructions. The function re-renders before every model turn, like a React component.

```ts
// src/agents/triage.ts
'use agent';
import { type AgentProps, useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md';
import { searchIssues } from '../tools/search-issues.ts';

export function Triage({ id }: AgentProps) {
	useModel('anthropic/claude-sonnet-5'); // required, exactly once per render
	useSandbox(local()); // optional: files + shell (+ read/write/edit/bash/grep/glob tools)
	useSkill(triage); // progressive-disclosure expertise
	useTool(searchIssues); // application code the model can call
	return `Triage GitHub issue #${id}: reproduce, diagnose, and recommend a fix.`;
}
```

Everything is durable: every message is admitted as a **submission** to a per-conversation queue and reaches exactly one terminal outcome (`completed`/`failed`/`aborted`) through crashes and redeploys. Conversations are addressed by `(agent identity, id)`.

## Packages (all versioned together)

| Package | Role |
|---|---|
| `@flue/runtime` | Agents, hooks, tools, sandboxes, `dispatch`/`init`, routing (`/routing`), Node helpers (`/node`: `local`, `sqlite`, `start`), Cloudflare helpers (`/cloudflare`), config (`/config`) |
| `@flue/vite` | The `flue()` Vite plugin: `'use agent'` scan, dev server, builds for Node and Cloudflare |
| `@flue/cli` | `flue init`, `flue run`, `flue add`/`update` (blueprints), `flue docs` (offline docs) |
| `@flue/sdk` | **HTTP client** for one conversation URL (`createFlueClient`) — not the authoring API |
| `@flue/react` | `useFlueAgent({ url })` chat state |
| `@flue/<provider>` | Channel ingress (slack, github, …), persistence (postgres, libsql, …), `@flue/opentelemetry` |

There are **no** `flue dev`/`flue build` commands (Vite owns them), no `triggers` export, no `defineAgent`, no workflows, no roles, no `FlueContext`. If you see those, the code is pre-2.0 → `flue-migration`.

## How work gets to an agent

- **`flue run src/agents/x.ts -m "..." [--id c1]`** — run one module in-process, no server (CI, scripts, personal tools). A complete way to ship an agent, not a lesser one.
- **HTTP** — `src/app.ts` (a Hono app) mounts agents explicitly: `app.route('/agents/x', createAgentRouter(X))`; `POST /agents/x/<id>` admits a message (202), `GET` reads the conversation. `vite dev` serves it; `vite build` makes `dist/server.mjs` or a Cloudflare Worker.
- **`dispatch(Agent, { id, message })`** — from webhooks, channels, schedules; no mount needed.
- **`init(Agent, { id })` → `dispatch()`/`read()`** — await a reply in code; `start()` boots the runtime in standalone Node scripts and tests.

## Skill map

| Task | Skill |
|---|---|
| Scaffold, layout, `flue.config.ts`, `vite.config.ts`, env | `flue-project` |
| Agent modules, identity, statics, ways to run | `flue-agents` |
| State, event hooks, data writers, custom hooks | `flue-hooks` |
| Tools (harness/durable/timeout), MCP servers | `flue-tools` |
| Agent skills (`SKILL.md`), subagents | `flue-skills`, `flue-subagents` |
| Sandboxes, models/providers | `flue-sandboxes`, `flue-models` |
| `app.ts`, auth, CORS / calling agents over HTTP | `flue-routing` / `flue-client` |
| Schedules, CI, scripts, `dispatch`/`init`/`start` | `flue-workflows` |
| Crash-safety, `db.ts`, persistence | `flue-durability` |
| Slack/GitHub/… ingress | `flue-channels` |
| Node or Cloudflare deploys | `flue-node`, `flue-cloudflare` |
| Telemetry / tests & evals | `flue-observability`, `flue-testing` |
| Something is broken / upgrading old code | `flue-debugging`, `flue-migration` |

## Version-matched documentation (prefer it over memory)

flue-loom was verified against **Flue 2.1.1**. The installed `@flue/cli` ships the docs for *its* version as Markdown:

- `npx flue docs search <query>` → JSON results (`path`, `title`, `excerpt`) → `npx flue docs read <path>` (e.g. `guide/tools`). Use `pnpm exec`/`yarn`/`bunx` to match the project. Don't pipe `flue docs` (list) into `head` — 2.1.1 crashes on EPIPE; `search`/`read` are fine.
- Read-only alternative (no Bash): Grep/Read `node_modules/@flue/cli/docs/{guide,reference,sdk,cli,ecosystem}/**/*.md`.
- Valid model specifiers for the installed version: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs [filter|--check provider/model]`.
- Integrations (channels, sandboxes, databases, tooling) come as **blueprints** — Markdown guides for coding agents: `npx flue add` lists them; `npx flue add <kind> <name> --print` prints one to follow (`/flue-loom:add`).

When a skill here and the installed docs disagree, the installed docs win.
