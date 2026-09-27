---
name: flue-hooks
description: Use when composing Flue 2 agent behavior with hooks — the rules of hooks, conditional resources, usePersistentState, useInitialData, useDelivery, useDispatchMessage, useDataWriter, the event hooks (useAgentStart, useAgentFinish, useResponseStart, useResponseFinish), and custom hooks. For useModel/useTool/useSandbox/useSkill/useSubagent see their own skills.
user-invocable: false
---

# Flue hooks

All hooks come from `@flue/runtime`: `useModel` (required), `useSandbox`, `useTool`, `useMcpConnection`, `useSkill`, `useSubagent`, `useInstruction`, `usePersistentState`, `useInitialData`, `useDelivery`, `useDispatchMessage`, `useDataWriter`, `useAgentStart`, `useAgentFinish`, `useResponseStart`, `useResponseFinish`.

## Rules of hooks

- Call hooks **only while the agent function renders** — in its body or a custom hook it calls. In a tool's `run`, an event callback, or module scope they throw `[flue] <hook>() was called outside an agent function.`
- Renders are **pure reads**: setters/writers/dispatchers returned by hooks throw if called during render — call them from tool `run` functions and event callbacks.
- **Conditional and reorderable**: `useTool`, `useSkill`, `useSubagent`, `useMcpConnection` (takes effect next submission), `usePersistentState`, the four event hooks, and `useSandbox` *presence*. Changes are narrated to the model as `resources`/`environment` signals.
- **Exactly once**: `useModel` (argument may vary). **At most once**: `useSandbox`. **Identical every render**: `useDataWriter` names (a delta throws).
- Duplicate names in one render throw (tools, MCP servers, skills, subagents, state names, data parts).
- **Submission-scoped** (read when a submission starts; later renders take effect next submission): `useModel` values, the `useSandbox` factory/`cwd`, `useMcpConnection` definitions. **Per-render**: tool/skill/subagent sets and instructions.
- In a **subagent render** these throw: `useModel`, `useSandbox`, `useMcpConnection`, `usePersistentState`, `useDataWriter`, `useDispatchMessage`, and all event hooks. `useInitialData()` returns `undefined`; `useDelivery()` returns the task prompt.

## Persistent state — durable, per instance

```ts
const [phase, setPhase] = usePersistentState<'triage' | 'fix' | 'done'>('phase', 'triage');
useTool({ name: 'finish_triage', description: 'Call when triage is complete.', async run() { setPhase('fix'); } });
if (phase === 'fix') useTool(applyPatch); // capabilities follow state
```

- JSON values only; `undefined` throws (no unset). The default is never persisted. Keyed by name.
- Use the **updater form** for read-modify-write: `setCount((n) => n + 1)` — the render value is a stale snapshot.
- Writes are silent (no re-render mid-run) and commit **atomically with the tool batch or hook seam** that made them — the right guard for one-shot side effects (set `sent: true` in the same tool that sends the email).
- Evolving facts → state; creation facts → `useInitialData()`; per-message facts → `useDelivery()`.

## Reading input

- `useInitialData<T>()` — creation data, validated by the `initialData` static; `undefined` when none was sent (type it `T | undefined` then).
- `useDelivery()` — the `DeliveredMessage` currently in front of the model; advances as joined messages arrive. Read trusted `attributes` (set by your verified webhook/channel code) instead of trusting model-chosen arguments.

## `useDispatchMessage()` — self-dispatch

Returns `(message) => Promise<DispatchReceipt>` bound to this instance. A dispatch to a busy instance joins the live response at the next turn boundary; each call is a real, durable delivery (fires `useAgentStart` again) — guard with state to avoid loops.

## `useDataWriter()` — structured data to clients

```ts
const writeCard = useDataWriter('orderCard', { schema: v.object({ orderId: v.string(), status: v.string() }) });
// in a tool's run:
writeCard({ orderId: data.orderId, status: 'loading' });
```

One-way and model-invisible; each write streams immediately as a `data-orderCard` part (later writes update it in place) and lands on `AgentReply.data`/SDK `read().data`. Declare unconditionally.

## Event hooks

| Hook | When | Contract |
|---|---|---|
| `useAgentStart(async (ctx) => …)` | once per delivered message, before the model reads it | awaited, may be async; `ctx.harness`, `ctx.append(signal)`, `ctx.log`, `ctx.signal`. Load data, seed files, set state. Sibling callbacks run concurrently. |
| `useAgentFinish(async (ctx) => …)` | at every would-stop point | awaited; `ctx.response.toolCalls/usage`; `ctx.append({ kind: 'signal', type, body })` sends the model back to work (max 32 continuations per response). |
| `useResponseStart((ctx) => ({…}))` | once, true start of a response | **synchronous**; returned object deep-merges into message `metadata` |
| `useResponseFinish((ctx) => ({…}))` | once, true end | synchronous; `ctx.response.usage` is final — stamp token counts/cost for the client |

A throwing callback fails the submission. Callbacks run **at least once** (durable effects never duplicate; external effects might) — guard emails/pages with persistent state. Reserved signal types (`resources`, `instructions`, `environment`, `stream_interrupted`, `stream_continued`, `submission_aborted`, `submission_interrupted`, `compaction`, `memory`) are rejected.

```ts
useAgentStart(async () => {
	if (customer) return; // load once per conversation
	setCustomer(await crm.lookup(id));
});
useAgentFinish((ctx) => {
	if (!ctx.response.toolCalls.some((c) => c.tool === 'file_report' && !c.isError)) {
		ctx.append({ kind: 'signal', type: 'reminder', body: 'File the report with file_report before finishing.' });
	}
});
```

## Custom hooks

Plain functions named `use…` that call hooks — they record exactly as if inlined. Bundle a capability (tools + skills + instructions + gating state) once and reuse it across agents:

```ts
export function useGitHub(repo: string) {
	useMcpConnection({ name: 'github', url: 'https://api.githubcopilot.com/mcp/', auth: () => tokens.github(repo) });
	useInstruction(`You work in ${repo}. Open PRs; never push to main.`);
}
```

A state machine is just state + conditional hooks: one `phase` value, and each phase mounts its own model, tools, and skills.

Docs: `flue docs read guide/agent-hooks`, `reference/agent-hooks-api`.
