# Flue API mapping → 2.x

## 0.x (handler + `init()` + sessions) → 2.x

| 0.x | 2.x |
|---|---|
| `.flue/agents/<name>.ts` default-exported `async ({ init, payload, env, id }: FlueContext) => …` | `'use agent'` module; `export function Name({ id }: AgentProps) { …hooks…; return instructions }` — synchronous; any path under the source root (`.flue/` still works as a source root) |
| agent name = filename | identity = function name (or `Name.agentName = 'kebab'`); filename irrelevant |
| `import … from '@flue/sdk/client'` | `import … from '@flue/runtime'` (`/node`, `/cloudflare`, `/routing`, `/config`) |
| `export const triggers = { webhook: true }` | `app.route('/agents/name', createAgentRouter(Name))` in `src/app.ts` |
| `triggers: { cron: '0 9 * * *' }` | Node: `new Cron(...)` in `app.ts` → `dispatch()`; Cloudflare: `"triggers": { "crons": [...] }` + `scheduled()` in `src/cloudflare.ts` → `dispatch()` |
| trigger-less + `FLUE_MODE=local` | `flue run <module>` (no server) or registered-but-unmounted (dispatch-only) |
| `init({ model })` | `useModel('provider/model', { thinkingLevel, compaction })` — exactly once per render |
| `init({ sandbox: 'empty' })` | nothing (no sandbox, no file tools) — or `useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })))` for scratch files |
| `init({ sandbox: 'local' })` | `useSandbox(local())` from `@flue/runtime/node` |
| `BashFactory` `() => new Bash(...)` | `useSandbox(bash(() => new Bash(...)))` |
| `SandboxFactory { createSessionEnv }` | `{ createSandbox(options) }` (`createSessionEnv` is a deprecated alias) |
| CF `getSandbox(env, id)` passed as sandbox | `useSandbox(cloudflareSandbox(getSandbox(env.Sandbox, id)))` |
| `init({ cwd })` | `useSandbox(factory, { cwd })` |
| `init({ tools: [...] })` / per-call `tools` | `useTool(tool)` per tool (conditional allowed); per-operation extras: `harness.prompt(text, { tools })` |
| `init({ role })`, `.flue/roles/<r>.md` | subagent definition (`useSubagent({ name, description, agent: RoleFn, model })`), or `useInstruction(roleText)` / a custom hook; role `model` → subagent `model` or conditional `useModel` |
| `init({ persist: store })` | `src/db.ts` default-exporting a `PersistenceAdapter` (`sqlite()`, `@flue/postgres`, …); Cloudflare: automatic |
| `agent.session(id)` / `agent.sessions.*` | one conversation per agent instance id; callers address it (HTTP `:id`, `dispatch({ id })`, `flue run --id`) |
| `await session.prompt(text, { result: schema })` in the handler | model-driven turn from the delivered message; code-driven structured work → a `harness: true` tool: `await harness.prompt(text, { result })` |
| handler `return { … }` → HTTP `{ result }` | reply = assistant text (+ `useDataWriter` data parts, tool outputs); callers read it with SDK `read()` / `init().read()` / `flue run` stdout |
| `session.skill('name', { args })` | `useSkill(import …/SKILL.md)`; the model activates it (steer by naming it in instructions or `harness.prompt` text); pass args in the message |
| `session.task(prompt, { cwd, role, model })` | `useSubagent(...)` + the model-driven `task` tool (child gets `cwd`); host-directed: harness tool naming the subagent |
| `session.shell(cmd)` | `harness.sandbox.exec(cmd)` inside a harness tool |
| `Type.Object({...})` tool `parameters` | Valibot `input: v.object({...})` |
| `execute: async (args, signal) => string` | `run: async ({ data, signal, log, toolCallId }) => ({ output }) \| string` |
| `connectMcpServer(name, { url, transport, headers })` + `close()` | `useMcpConnection({ name, url, transport, auth, headers, tools })` (runtime-owned) or `createMcpConnection()` on Node |
| built-in tool names `read/write/edit/bash/grep/glob/task` | same file tools (only with a sandbox); reserved: `task`, `activate_skill`, `read_skill_resource`, `finish`, `give_up` |
| `.agents/skills/<name>/SKILL.md` discovered from cwd | still discovered from the **sandbox** cwd (needs `useSandbox`); prefer imported `SKILL.md` (build-validated) |
| `flue dev --target node --port 3583` | `vite dev` (port 5173) |
| `flue build --target cloudflare` → `dist/_entry.ts`, `dist/wrangler.jsonc` | `vite build` → `dist/<worker>/wrangler.json`; `wrangler deploy` from the root (no `--config`) |
| `flue build --target node` → `dist/server.mjs` | `vite build` → `dist/server.mjs` (port 3000, env only) |
| `flue run <agent> --target node --id x --payload '{…}'` | `flue run src/agents/x.ts --id x -m "…" [--data '{…}']` |
| `--env` resolved against `--output` | `flue run --env <file>`; `vite dev` loads `.env*`; built servers: real env |
| `FlueContext<TPayload, TEnv>` payload/env typing | message via `useDelivery()`, creation data via `useInitialData<T>()` + `Agent.initialData` schema, env via `process.env` / `import { env } from 'cloudflare:workers'` |
| HTTP `POST /agents/:name/:id` (sync JSON / `x-webhook` 202 / SSE `text_delta`, `result`) | `POST <mount>/:id` with `{ kind: 'user', body }` → 202 `{ streamUrl, offset, submissionId, uid }`; `GET <mount>/:id[?view=updates&offset=…&live=sse]` |
| `GET /agents` manifest, `GET /health` | none — add your own routes in `app.ts` |
| wrangler: Flue auto-added DO bindings + migrations | you own migrations (`new_sqlite_classes: ["Flue<Name>Agent"]`); never hand-write `FLUE_*_AGENT` bindings; compat date ≥ 2026-04-01 |
| model precedence per-call > role > agent > build default | one `useModel` per render (submission-scoped); overrides on subagent definitions and `harness.prompt({ model })` |

## 1.0-beta → 2.x (summary of the official guide)

| 1.0-beta | 2.x |
|---|---|
| `export default defineAgent(async ({ id, env }) => ({ model, instructions, tools, skills, subagents, sandbox, cwd, durability }))` | `'use agent'` + `export function Name({ id }: AgentProps)`: `useModel`, returned instructions, `useTool`, `useSkill`, `useSubagent({ name, description, agent })`, `useSandbox(factory, { cwd })`; `Name.durability = {…}` static |
| `thinkingLevel`, `compaction` config | `useModel(model, { thinkingLevel, compaction })` |
| `defineAgentProfile`, `profile`, `actions` | `defineSubagent`; custom hooks; tools (`harness: true`) |
| async initializer / `ctx.env` | synchronous function; async work in tools/`useAgentStart`/`createSandbox`; env from `process.env` or `cloudflare:workers` |
| `app.route('/', flue())` auto-router, `src/agents/` discovery | explicit `createAgentRouter()` mounts; registration by `'use agent'` scan anywhere in the source root |
| `export const route`, `export const attachments` | Hono middleware before the mount; attachments route on every mounted agent |
| POST body `{ message: "…", images }`, `?wait` | `{ kind: 'user', body, attachments? }` + optional `initialData`, `uid`; no `?wait` |
| `defineWorkflow`, `invoke()`, runs, `/workflows/*`, `client.workflows.*`, `useFlueWorkflow` | `init(Agent, { id })` → `dispatch()` + `read()`; `durable: true` tools with `step.do`; or your platform's workflow engine |
| `run({ input })`, bare return values | `run({ data })`, `return { output }` (bare string OK; `terminate: true` ends the turn) |
| `harness.session()`, `harness.fs` | `harness.prompt()`, `harness.sandbox` |
| implicit virtual sandbox | none — declare `useSandbox(bash(...))` explicitly |
| `import x from './s.md' with { type: 'skill' }` | `import x from './s/SKILL.md'`; other `.md` imports are strings → `defineSkill({ instructions })` |
| `dispatch({ agent: 'name', … })`, `dispatchId` | `dispatch(AgentFn, { id, message, initialData, uid })`; `submissionId` |
| `flue build`/`flue dev`, `@flue/cli/config`, `root`/`output` config | `vite build`/`vite dev`; `@flue/runtime/config`; delete `root`/`output` |
| `.flue/db.ts`, connection-string adapters | `<source-root>/db.ts`; adapters wrap your own driver (`postgres({ query, transaction, close })`) |
| `registerProvider()`, `registerApiProvider()` | `setProvider(createProvider({...}))` (Pi); Workers AI: `cloudflareBindingProvider()` |
| channel `conversationKey()`/`parseConversationKey()`, auto-served `src/channels/` | `instanceId()`/`parseInstanceId()`; mount `channel.route()` in `app.ts` |
| observability `run_start`/`run_end`, `runId`, `createOpenTelemetryObserver` + `observe()` | `agent_start`/`agent_end`/`submission_settled`, `instanceId`/`submissionId`, `createOpenTelemetryInstrumentation()` + `instrument()` |
| `createFlueClient({ baseUrl })`, `client.agents.send(name, id, …)` | `createFlueClient({ url: '<mount>/<id>' })` per conversation: `send/read/wait/observe/history/abort` |
| `@flue/react` `FlueProvider`, `useFlueAgent({ name, id })` | `useFlueAgent({ url })` or `({ client })` |
| Cloudflare `FlueRegistry`, `Flue<Name>Workflow` classes, `.flue/cloudflare.ts` | `deleted_classes` for them; `src/cloudflare.ts`; `run_worker_first` covering your real mounts |
| `flue run name --input '{…}' --server …` | `flue run <module-path> -m "…" --data '{…}'` (in-process only; use the SDK for servers) |
