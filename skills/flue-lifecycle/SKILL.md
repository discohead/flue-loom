---
name: flue-lifecycle
description: Use when running flue dev, flue run, flue build, configuring env files, choosing a target, or understanding the build/output flow.
---

# Lifecycle: dev, run, build

Three CLI commands, three modes of operation.

## `flue dev` — long-running watch

```bash
flue dev --target node --port 3583
flue dev --target cloudflare
```

Spawns a server, watches for file changes, rebuilds and reloads. Use during local development.

- **Node target**: rebuilds via esbuild → respawns Node process. Sub-second.
- **Cloudflare target**: regenerates `dist/_entry.ts` only on structural changes; wrangler hot-reloads workerd for body edits.

Default port: `3583` (FLUE on a phone keypad). `--env <path>` (repeatable; later wins on key collision; shell vars override file values). Always sets `FLUE_MODE=local` so trigger-less agents are invokable.

## `flue run <agent>` — one-shot

```bash
flue run hello --target node --id test-1 --payload '{}'
flue run hello --target node --id test-1 --env .env.local
```

Build → start a transient server → POST to the agent → print result → exit. Use for scripted runs and CI.

- Node-only. Cloudflare runs need a real CF environment.
- `--id` is required; it's the session id.
- `--payload` is JSON (optional).
- Sets `FLUE_MODE=local`.

## `flue build` — produce artifacts

```bash
flue build --target node
flue build --target cloudflare
```

Produces `dist/` for deployment.

- **Node**: `dist/server.mjs` (self-contained bundle via esbuild).
- **Cloudflare**: `dist/_entry.ts` + `dist/wrangler.jsonc` (no bundle; wrangler handles it).

## CLI binary — `flue.js` not `flue.mjs`

```bash
node node_modules/@flue/cli/dist/flue.js dev
# or in this repo's monorepo:
node packages/cli/dist/flue.js dev
```

The CLI build script (`packages/cli/package.json`) renames `flue.mjs` → `flue.js` after tsdown. So invoke `flue.js`. The plugin's `scripts/flue-cli.sh` handles this for you.

## Workspace + output flags

| Flag | Default | Purpose |
|---|---|---|
| `--workspace <path>` | waterfall (`./.flue/` → `./`) | Where to *read* agents/roles from |
| `--output <path>` | cwd | Where to *write* `dist/` |

When `--workspace` is explicit, no waterfall. The `--output` default is cwd because `wrangler.jsonc` (CF) and other deploy artifacts need to land where the deploy tool expects, not nested in `.flue/`.

## Env file resolution

```bash
flue dev --env .env --env .env.local
```

- Paths resolved against `--output`, not workspace.
- Files parsed via `node:util.parseEnv`.
- Order: file vars first, later files win on collision, shell `process.env` overrides everything.
- Repeatable.

## Model precedence

When `init({ model })` isn't passed and per-call `model` isn't either, Flue resolves via:

```
per-call model > role model > agent model (init) > build-time default
```

Build-time default comes from `flue.config.ts` if you ship one. Calls with no model resolved throw at runtime.

## What the bundle includes / excludes

User project deps (everything in your `package.json:dependencies`) are externalized — they get resolved at runtime from `node_modules`. Flue infrastructure (the SDK itself, hono, etc.) is bundled. This keeps deploys small and faithful to your installed versions.

`AGENTS.md`, `CLAUDE.md`, and `.agents/skills/` are **not bundled** — they're discovered at runtime from each session's `cwd`. Same deploy can run against different repos with different instructions.

## Related

- `flue-workspace-layout` — what waterfall picks
- `flue-node` / `flue-cloudflare` — what each target writes
- `flue-triggers` — `FLUE_MODE=local` and trigger gating
- `flue-debugging` — env file pitfalls
