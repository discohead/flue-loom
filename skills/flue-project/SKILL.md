---
name: flue-project
description: Use when creating or configuring a Flue 2 project — flue init flags, directory layout and the .flue/ → src/ → root source-root rule, flue.config.ts fields, vite.config.ts for Node vs Cloudflare, the app.ts/db.ts/cloudflare.ts entry modules, tsconfig, package versions, and .env loading.
user-invocable: false
---

# Flue project setup

## Scaffold with `flue init` — don't hand-write the shell

```bash
npx -y @flue/cli@latest init <dir> --target node            # flue run only (no HTTP server)
npx -y @flue/cli@latest init <dir> --target node --deploy   # + vite.config.ts, src/app.ts, hono
npx -y @flue/cli@latest init <dir> --target cloudflare      # --deploy implied; + wrangler.jsonc, src/cloudflare.ts
```

- Agent shells have no TTY: **always pass `--target`**, or init fails with "cannot prompt here".
- A non-empty directory is refused without `--force` — and `--force` **overwrites every skeleton file** (`package.json`, `README.md`, `.gitignore`, `tsconfig.json`, `vite.config.ts`, `src/app.ts`, …). If any of those exist and matter, scaffold into a subdirectory (`flue init ./flue`) and fold the pieces in by hand.
- It writes files only; run the package manager's install afterwards. `/flue-loom:init` walks this flow.

Skeleton: `flue.config.ts`, `package.json`, `tsconfig.json`, `.gitignore`, `.env` (empty key placeholder), `src/agents/hello.ts` (`export function Hello()`), `AGENTS.md`, `README.md`; with `--deploy`: `vite.config.ts`, `src/app.ts`; Node: `src/db.ts` (`sqlite('./data/flue.db')`); Cloudflare: `src/cloudflare.ts`, `wrangler.jsonc` (migration for `FlueHelloAgent`).

After renaming the starter (`hello.ts` → `support.ts`, `Hello` → `Support`), also update the `app.ts` import/mount, the `wrangler.jsonc` `new_sqlite_classes` entry (`FlueSupportAgent`), and the `flue run` paths in `AGENTS.md`/`README.md`.

## Layout

```
my-app/
├─ flue.config.ts      optional project config
├─ vite.config.ts      only for HTTP deploys (vite dev / vite build)
├─ wrangler.jsonc      Cloudflare only (you own migrations)
└─ src/                the source root
   ├─ app.ts           route map — required by vite dev/build
   ├─ db.ts            persistence adapter (Node only; rejected on Cloudflare)
   ├─ cloudflare.ts    Worker-level exports/handlers (Cloudflare only)
   ├─ agents/…         'use agent' modules (any path works; the scan is by directive)
   ├─ tools/ skills/ subagents/ channels/ sandboxes/ shared/
```

**Source root**: `<root>/.flue/` if it exists, else `<root>/src/`, else the project root. First match wins and layouts never merge — an empty `.flue/` directory hijacks discovery. The `'use agent'` scan covers the whole source root (`**/*.{ts,mts,js,mjs}`), skipping `node_modules`, `dist`, `output`, `.wrangler`, and dot-directories.

## `flue.config.ts`

```ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
	target: 'node', // 'node' | 'cloudflare'; unset → auto-detect from the Vite plugin array
	// app: './src/app.ts', db: './src/db.ts', cloudflare: './src/cloudflare.ts'  (explicit entry paths)
	// agents: 'agents/**/*.ts',   // narrow the 'use agent' scan (relative to the source root)
	// providers: ['anthropic'],  // ship only these Pi providers; list is exhaustive
	// tracing: false,            // drop built-in Cloudflare agent tracing
});
```

Loaded with Node's native `import()` (Node ≥ 22.19 type stripping): erasable TypeScript only — no `enum`, no parameter properties — and no Vite aliases. Unknown fields are errors (`root`/`output` were retired; `@flue/cli/config` is gone). `flue run` ignores `target`, `agents`, `providers`.

## `vite.config.ts`

```ts
// Node
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [flue()] });
```

```ts
// Cloudflare — flue() FIRST, and cloudflare() MUST get flueWorkerConfig()
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [flue(), cloudflare({ config: flueWorkerConfig() })] });
```

Some older doc pages show bare `cloudflare()`; at 2.1.1 that fails config resolution. `flue()` accepts the same fields as `flue.config.ts` inline (inline wins per field). On Node, `vite build` forces SSR output (`dist/server.mjs` + `dist/app.mjs`, target node22) and externalizes your `package.json` dependencies.

## `app.ts` (required for `vite dev`/`vite build`)

```ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';

const app = new Hono();
app.route('/agents/support', createAgentRouter(Support));
export default app;
```

Registration comes from the `'use agent'` scan; the mount only decides HTTP exposure. `flue run` never loads `app.ts` — anything an agent needs under `flue run` (e.g. `setProvider()`, `observe()`) must live in the agent module. See `flue-routing`.

## Dependencies and TypeScript

- Node **≥ 22.19**. Runtime deps: `@flue/runtime`, `hono` (deploy), `valibot` (tool schemas — add it), `just-bash` (virtual sandbox, when used), `@earendil-works/pi-ai` (only for custom providers/faux tests). Dev: `@flue/cli`, `@flue/vite`, `vite` (^8), `typescript`, `@types/node`; Cloudflare adds `@cloudflare/vite-plugin`, `wrangler`.
- Keep all `@flue/*` packages on the same version.
- `flue init`'s tsconfig: `module: ESNext`, `moduleResolution: Bundler`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `strict`, `noEmit`, `types: ["node"]`. Use `.ts` extensions in relative imports and `import type` for types. `SKILL.md`/`.md` import types ship with `@flue/runtime`.
- `check:types` is `tsc --noEmit`.

## Environment

- `flue run` loads the project-root `.env` (`--env <file>` for another); `vite dev` loads `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`. Shell-exported values win.
- Built servers (`node dist/server.mjs`) read only the real environment. Cloudflare local dev uses `.dev.vars`; production uses `wrangler secret put`.
- Never commit `.env`; never invent API keys — leave the placeholder for the user.

Docs: `flue docs read guide/project-layout`, `reference/configuration`, `cli/init`, `guide/getting-started`.
