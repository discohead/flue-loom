---
name: flue-agents
description: Use when writing or editing a Flue 2 agent module — the 'use agent' directive, agent functions (synchronous, return instructions, re-render every turn), durable identity and the agentName/initialData/durability statics, AgentProps, useInstruction, and running agents via flue run, HTTP, dispatch(), init(), or start().
user-invocable: false
---

# Flue agent modules

## The contract

```ts
'use agent'; // FIRST statement — above every import
import { type AgentProps, useInstruction, useModel } from '@flue/runtime';
import * as v from 'valibot';

export function SupportAgent({ id }: AgentProps) {
	useModel('anthropic/claude-sonnet-5');
	useInstruction('Never promise refunds; escalate instead.'); // appended after the returned text
	return `You handle support ticket ${id}. Be concise and accurate.`;
}

SupportAgent.agentName = 'support-agent'; // optional: pin durable identity (string literal only)
SupportAgent.initialData = v.object({ plan: v.picklist(['free', 'pro']) }); // optional creation-data schema
SupportAgent.durability = { maxAttempts: 5, timeoutMs: 1_800_000 }; // optional retry budget
```

- **`'use agent'` must be in the directive prologue** (before imports; only comments/other directives may precede it). Anywhere else and the module is *silently not an agent* — flue-loom's lint catches this.
- **Every exported function with a capitalized name** in a marked module is an agent; a module may export several. Lowercase exports are helpers; classes and re-exports never register. A marked module with no capitalized exported function fails the build. No anonymous default exports.
- The function must be **synchronous** (returning a promise throws) and return a string or `undefined`. Async work goes in tools, `useAgentStart()`, or a sandbox factory's `createSandbox()`.
- It **re-renders before every model call**. Hook values are snapshots of that render. Don't put `Date.now()` or other churn in the instructions — each change emits an `instructions` signal and busts the prompt cache.
- Agents never call each other directly (`[flue] Re-entrant agent render.`). Share behavior with custom hooks (`flue-hooks`); delegate with `useSubagent()` (`flue-subagents`); message other *registered* agents with `dispatch()`.
- Instruction document = returned string, then each `useInstruction()` in call order, joined by blank lines.

## Identity (keys durable storage)

Identity = the build-stamped name → the `agentName` static → the function's own name. Must match `/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/` (PascalCase or kebab-case — no underscores, no leading digit) and be unique app-wide. On Cloudflare it also names the Durable Object: `SupportAgent` → class `FlueSupportAgentAgent`, binding `FLUE_SUPPORT_AGENT_AGENT`; `agentName = 'support'` → `FlueSupportAgent`/`FLUE_SUPPORT_AGENT`.

- **Renaming the function changes identity** (new, empty conversation storage; on Cloudflare a `renamed_classes` migration). Renaming the file or moving the mount changes nothing. Pin `agentName` early if you expect renames.
- Identities fold case/dashes for Cloudflare names — `IssueTriage` and `issue-triage` collide.

## `AgentProps` and data in

- `({ id })` — the conversation id: the `:id` URL segment, `dispatch({ id })`, `init(A, { id })`, or `flue run --id`. Constant for the instance. Only root agents receive props (subagents get none).
- **Creation data**: send `initialData` on the *first* contact (`dispatch({ initialData })`, HTTP body `{ "initialData": {…}, "kind": "user", "body": "…" }`, `flue run --data '<json>'`, SDK `send({ initialData })`), read with `useInitialData<T>()`. Validated once against the `initialData` static; ignored on later sends. Prefer it to parsing facts out of the id.
- **Per-message data**: `useDelivery()` returns the message in front of the model (`kind: 'user'` or `'signal'` with `attributes`). Evolving facts: `usePersistentState()`. See `flue-hooks`.

## Messages

`DeliveredMessage` is one of:

```ts
{ kind: 'user', body: string, attachments?: [{ type: 'image', data: base64, mimeType, filename? }] }
{ kind: 'signal', type: string, body: string, attributes?: Record<string, string>, tagName?: string }
```

Use `user` for a person talking 1:1 to the agent; `signal` for webhooks, schedules, and multi-party surfaces (renders as `<signal type="…" k="v">body</signal>`). A bare string is shorthand for a user message in `dispatch()`/`init()`/`flue run` — **not** on the HTTP wire.

## Running an agent (all hit the same durable path)

| Surface | How |
|---|---|
| CLI (no server) | `npx flue run src/agents/support.ts -m "Hi" [--id c1] [--data '{…}'] [--new \| --uid u] [--json] [--name Agent]` — `--name` picks one agent from a multi-agent module; `--json` prints `{ id, agent, submissionId, outcome, message \| error, uid }`; exit 0/1/130 |
| HTTP | mount in `app.ts`, then `POST <mount>/<id>` with a `DeliveredMessage` (202) and `GET <mount>/<id>` — see `flue-routing`, `flue-client`, `/flue-loom:talk` |
| In-app | `await dispatch(SupportAgent, { id, message, initialData?, uid? })` → receipt `{ submissionId, acceptedAt, uid }` (fire-and-forget) |
| Await a reply | `const h = init(SupportAgent, { id }); const r = await h.read(await h.dispatch('Hi'));` → `{ text, data, metadata, submissionId, uid }` |
| Standalone Node / tests | `await using flue = await start({ agents: [SupportAgent], db: sqlite('./x.db') })` (from `@flue/runtime/node`) before `init`/`dispatch` |

`flue run` loads only the agent module (never `app.ts`), is Node-only (modules importing `cloudflare:*` fail there), persists to `db.ts` or `node_modules/.cache/flue/run.db`, and loads `.env`.

**Conditional sends** (`uid`): omit → continue-or-create; a previous `uid` → continue only that incarnation (404 `agent_instance_not_found` otherwise); `null` → create only (409 `agent_instance_exists`, existing uid in `meta.uid`). `--new` in CI makes creation exactly-once.

## Checklist for a new agent

1. `'use agent'` first; exported PascalCase function; `useModel()` once with a specifier that exists (`node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs --check <spec>`).
2. Only the capabilities it needs (sandbox, tools, skills, subagents).
3. HTTP-reachable? Mount it in `app.ts` behind auth. Cloudflare? Append a `new_sqlite_classes` migration for `Flue<Identity>Agent`.
4. Smoke test: `npx flue run <module> -m "…"`, then `check:types`, then `vite build` if deployed.

Templates: `${CLAUDE_PLUGIN_ROOT}/templates/` (`/flue-loom:new`). Docs: `flue docs read guide/building-agents`, `reference/agent-api`, `cli/run`.
