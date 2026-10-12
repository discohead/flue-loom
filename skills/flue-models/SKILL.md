---
name: flue-models
description: Use when choosing or configuring the model behind a Flue 2 agent — useModel specifiers (provider/model-id) and validating them against the installed catalog, thinkingLevel, compaction settings, changing models mid-conversation, provider API keys, custom providers and gateways via setProvider/createProvider, trimming providers, and keyless Cloudflare Workers AI.
user-invocable: false
---

# Models and providers

```ts
useModel('anthropic/claude-sonnet-5', {
	thinkingLevel: 'medium', // 'off' | 'minimal' | 'low' | 'medium' (default) | 'high' | 'xhigh' | 'max'
	compaction: { reserveTokens: 30_000, keepRecentTokens: 16_000, model: 'anthropic/claude-haiku-4-5' }, // or false
});
```

- **Required, exactly once per render**, in the body or a custom hook. Not callable in subagent renders (set `model`/`thinkingLevel` on the `useSubagent` definition).
- Specifier = `'<provider-id>/<model-id>'`; everything after the first `/` is the provider's id (`openrouter/moonshotai/kimi-k2.6`, `cloudflare/@cf/moonshotai/kimi-k2.6`). An unknown specifier fails the submission before any request.
- **Validate against the catalog of the installed version** (Flue pins its Pi model catalog; a model newer than the install won't resolve):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs --check anthropic/claude-sonnet-5
node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs anthropic/ --details   # ctx window, output limit, reasoning, image input
```

  Flue 2.1.1 (pi-ai 0.83) Anthropic ids include `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-opus-5`, `claude-fable-5`. Sensible defaults: Haiku 4.5 for high-volume/simple agents and subagents, Sonnet 5 for tool-using agents, Opus 5 / Fable 5 for hard reasoning. `https://flueframework.com/models.json` lists the *latest* release's catalog.

- `thinkingLevel` only reaches models marked reasoning-capable; `harness.prompt()` and subagent definitions can override it per operation.
- Compaction triggers at `contextWindow − reserveTokens` (default model-aware, ≤ 20 000), keeps the last 8 000 tokens verbatim, summarizes the rest. `compaction: false` disables threshold compaction only (overflow recovery still compacts).

## Changing models

The specifier may be computed from state (`useModel(escalated ? 'anthropic/claude-opus-5' : 'anthropic/claude-haiku-4-5')`), but model settings are **submission-scoped**: a change computed mid-response applies to the *next* submission. There is no per-message model parameter on `dispatch()` or HTTP.

## Credentials

Keys come from the environment — never from agent code: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, … (Pi's naming). Local: `.env` (loaded by `flue run` and `vite dev`); Cloudflare local: `.dev.vars`; deployed: host secrets / `wrangler secret put`. Never invent keys.

## Custom providers and gateways

Providers are Pi objects registered with `setProvider()` at module top level (add `@earendil-works/pi-ai` to dependencies). Put the registration in **`app.ts`** for servers — but `flue run` never loads `app.ts`, so an agent that must also work under `flue run` registers in its own module.

```ts
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

setProvider(
	createProvider({
		id: 'ollama',
		auth: { apiKey: { name: 'Ollama (keyless)', resolve: async () => ({ auth: {} }) } },
		models: [{ id: 'llama3.1:8b', name: 'Llama 3.1 8B', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
		api: openAICompletionsApi(),
	}),
);
// useModel('ollama/llama3.1:8b')
```

Route a built-in through a gateway by registering under the **same id** with the catalog models re-pointed: `models: anthropicProvider().getModels().map((m) => ({ ...m, baseUrl }))` with `anthropicMessagesApi()` (imports from `@earendil-works/pi-ai/providers/anthropic` and `/api/anthropic-messages.lazy`). Model metadata is trusted: `reasoning: false` drops thinking, `input: ['text']` strips images, `contextWindow: 0` disables threshold compaction. `registerProvider()`/`registerApiProvider()` no longer exist.

Ship fewer providers with `flue({ providers: ['anthropic'] })` (or the `providers` config field) — the list is exhaustive; on Cloudflare include `'cloudflare'` to keep Workers AI.

## Cloudflare Workers AI (Cloudflare target only)

`useModel('cloudflare/@cf/moonshotai/kimi-k2.6')` — no API key; billed to the Worker account; requires `"ai": { "binding": "AI" }` in `wrangler.jsonc`. Routed through AI Gateway by default; customize with `setProvider(cloudflareBindingProvider({ binding: env.AI, gateway: { id: 'my-gateway' } | false }))` from `@flue/runtime/cloudflare/workers-ai` in `app.ts`. From any target, `cloudflare-workers-ai/…` and `cloudflare-ai-gateway/…` are ordinary catalog providers using `CLOUDFLARE_API_KEY`.

## Tests

Deterministic, keyless model for tests and demos: Pi's `fauxProvider()` + `setProvider(faux.provider)` — see `flue-testing`.

Docs: `flue docs read guide/models`, `reference/provider-api`, `reference/agent-hooks-api` (useModel, CompactionConfig).
