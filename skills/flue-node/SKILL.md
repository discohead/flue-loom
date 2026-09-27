---
name: flue-node
description: Use when targeting or deploying Flue 2 on Node.js — vite dev (port 5173), vite build to dist/server.mjs, vite preview, PORT (default 3000), environment and secrets, externalized dependencies, local() sandbox, sqlite()/db.ts persistence, CORS, multi-replica ownership, and hosting on Docker, Fly, Render, Railway, AWS, or SST.
user-invocable: false
---

# Node.js target

## Develop, build, run

```bash
npx vite dev                 # app.ts via Vite's module graph on :5173; hot reload; re-scans 'use agent' changes
npx vite build               # → dist/server.mjs (self-starting) + dist/app.mjs (non-listening, embeddable)
npx vite preview             # serves the BUILT artifact with production behavior — a faithful pre-deploy check
PORT=8080 node dist/server.mjs   # default port 3000
```

- `vite dev` loads `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local` (shell wins), restarts on `flue.config.*` edits, and applies permissive localhost CORS. A persistent dev DB lives at `node_modules/.cache/flue/dev.db` unless `db.ts` exists.
- The built server reads **only the real environment** (no `.env`) and has **no CORS layer** — add Hono `cors()` in `app.ts` for cross-origin browsers.
- The build externalizes your `package.json` dependencies: ship `dist/` **with** `node_modules` (or install in the image). Flue forces SSR output, `node22` target, `.mjs` names; `build.outDir` (default `dist`) and `build.sourcemap` stay yours.
- Node ≥ 22.19. There are no `flue dev`/`flue build` commands.

In Claude Code, run `vite dev` in the background with output to a log, then poll for `Local:` (or use `/flue-loom:dev`); talk to agents with `/flue-loom:talk` or the flue MCP tools.

## State

Without `db.ts` the built server uses **in-memory SQLite**: a restart loses every conversation and queued submission. Before deploying anything real:

```ts
// src/db.ts
import { sqlite } from '@flue/runtime/node';
export default sqlite('./data/flue.db'); // single host; mount a persistent volume
```

For host loss or multiple replicas use an ecosystem adapter (`npx flue add database postgres --print`). **One live owner per conversation** — shared databases enable replacement, not active-active: route each conversation id to one replica (sticky routing) and avoid overlapping owners during rollouts. A replacement recovers interrupted work at startup and via lease scans. See `flue-durability`.

## `local()` sandbox (Node only)

`useSandbox(local({ cwd?, env? }))` gives the agent the real filesystem and shell of the host — no isolation; only essential env vars pass through unless you add them to `env`. Use in trusted hosts/containers/CI. See `flue-sandboxes`.

## Secrets

Supply provider keys (`ANTHROPIC_API_KEY`, …) through the host's secret mechanism; locally `set -a; source .env; set +a; node dist/server.mjs`. Never bake keys into images or commit `.env`.

## Hosting

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
```

Build `dist/` first (or add a build stage with dev deps). Persist `./data` (sqlite) on a volume or use an external database. Platform guides: `flue docs read ecosystem/deploy/{node,docker,fly,render,railway,aws,sst}`. In-process cron (`croner` in `app.ts`) runs in every replica — gate it to one or use the platform's scheduler (`flue-workflows`).

## Checklist before shipping

- [ ] `db.ts` with a durable adapter (or accept process-lifetime state).
- [ ] Every mounted agent behind auth middleware; CORS configured if browsers call cross-origin.
- [ ] `npm run check:types`, `npx vite build`, `npx vite preview` smoke test (`/flue-loom:talk` against it).
- [ ] Provider keys present in the runtime environment; `node_modules` shipped with `dist/`.
- [ ] Single owner per conversation if running more than one replica.

Docs: `flue docs read guide/node-target`, `guide/deploy`, `ecosystem/deploy/node`.
