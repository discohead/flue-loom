---
name: flue-debugging
description: Use when something in a Flue 2 project fails — an agent missing from the scan or unreachable over HTTP, build or dev-server errors, 400/404/409/503 error envelopes, model or API-key failures, tool/skill/hook validation errors, stuck, failed, or aborted submissions, and Cloudflare wrangler/migration problems. Gives the diagnostic flow, commands, and an error-type catalog.
user-invocable: false
---

# Debugging Flue

## 1. Locate the failing surface

`flue run` (in-process, no app.ts) · `vite dev` (Node dev server :5173 / workerd) · built server (`node dist/server.mjs` :3000, real env only) · deployed Worker. Reproduce on the smallest one: `npx flue run <module> -m "…" --json` isolates the agent from routing, middleware, and deploy config.

## 2. Static checks (cheap, catch most problems)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs          # project map: target, versions, scanned agents, mounts, migrations, lint findings
npm run check:types                                          # or: npx tsc --noEmit
node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs --check <provider/model>
```

flue-inspect uses the project's own `@flue/vite` scanner when installed, so its agent list matches what `vite build` registers. The edit-time lint (PostToolUse hook) reports the same problems per file as you edit.

## 3. Runtime evidence

- **Dev server log** (`vite dev` output): `[flue] Application load failed: …` (module/import error; requests get 503 `runtime_unavailable` until fixed), scan errors, provider errors.
- **Conversation state**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-talk.mjs <url> --history --all` shows hidden/diagnostic messages (interruption advisories), tool calls with errors, and `settlements` with typed errors.
- **CLI**: `flue run --json` → `{ outcome, error: { message, type?, details?, dev? } }`; exit 1 failed, 130 aborted.
- **In-process**: a temporary `observe((e) => { if ('errorInfo' in e && e.errorInfo) console.error(e.type, e.errorInfo) })` in the agent module (works under `flue run`) or `app.ts` shows classified errors with stacks; `turn` events with `isError` expose provider failures (`response.error`, `providerFinishReason`).
- Error envelopes carry `dev` guidance in local dev; production 500s carry `error.ref` / `flue-error-ref` to match the server log line `[flue] [err_…]`.

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent absent from scan / `dispatch()` rejects it / `flue run` finds no agent | `'use agent'` not first; function not exported or lowercase; re-exported from another module; file outside the source root (an empty `.flue/` dir hijacks it) or in `dist`/dot dirs; `agents` glob in config excludes it | move the directive above imports; `export function PascalName`; define it where it's exported; check source root with flue-inspect |
| Build error "exports no agents" / "anonymous function" / "agentName must be statically readable" / invalid identity / duplicate identity / identifiers collide | scan rules | named capitalized export; literal `X.agentName = 'kebab-name'`; identities `^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$`, unique, and distinct after case/dash folding |
| `[flue] Agent functions must be synchronous.` | `async function Agent` | move awaits into tools / `useAgentStart` / `createSandbox` |
| `… requires a model. Call useModel(…)` | no `useModel` in the render | add exactly one (custom hooks count) |
| `[flue] useX() was called outside an agent function.` | hook inside a tool `run`, a callback, or module scope | call hooks only in the render; use the returned setter/writer inside callbacks |
| Setter/writer throws during render; `useDataWriter` delta error | writes are callback-only; data-writer names must be identical every render | move writes into tools/hooks; declare writers unconditionally |
| Unresolved model / provider error on first turn | specifier not in the installed catalog; `providers` list excludes it; missing `*_API_KEY` | `flue-models.mjs --check`; add to `providers`; set the key (`.env` for `flue run`/`vite dev`, real env for built servers, `wrangler secret put`/`.dev.vars` on Cloudflare) |
| `ToolNameConflictError` | reserved (`task`, `activate_skill`, `read_skill_resource`, `finish`, `give_up`) or duplicate name (incl. sandbox tools) | rename |
| Tool error "wrap it as { output: … }" | `run` returned a bare object/array/number | `return { output: value }` (strings are fine) |
| `ToolInputValidationError` loops | model can't satisfy the schema | clarify description/field docs; loosen the schema |
| `ToolTimeoutError` / submission hangs then `submission_timeout` | hung tool ignoring `signal` | pass `signal` to I/O; set tool `timeoutMs`; tune `Agent.durability` |
| `This agent has no sandbox` | `harness.sandbox` or file tools without `useSandbox` | attach one (`flue-sandboxes`) |
| `ResultUnavailableError` | model called `give_up` on `harness.prompt({ result })` | improve prompt/schema; handle the error |
| Tool `read()`s its own instance and never returns | deadlock by design | use `harness.prompt()` inside tools |
| `SubagentNotDeclaredError` / `delegation_depth_exceeded` | undeclared delegate name / nesting > 4 | declare with `useSubagent`; flatten |
| Skill not activating / build error on `SKILL.md` | description too vague; frontmatter invalid (name ≠ dir, > 64/1024 chars); secrets or symlinks in the skill dir | fix frontmatter; name the skill in instructions |
| HTTP 404 **without** envelope | nothing mounted at that path | check `app.route('<path>', createAgentRouter(Agent))` + `/<id>` |
| 404 `stream_not_found` | reading a conversation that never received a message | POST first; check the id |
| 400 `invalid_request` | bare-string body; `uid` + `initialData`; `initialData` fails the schema; `?wait`; bad `tagName`/`offset` | send `{ "kind": "user", "body": "…" }`; fix the combination |
| 409 `agent_instance_exists` / 404 `agent_instance_not_found` | `uid: null` on an existing id / stale `uid` | continue with `meta.uid`, or drop the condition |
| 503 `runtime_unavailable` | dev runtime reloading or failed to load | retry; read the dev log |
| Works locally, CORS fails in prod | dev servers add CORS; deployed apps don't | Hono `cors()` exposing `Stream-Next-Offset`, `Stream-Up-To-Date`, `Location` |
| Conversations vanish after restart | no `db.ts` on Node (in-memory) | `sqlite()` or an adapter (`flue-durability`) |
| `flue run --id x` "remembers" old turns | `run.db` cache persists | use a fresh id or delete `node_modules/.cache/flue/run.db` |
| `PersistedFormatVersionError` | database stamped by another Flue version (rollback/pre-2.0) | restore the matching version or start a fresh database |
| CF: "not receiving Flue's Worker configuration" / plugin order error | bare `cloudflare()` or `cloudflare()` before `flue()` | `plugins: [flue(), cloudflare({ config: flueWorkerConfig() })]` |
| CF: wrangler rejects deploy / "class not exported" / migration errors | missing `new_sqlite_classes` for `Flue<Name>Agent`; removed agent without `deleted_classes`; rename without `renamed_classes`; legacy `new_classes` | fix append-only migrations (`flue-cloudflare`) |
| CF: `db.ts` rejected, `local()` fails, `cloudflare:*` import fails under `flue run`, Worker won't boot after adding MCP | Node-only features on Workers; module-scope `createMcpConnection()` | remove `db.ts`; use `bash()`/Cloudflare sandboxes; test with `vite dev`; use `useMcpConnection()` |
| Submission settles `failed` with `submission_retry_exhausted`/`submission_interrupted` | repeated crashes/interruptions; `meta.interruptedTools` lists unknown-outcome calls | fix the crash; make side-effecting tools `durable: true` |

Harmless noise: rolldown's "module level directive may not be preserved" warning on `'use agent'` during `vite build` (identity is stamped anyway); Node's `ExperimentalWarning: SQLite`. `npx flue docs | head` crashes with EPIPE in 2.1.1 — use `flue docs search`.

## When to stop and ask

State what you checked and ruled out; ask for the one missing artifact (dev-server log, `--json` envelope, `--history --all` output, wrangler error). Don't delete databases, caches, or deployed resources without confirmation. If the fault is in Flue itself, say so and point at https://github.com/withastro/flue/issues.

Docs: `flue docs read reference/errors`, `sdk/errors`, `reference/streaming-protocol`, `reference/agent-behavior`.
