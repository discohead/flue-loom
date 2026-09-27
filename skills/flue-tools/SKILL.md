---
name: flue-tools
description: Use when defining or mounting tools for a Flue 2 agent — defineTool/useTool, Valibot input and output schemas, the { output, terminate } return envelope, harness tools (harness.prompt, harness.sandbox), durable tools with step.do, timeoutMs, conditional tools, built-in sandbox tools and reserved names, protecting access, and remote MCP servers via useMcpConnection.
user-invocable: false
---

# Flue tools

## Define and mount

```ts
// src/tools/lookup-order.ts
import { defineTool } from '@flue/runtime'; // or '@flue/runtime/tool' for tool-only modules
import * as v from 'valibot';

export const lookupOrder = defineTool({
	name: 'lookup_order', // unique per render; not a reserved name
	description: 'Look up one order by id and return its status and ETA.', // the model's only docs
	input: v.object({ orderId: v.string() }), // Valibot, top-level object schema
	output: v.object({ status: v.string(), eta: v.string() }), // optional; validates the return
	timeoutMs: 15_000, // optional per-call bound → ToolTimeoutError the model sees
	async run({ data, signal, log, toolCallId }) {
		log.info('lookup', { orderId: data.orderId }); // streams as a log event; model never sees it
		const order = await orders.get(data.orderId, { signal });
		return { output: { status: order.status, eta: order.eta } };
	},
});
```

```ts
// in the agent body
useTool(lookupOrder); // or an inline definition object — same validation
```

**Return contract** — `run` returns `{ output?, terminate? }`:
- `output`: any JSON-serializable value (stringified for the model). A bare `string` return is shorthand for `{ output: string }`. Returning nothing is allowed only without an `output` schema. **Any other bare value (object, array, number, boolean, `null`) throws** — wrap it: `return { output: result }`.
- `terminate: true` ends the agent's turn after this tool batch settles.
- `run({ data })` — not `input` (1.0-beta) and not `parameters`/`execute` (0.x).

Throwing inside `run` becomes a tool error the model sees (it can retry); it does not fail the submission. Invalid model arguments never reach `run` (`ToolInputValidationError` goes back to the model).

## Harness tools — model work and sandbox access inside a tool

```ts
export const reviewContract = defineTool({
	name: 'review_contract',
	description: 'Review one contract and return a structured risk report.',
	input: v.object({ contract: v.string() }),
	harness: true,
	async run({ harness, data }) {
		await harness.sandbox.writeFile('contract.md', data.contract); // throws if the agent has no sandbox
		const { data: report } = await harness.prompt('Review contract.md and assess risk.', {
			result: v.object({ risk: v.picklist(['low', 'medium', 'high']), summary: v.string() }),
			// also: tools, model, thinkingLevel, signal, images
		});
		return { output: report };
	},
});
```

`harness.prompt()` runs in the tool's own scratch conversation (continued by repeated calls; never shown to clients), uses the agent's rendered config (skills, subagents — name a skill or subagent in the prompt text to steer it), returns `{ text | data, usage, model }`, and throws `ResultUnavailableError` if the model gives up on `result`. A bounded deterministic job ("summarize", "generate a report") is best modeled as a harness tool the agent calls — Flue has no separate workflow primitive.

## Durable tools — side effects that must complete

```ts
defineTool({
	name: 'provision_workspace',
	description: 'Create the tenant, then seed default projects.',
	input: v.object({ customerId: v.string() }),
	durable: true,
	async run({ data, step }) {
		const tenant = await step.do('create-tenant', () => billing.createTenant(data.customerId));
		for (const p of DEFAULT_PROJECTS) await step.do(`seed:${p.name}`, () => projects.seed(tenant.id, p));
		return { output: { tenantId: tenant.id } };
	},
});
```

Only `durable: true` calls re-execute after a crash (completed steps replay their recorded values); an interrupted ordinary call settles with an unknown-outcome error. Rules: every side effect inside a `step.do`; deterministic, unique step names; small JSON step values; steps are at-least-once executed, so make them idempotent. With `harness: true` too, wrap `harness.prompt` in a step.

## Conditional tools

Tool presence is program logic: `if (approved) useTool(publishRelease);` — an unmounted tool cannot be called (stronger than an instruction). Changes are narrated to the model; they rewrite the tools array (prompt-cache miss) except when unlocked by a completed tool call on current Anthropic models (not Haiku). Gate on state that changes rarely.

## Built-in and reserved names

With a sandbox the agent gets `read`, `write`, `edit`, `bash`, `grep`, `glob` (limits: `read`/`bash` 2000 lines/50 KB, `grep` 100 matches, `glob` 1000 paths). The framework adds `task` (always), `activate_skill` and `read_skill_resource` (when skills exist), and `finish`/`give_up` for structured results. Those five framework names are **reserved** for custom tools; a sandbox tool name is only taken while a sandbox is attached. Reserved or duplicate names throw `ToolNameConflictError` when the tool set is assembled.

## Protect access

Tool arguments are model-chosen, not an authorization boundary. Bind the customer/repo/credential in trusted code — a closure over `useInitialData()`, or signal `attributes` read via `useDelivery()` that your verified webhook set — and let the model choose only within it. Wrap provider SDKs as narrow tools; avoid generic "call any API" tools.

## MCP servers

```ts
import { defineMcpConnection, useMcpConnection } from '@flue/runtime';

export const linear = defineMcpConnection({
	name: 'linear', // tools mount as mcp__linear__<tool>
	url: 'https://mcp.linear.app/mcp',
	auth: () => tokenStore.get(userId, 'linear'), // string, or a function resolved per request (401 → re-resolve once)
	tools: ['create_issue', 'search_issues'], // allowlist (unknown names fail the connection)
	optional: true, // run without it if unreachable (model is told) instead of failing the submission
	// transport: 'sse' for legacy servers; headers, timeoutMs, resetTimeoutOnProgress, fetch
});
// agent body: useMcpConnection(linear) or useMcpConnection({ ...linear, tools: ['search_issues'] })
```

Connections are per-submission, runtime-owned, work on Cloudflare, and can be conditional (e.g. only after an OAuth flag flips). Flue never stores tokens — you own OAuth. `createMcpConnection(def)` (Node only at module scope) returns `{ tools, close }` with each tool's server `annotations` (`destructiveHint`, …) so trusted code can filter or wrap tools (approval gates) before `useTool`. Treat third-party servers as untrusted input.

Docs: `flue docs read guide/tools`, `guide/mcp`, `reference/agent-api` (defineTool, McpConnectionDefinition), `reference/agent-behavior`.
