# flue-loom — maintainer notes

For Claude Code (and humans) working *on* the plugin. The plugin's own skills are for users working in Flue projects.

## Repo shape

No monorepo machinery. Two deliverables:

1. **The plugin** (repo root). `.claude-plugin/plugin.json` + `marketplace.json`; everything else is auto-discovered: `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`. There is no `commands/` directory — commands are skills with `disable-model-invocation: true`. Don't add a top-level `bin/` (it blocks claude.ai/Cowork installs).
2. **`@flue-loom/mcp`** (`mcp/`). TypeScript → tsdown → `mcp/dist/server.mjs`, self-contained and **committed**: `.mcp.json` runs it straight from the plugin install, where there's no `node_modules`.

## Flue version pin

Verified against Flue **2.1.1** — `TESTED_FLUE_VERSION` in `scripts/lib/flue-project.mjs`. When Flue moves:

- Read the upstream CHANGELOG and the docs shipped in `@flue/cli` (`node_modules/@flue/cli/docs/`). Skills cite doc paths (`flue docs read guide/tools`), not source line numbers.
- Re-verify the templates: instantiate every `templates/*.tmpl` into a scratch Flue project and run `tsc --noEmit`, `vitest run`, `vite build`, and the lint.
- Keep the heuristic scanner in `flue-project.mjs` (`hasAgentDirective`, `collectAgentsHeuristic`) aligned with `@flue/vite`'s `scanAgentModuleCode`; the lint prefers the project's own scanner (`@flue/vite/internal`) when installed, and `scripts/test/lint.test.mjs` checks parity against `mcp/eval/fixture`.
- Durable Object names mirror `@flue/vite`: `agentClassName` / `agentBindingName`.
- Bump `@flue/sdk` in `mcp/`, rebuild, rerun its tests.

## Skills

- Knowledge skills: `skills/flue-<topic>/SKILL.md`, `user-invocable: false`, a description that says when to use it.
- Command skills: `skills/<command>/SKILL.md` → `/flue-loom:<command>`; `disable-model-invocation: true`, `argument-hint`, and `allowed-tools` only for read-only or plugin-owned helpers (`Bash(node *flue-inspect.mjs *)`). The model can't invoke command skills, so a flow that reuses another points at its file (`${CLAUDE_PLUGIN_ROOT}/skills/init/SKILL.md`).
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill and agent bodies — reference scripts and templates through it.

## Subagent least privilege

| Role | Agents | Tools |
|---|---|---|
| Read-only | architect, reviewer | Read, Glob, Grep, Skill |
| Diagnostic | explorer, debugger | + Bash (no Write/Edit) |
| Authoring | author, orchestrator | + Write, Edit (no Bash) |
| Deploy prep | deployer | Write, Edit, Bash — never runs the real deploy; `/flue-loom:deploy` confirms with the user and runs it |

`skills:` preloads use bare names (they resolve against this plugin first). Plugin agents ignore `hooks`, `mcpServers`, and `permissionMode`. Other components address agents as `flue-loom:<agent>`.

## Hooks

Exec form in `hooks/hooks.json` (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/…"]`). Hook scripts always exit 0, never block an edit, and stay fast — `session-start.mjs` is heuristic-only (~70 ms); only the edit lint loads the project's scanner.

## MCP server

- `@modelcontextprotocol/server` v2 with `serveStdio` (answers 2025 `initialize` and 2026 `server/discover`), zod 4 schemas, `@flue/sdk` for the conversation protocol. Every dependency is a devDependency inlined by tsdown; `pnpm build` also regenerates `dist/THIRD_PARTY_LICENSES.md`.
- Error results are text only — never `structuredContent`, which strict clients validate against `outputSchema` even on errors.
- Credentials come only from registry entries naming `FLUE_*` environment variables; never accept tokens as tool arguments.

## Tests and evals

```bash
(cd mcp/eval/fixture && npm install)          # deterministic Flue app (faux models) used by both suites
node --test scripts/test/*.test.mjs           # helpers, lint (+ scanner parity), hooks, flue-inspect/models/talk
cd mcp && pnpm install && pnpm build && pnpm check:types && pnpm test
claude plugin validate .claude-plugin/plugin.json --strict   # `validate .` checks the marketplace instead
scripts/run-evals.sh --runs 1                 # plugin evals; costs model usage
```

Plugin evals (`evals/<case>/case.yaml`):

- `scripts/run-evals.sh` runs them from a copy without `node_modules` — the harness grants file reads one by one and installed `node_modules` overflow the child's argument list (`E2BIG`) — and passes `--scaffold` (each case's `scaffold.sh` copies its `fixture/` into the run workspace), `--trust-plugin`, and `--allow-tools Write Edit`.
- Prefer regex graders targeted at files (`target: { source: file, path: … }`) and checklist-style `llm` criteria ("PASS if all of … otherwise FAIL"). `focus: trace` misses files written by subagents.

## Releasing

1. Bump the version in `.claude-plugin/plugin.json`, `mcp/package.json` (tracks the plugin), and `SERVER_VERSION` in `mcp/src/constants.ts`.
2. `cd mcp && pnpm build && pnpm test`; run the script tests; validate the plugin.
3. Add a `CHANGELOG.md` entry, commit, tag `vX.Y.Z`.
4. Publish the MCP server (`cd mcp && npm publish --access=public`) and attach `pnpm pack:mcpb`'s `flue-loom-X.Y.Z.mcpb` to the GitHub release.

## Dogfooding

Develop with the plugin loaded (`claude --plugin-dir .`): `mcp/eval/fixture` and `evals/*/fixture` are real Flue projects the hooks and commands recognize — try new skills and lint rules there first.
