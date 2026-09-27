---
name: build
description: Build a Flue 2 project for production with `vite build` (Node server bundle or Cloudflare Worker + generated wrangler config), check the output, and optionally smoke-test the built server.
argument-hint: "[--smoke]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(npx tsc --noEmit *)
  - Bash(npx vite build *)
  - Bash(npx wrangler deploy --dry-run *)
---

# /flue-loom:build

Arguments: `$ARGUMENTS`

Flue 2 has no `flue build`: `vite build` with the `flue()` plugin produces the artifact. Background: `flue-node`, `flue-cloudflare`.

## Steps

1. **Pre-flight** — `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs`. Fix ✗ findings first (scan errors fail the build). Cloudflare: every agent needs a `new_sqlite_classes` migration entry (inspect reports missing ones). Type-check with `npx tsc --noEmit` (or `check:types`); `vite build` does not type-check.
2. **Build** from the project root: `npx vite build` (or the project's `build` script — on Cloudflare the `deploy` script also deploys, so don't use that one here).
3. **Check the output**:
   - **Node** → `dist/server.mjs` (self-starting; `PORT`, default 3000), `dist/app.mjs` (importable app), a shared chunk. Dependencies stay external: ship `node_modules` (production deps) with `dist/`.
   - **Cloudflare** → `dist/<worker>/index.js` plus the merged `dist/<worker>/wrangler.json` (one `Flue<Name>Agent` Durable Object binding per agent) and `.wrangler/deploy/config.json` redirecting `wrangler deploy` to it. Local variables are copied to `dist/<worker>/.dev.vars` for `vite preview` — keep `dist/` out of git (the scaffold's `.gitignore` does). Validate without credentials: `npx wrangler deploy --dry-run`.
   - `"use agent" … module level directive may not be preserved` warnings are expected noise.
4. **Smoke test** (with `--smoke`, or when the user wants proof):
   - Node: start `PORT=3199 node dist/server.mjs` in the background, wait for `Server listening`, send one message with `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-talk.mjs http://localhost:3199<mount>/smoke-1 -m "ping"` (needs a model key in the shell environment — built servers never read `.env`), then stop it with `TaskStop`. `npx vite preview` serves the same artifact with dev-style CORS.
   - Cloudflare: the dry run is the smoke test; `npx vite preview` runs the built Worker locally.
5. **Report** artifacts, warnings, and the next step (`/flue-loom:deploy`).

## Common failures

- `[flue] No app entry found` → the project has no `app.ts` (Node without `--deploy`); add one or stay on `flue run`.
- Cloudflare: `cloudflare()` without `flueWorkerConfig()`, or `flue()` not listed before it, fails validation — see `flue-cloudflare`.
- Node `build.outDir` safety check → don't point the output at the project root or `src/`.
