---
name: flue-observability
description: Use when monitoring Flue 2 agents — the in-process runtime event stream via observe(), event families and correlation ids, token usage and cost from turn events, tool logs, instrument() integrations for OpenTelemetry, Sentry, and Braintrust, Cloudflare Workers Traces and createCloudflareTracing, and content/PII policy for exported telemetry.
user-invocable: false
---

# Observability

Two surfaces — don't confuse them:
- **Conversation stream** (product): one conversation's render-ready messages over HTTP — `@flue/sdk` `observe()`/`history()` (`flue-client`).
- **Runtime event stream** (operations): every agent's activity in this process — `observe()` from `@flue/runtime`. Telemetry, metering, and alerting belong here.

## `observe()`

```ts
// src/app.ts (module scope) — or the agent module if it must also run under `flue run`
import { observe } from '@flue/runtime';

observe((event) => {
	if (event.type === 'submission_settled' && event.outcome === 'failed') {
		console.error(`[${event.agentName}] ${event.submissionId} failed:`, event.error?.message);
	}
	if (event.type === 'turn' && event.response.usage) {
		metrics.increment('llm.cost', event.response.usage.cost.total, { agent: event.agentName, model: event.request.requestedModel });
	}
	if (event.type === 'log') logger.log(event.level, event.message, { ...event.attributes, conversation: event.conversationId });
});
```

- Subscribers run synchronously on the emit path: branch on `type` and return fast; queue heavy work. Throws are contained. Events are frozen snapshots.
- Live-only and isolate-scoped: no replay; on Cloudflare each conversation's Durable Object sees only its own activity.
- Every event carries `v: 3`, `eventIndex`, `timestamp`, and correlation ids: `agentName`, `conversationId`, `instanceId`, `submissionId`, `operationId`, `turnId`, `taskId`. `submissionId` matches the SDK's admission and messages.

| Events | Meaning |
|---|---|
| `submission_settled` | terminal outcome (`completed`/`failed`/`aborted`) — **alert on this**, not on nested errors the agent may recover from |
| `agent_start`/`agent_end`/`idle` | loop lifecycle |
| `operation_start`/`operation` | prompt/skill/task/shell/compact boundaries with rolled-up usage |
| `turn_start`/`turn_request`/`turn`/`turn_messages` | model calls; `turn.response.usage` = `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`; `turn_request` (full prompt) is in-process only |
| `tool_start`/`tool`, `task_start`/`task`, `compaction_start`/`compaction` | tools, delegations, compaction |
| `message_*`, `text_delta`, `thinking_*` | live progress (not authoritative) |
| `log` | lines written by tools/hooks via `ctx.log.info/warn/error` (never seen by the model) |

Sum usage at one level only (`turn` leaves, or `operation` roll-ups). Live observations add `errorInfo` (classified type, stack) that is never persisted.

## Integrations (`instrument()` = observer + execution interceptor for spans)

```bash
npx flue add tooling sentry --print       # issues for terminal failures, Sentry Logs, optional AI traces
npx flue add tooling braintrust --print   # content-bearing LLM traces for inspection/evals
```

```ts
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';
instrument(createOpenTelemetryInstrumentation({ content: false /* or { transform } */, contentBudgetBytes: 200_000 }));
```

GenAI semantic-convention spans: `invoke_agent`, `chat`, `execute_tool`. One instrumentation per kind (`InstrumentationAlreadyInstalledError`); integrations compose with plain observers.

## Cloudflare

Enable `"observability": { "enabled": true, "traces": { "enabled": true } }` in `wrangler.jsonc`. Each response runs as one DO invocation, so Workers Logs/Traces attribute agent work correctly; Flue's built-in tracing adds agent spans with conversation content **by default**. Customize once at `app.ts` scope — `instrument(createCloudflareTracing({ content: false }))` (replaces the default) — or drop it with `tracing: false` in `flue.config.ts`. Workerd caps span attributes at 64 KiB (content budget 56 KiB, tighten-only there).

## Content policy

Trace adapters capture prompts, tool arguments/results, and outputs by default; installing an exporter is the consent point. Decide explicitly: `content: false`, or a `transform(content, scope)` that redacts or drops by `scope.contentType`. Image bytes are never exported; `turn_request` never leaves the process; the Cloudflare adapter never ships raw error messages/stacks.

Inside an agent, `useResponseFinish(({ response }) => ({ totalTokens: response.usage.totalTokens }))` stamps per-response usage onto message metadata for clients (`flue-hooks`).

Docs: `flue docs read guide/observability`, `reference/events`, `ecosystem/tooling/{opentelemetry,sentry,braintrust}`.
