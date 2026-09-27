---
name: flue-testing
description: Use when testing a Flue 2 agent — unit-testing tool run functions, deterministic keyless agent tests with Pi's fauxProvider plus start()/init() in Vitest, live-model evals in-process or over HTTP with @flue/sdk, the vitest-evals blueprint with judges, and running evals in CI.
user-invocable: false
---

# Testing Flue agents

Three layers, cheapest first:

| Layer | What it proves | Model |
|---|---|---|
| Tool unit tests | your `run` logic | none |
| Deterministic agent tests | wiring: hooks, tools, state, data parts, routing of tool results | Pi `fauxProvider` (scripted, keyless) |
| Evals | the model actually behaves (calls the right tool, follows instructions) | live, costs tokens, nondeterministic |

## Setup (Vitest 5 — Vite 8 era)

```bash
npm install -D vitest@^5
npm install @earendil-works/pi-ai   # only needed for fauxProvider (match the version @flue/runtime uses)
```

```ts
// vitest.config.ts — REQUIRED: otherwise Vitest loads vite.config.ts and the flue() plugin breaks in-process tests
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

For live evals add a separate `vitest.evals.config.ts` (`include: ['src/evals/**/*.eval.ts']`, `testTimeout: 60_000`) and a `"evals": "vitest run --config vitest.evals.config.ts"` script, so paid runs never happen in the unit suite.

## Tool unit tests

```ts
import { expect, it } from 'vitest';
import { lookupOrder } from '../tools/lookup-order.ts';

it('returns the order status', async () => {
	const result = await lookupOrder.run({ data: { orderId: 'A1' }, toolCallId: 't1', log: console } as Parameters<typeof lookupOrder.run>[0]);
	expect(result).toEqual({ output: { status: 'shipped', eta: '2026-10-01' } });
});
```

Harness tools need a `harness` stub; durable tools a `step` stub (`{ do: (_name, fn) => fn() }`).

## Deterministic agent tests (fauxProvider)

Register a scripted provider in the **agent module** at module scope (so `flue run`, `start()`, and servers all see it), then drive it through the real runtime. A response factory that decides from the last message handles tool round-trips and re-queues itself:

```ts
'use agent';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setProvider, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

const faux = fauxProvider({ api: 'test-calc', provider: 'test-calc', models: [{ id: 'calc' }] });
setProvider(faux.provider);
const respond: Parameters<typeof faux.setResponses>[0][number] = (context) => {
	faux.appendResponses([respond]); // one scripted reply per model call, forever
	const last = context.messages.at(-1);
	if (last?.role === 'toolResult') {
		const text = last.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
		return fauxAssistantMessage(fauxText(`The sum is ${JSON.parse(text).sum}.`));
	}
	return fauxAssistantMessage(fauxToolCall('add', { a: 20, b: 22 }), { stopReason: 'toolUse' });
};
faux.setResponses([respond]);

export function Calc() {
	useModel('test-calc/calc');
	useTool({ name: 'add', description: 'Add two numbers.', input: v.object({ a: v.number(), b: v.number() }), async run({ data }) { return { output: { sum: data.a + data.b } }; } });
	return 'Add numbers with the add tool.';
}
```

```ts
// src/test/calc.test.ts
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { afterAll, expect, it } from 'vitest';
import { Calc } from '../agents/calc.ts';

const flue = await start({ agents: [Calc] }); // in-memory db; one runtime per test file
afterAll(() => flue.stop());

it('adds with the add tool', async () => {
	const tools: string[] = [];
	const agent = init(Calc); // no id → fresh conversation per case
	const reply = await agent.read(await agent.dispatch('add 20 and 22'), {
		onEvent: (chunk) => { if (chunk.type === 'tool-input') tools.push(chunk.toolName); },
	});
	expect(reply.text).toBe('The sum is 42.');
	expect(tools).toEqual(['add']);
});
```

Faux responses are consumed one per model call — script exactly the turns you expect, or use a self-re-queuing factory as above. For a production agent, keep the real model in the agent and put a faux-backed copy (or a `setProvider()` override registered before `start()` under the same provider id) in test-only code. Modules that import `SKILL.md` need the Flue build — test those over HTTP. flue-loom's own MCP eval fixture is a full faux-backed app to copy from.

## Live evals

- **In-process**: same `start()` + `init()` shape against the real model; provider keys from the test environment. Assert on behavior contracts (tool called, key facts, `reply.data` shape), not exact wording.
- **Over HTTP** (exercises `app.ts` routing and middleware): run `vite dev` (or target a preview deploy) and use `@flue/sdk`:

```ts
const conversation = createFlueClient({ url: `${process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:5173/agents/support'}/eval-${crypto.randomUUID()}` });
const admission = await conversation.send({ message: { kind: 'user', body: 'Is checkout operational?' } });
const reply = await conversation.read(admission);
expect(reply.text).toContain('operational');
```

- **vitest-evals**: `npx flue add tooling vitest-evals --print` generates `src/evals/harness.ts` (one SDK conversation per case), configs, and scripts; write cases with `describeEval(...)`, `toolCalls(result)`, and judges (`FactualityJudge`, `ToolCallJudge`, `StructuredOutputJudge`, `createJudge`) with a separate judge harness. Prefer deterministic assertions; add judges only for semantic checks.

## CI

Unit + faux tests on every push (no secrets). Evals as a separate job (on merge/schedule/manual) with provider keys from CI secrets; for HTTP evals build and start the app in the job or point at a preview URL. Reports (`vitest-results.json`) can contain prompts and tool payloads — review retention before uploading.

Docs: `flue docs read guide/evals`, `ecosystem/tooling/vitest-evals`, `reference/agent-api` (init, start).
