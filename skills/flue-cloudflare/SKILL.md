---
name: flue-cloudflare
description: Use when targeting Cloudflare for deployment, configuring wrangler.jsonc, debugging compatibility date issues, or understanding the DO + Sandbox Container architecture.
---

# Cloudflare deployment

Targeting Cloudflare means each webhook agent becomes a Durable Object class, and sandboxes (when used) come from the `@cloudflare/sandbox` package backed by CF Containers.

## Build behavior

`packages/sdk/src/build-plugin-cloudflare.ts:24` declares:

```typescript
bundle: 'none'
entryFilename: '_entry.ts'
```

Flue writes `dist/_entry.ts` as a TypeScript source file. **Wrangler does the bundling**, not esbuild. Pre-bundling on top of wrangler caused subtle resolution issues with `nodejs_compat` modules — this is intentional.

The plugin also produces `dist/wrangler.jsonc` by merging your project root's `wrangler.jsonc` with Flue's required additions.

## Required `wrangler.jsonc` shape

Minimal:

```jsonc
{
  "name": "my-agents",
  "main": "dist/_entry.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      // Flue auto-adds bindings for each webhook agent.
      // You add Sandbox bindings if you use CF Containers.
      {
        "name": "Sandbox",
        "class_name": "Sandbox"
      }
    ]
  },
  "containers": [
    // If you use sandboxes, declare the container here
  ]
}
```

Two non-negotiables, validated at build time in `packages/sdk/src/cloudflare-wrangler-merge.ts`:

1. **`compatibility_date >= "2026-04-01"`** — older dates break. Pin or upgrade.
2. **`nodejs_compat` flag** — required for Flue's runtime polyfills.

## DO migrations

Flue auto-generates DO migration entries (one per webhook agent) and merges them into `wrangler.jsonc:migrations`. **Migrations are append-only and tag-deduped** — Flue tracks which migration tags it has already added so re-builds don't duplicate. Don't manually edit Flue-managed migration entries; remove the agent and rebuild instead.

## CF Sandbox / Containers

If your agent uses sandboxes:

```typescript
import { getSandbox } from '@cloudflare/sandbox';

export default async function ({ init, env }: FlueContext) {
  const sandbox = getSandbox(env, ctx.id);
  const agent = await init({ sandbox });
}
```

Flue's CF build plugin detects `getSandbox(env, ...)` shape via the `resolveSandbox` hook and wires it as a `SessionEnv`. Your `wrangler.jsonc` must declare:
- A `Sandbox` Durable Object binding
- A `containers` entry with the `Sandbox` class

See `examples/assistant/.flue/agents/assistant.ts` for a working pattern.

## Sessions on Cloudflare

Default session store is DO SQLite (per-agent DurableObject). Survives across worker invocations. Multi-region considerations: DOs are pinned to a region; cross-region calls add latency. For multi-region session reads, you'll need to design around the DO model or override `init({ persist: customStore })`.

## Cron triggers on Cloudflare

`triggers: { cron: '0 9 * * *' }` puts the cron in Flue's manifest, but **does not auto-wire `wrangler.jsonc:triggers.crons`**. You add those yourself, then your Worker's `scheduled()` handler routes to the agent. This separation is deliberate — cron concerns are deploy-platform-owned.

## Deploy

```bash
flue build --target cloudflare
cd dist  # or wherever --output points
wrangler deploy
```

Wrangler reads the merged `dist/wrangler.jsonc`.

## Common pitfalls

- Compat date too old → build fails. Update to `2026-04-01` or later.
- Missing `nodejs_compat` → build warns; runtime errors on Node-API usage.
- Hand-editing migration entries → next build dedupes by tag and may overwrite.
- Using `'local'` sandbox on CF → throws.
- Pre-bundling with esbuild → don't. Let wrangler handle it.

## Related

- `flue-sandboxes` — Sandbox DO binding setup
- `flue-triggers` — webhook vs cron on CF
- `flue-lifecycle` — `flue build --target cloudflare`
- `flue-deployer` (subagent) — automated deploy validation
