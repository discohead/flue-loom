---
name: flue-workflows
description: Use when driving Flue 2 agents from code rather than chat — dispatch() receipts, init() handles with dispatch/read/abort, start() for standalone Node scripts and tests, cron schedules on Node (croner) and Cloudflare (Cron Triggers), flue run in CI (GitHub Actions, GitLab), multi-agent pipelines, and durable orchestration with Cloudflare Workflows, Inngest, or Temporal.
user-invocable: false
---

# Workflows: programs that run agents

Flue has no workflow primitive (`defineWorkflow` is gone). A "workflow" is any program that sends messages to agents. Pick the smallest surface:

| Where the code runs | Use |
|---|---|
| Terminal / CI step | `flue run <module> -m "…" [--id] [--new] [--json]` |
| Inside the Flue app (route, cron, channel, tool) | `dispatch()` or `init()` |
| Standalone Node script / test | `start()` then `init()` |
| Another service talking to a deployment | `@flue/sdk` (`flue-client`) |
| Must survive its own crashes across steps | your platform's durable workflow engine calling `init()`/SDK per step |

## `dispatch()` — fire and forget

```ts
import { dispatch } from '@flue/runtime';
const receipt = await dispatch(Reporter, {
	id: 'daily-summary', // conversation; created on first contact
	message: { kind: 'signal', type: 'schedule', body: 'Prepare the daily summary.', attributes: { at: new Date().toISOString() } },
	initialData: { team: 'eng' }, // only when this send creates the instance
	// uid: undefined (continue or create) | '<uid>' (continue only) | null (create only)
	// idempotencyKey: providerDeliveryId, // redelivered events converge on one submission
});
// → { submissionId, acceptedAt, uid }
```

Resolves at durable admission (before the model runs). Needs no mount; bypasses HTTP middleware. A dispatch to a busy conversation joins the live response at the next turn boundary. Delivery is at-least-once — make external effects idempotent.

## `init()` — await the reply

```ts
import { init } from '@flue/runtime';
const summarizer = init(Summarizer, { id: `summary-${caseId}` }); // no I/O; omit id for a fresh throwaway conversation
const receipt = await summarizer.dispatch(text); // or { message, initialData }
const reply = await summarizer.read(receipt, { onEvent: (chunk) => {} }); // { text, data, metadata, submissionId, uid }
// failed/aborted → AgentRunError { outcome, submissionId, cause }; read(receipt, { signal }) only cancels the local wait
await summarizer.abort(); // durable abort of running + queued work
```

`read()` is re-attachable from any process (persist the receipt). **Never `read()` your own instance from inside its tool** — it deadlocks (the delivery joins the response that's waiting on the tool); use `harness.prompt()` there.

## `start()` — the runtime outside a server

```ts
// scripts/nightly.ts — run with node (type stripping) or tsx
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Reporter } from '../src/agents/reporter.ts';

await using flue = await start({ agents: [Reporter], db: sqlite('./nightly.db') }); // omit db → in-memory
const reporter = init(Reporter, { id: `nightly-${new Date().toISOString().slice(0, 10)}` });
console.log((await reporter.read(await reporter.dispatch('Produce the nightly report.'))).text);
```

One runtime per process (a second `start()` throws; inside a server just call `init()`). `providers` option replaces the default provider set. Scripts don't read `db.ts` — pass `db` explicitly. Plain-Node imports can't resolve `SKILL.md` imports (build-only) — use `flue run` or HTTP for agents that import skills.

## Schedules

- **Node**: an in-process cron in `app.ts` module scope (`croner`: `new Cron('0 9 * * *', { timezone: 'America/New_York', protect: true, catch: console.error }, () => dispatch(...))`). Fires under `vite dev` too (gate on an env var) and in every replica (gate to one). Missed fires during downtime are not replayed.
- **Cloudflare**: `"triggers": { "crons": ["0 9 * * *"] }` in `wrangler.jsonc` (UTC) + a `scheduled(controller)` handler in the default export of `src/cloudflare.ts` that calls `dispatch()` (`controller.cron` tells which fired). Keep it thin: dispatch and return. For timers inside one conversation, use `extend({ base })` + `this.scheduleEvery()` (`flue-cloudflare`).
- **Platform cron** (Fly, Render, Railway): POST a signal to the mounted conversation URL with a scheduler credential checked by middleware.
- Fixed id → one continuing conversation with memory and state; per-fire id (`daily-${date}`) → independent, bounded runs.

## CI with `flue run`

```yaml
# .github/workflows/triage.yml (excerpt)
- run: npm ci
- run: >
    npx flue run src/agents/triage.ts
    --message "Triage issue #${{ github.event.issue.number }}."
    --id "issue-${{ github.event.issue.number }}" --new --json > triage.json
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

stdout is only the reply (or the `--json` envelope `{ id, agent, submissionId, outcome, message|error, uid }`); logs go to stderr; exit 0/1/130. `--new` + a deterministic id makes a retried job unable to double-create. Chain agents in shell: `summary=$(npx flue run a.ts -m … --json | jq -r .message)`. Conversations persist in `db.ts` or `node_modules/.cache/flue/run.db` (cache it between CI runs if continuity matters). See `flue docs read ecosystem/deploy/github-actions` / `gitlab-ci`.

## Multi-agent pipelines

- In one conversation, fan work out to delegates → `useSubagent` (`flue-subagents`).
- Across registered agents, orchestrate in code: `const plan = await planner.read(await planner.dispatch(task)); await coder.dispatch(\`Implement:\n${plan.text}\`)`.
- An agent that messages another agent: a tool calling `dispatch(OtherAgent, …)` (or an `init()` handle for another instance).

## Durable orchestration

Put each `dispatch()` and each `read()` in its **own** step so the receipt is checkpointed and a retried read re-attaches instead of re-prompting:

```ts
// src/cloudflare.ts — Cloudflare Workflow in the same Worker
export class NightlyReview extends WorkflowEntrypoint {
	async run(event, step) {
		const agent = init(Reviewer, { id: `nightly-${event.payload.date}` });
		const receipt = await step.do('dispatch', () => agent.dispatch('Review the nightly findings.'));
		const review = await step.do('read', async () => { const r = await agent.read(receipt); return { text: r.text, data: r.data }; });
		await step.do('file', () => fileReport(review));
	}
}
```

Same shape in Inngest (`step.run`) or Temporal (activities). A crash inside the dispatch step can re-send: use `uid: null` (create-only) when duplicates must be rejected.

Docs: `flue docs read guide/workflows`, `guide/schedules`, `reference/agent-api` (dispatch, init, start), `cli/run`.
