---
name: flue-sandboxes
description: Use when a Flue 2 agent needs files or a shell — useSandbox, the in-memory just-bash virtual sandbox via bash(), local() host access on Node, remote sandbox adapters (Daytona, E2B, Modal, Vercel, Cloudflare Sandbox/Computer) via flue add sandbox, cwd and workspace discovery, conditional attachment, env and network allowlists, and harness.sandbox.
user-invocable: false
---

# Sandboxes

An agent has **no environment unless it calls `useSandbox()`** (at most once per render). Attaching one adds the `read`/`write`/`edit`/`bash`/`grep`/`glob` tools, workspace context in the system prompt (cwd, directory listing, `AGENTS.md`), workspace skills from `<cwd>/.agents/skills/`, a shared environment for subagents, and `harness.sandbox` for harness tools. Without one, `harness.sandbox` throws. Pick the narrowest environment that works.

## Virtual sandbox — in-memory, isolated (default choice)

```ts
'use agent';
import { bash, useModel, useSandbox } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash'; // add just-bash to dependencies

export function DataWorker() {
	useModel('anthropic/claude-haiku-4-5');
	useSandbox(
		bash(
			() =>
				new Bash({
					fs: new InMemoryFs({ '/data/catalog.csv': exportCatalogCsv() }), // optional seed files
					network: { allowedUrlPrefixes: ['https://api.example.com/'] }, // curl is opt-in
				}),
		),
	);
	return 'Answer questions about /data/catalog.csv.';
}
```

Emulated bash in TypeScript (ls, sed, awk, jq, sort, pipes, curl…); no real processes, no host access. **Ephemeral**: rebuilt fresh each time the runtime initializes the agent for new work — keep durable facts in `usePersistentState`, durable files in a durable workspace adapter. The factory is lazy: construct it freely in render; the expensive `createSandbox()` runs once per initialization. A beta agent that relied on the old implicit sandbox must now declare this explicitly.

## `local()` — the host machine (Node only)

```ts
import { local } from '@flue/runtime/node';
useSandbox(local({ cwd: '/srv/checkouts/app', env: { GH_TOKEN: process.env.GH_TOKEN } }));
```

Real filesystem and real processes; **no isolation** — for dev tools, CI jobs, coding agents, self-hosted automation, or inside a container you already trust. The shell gets only an allowlist of essentials (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, …); pass anything else explicitly via `env` (`undefined` removes a default). `env: { ...process.env }` hands the model every secret — don't. Snapshot taken at construction. `local()` on Cloudflare fails (no host).

## Remote sandboxes

```bash
npx flue add sandbox daytona --print   # blueprint → src/sandboxes/daytona.ts + provider SDK
npx flue add                           # list: boxd, cloudflare, cloudflare-computer, daytona, e2b, exedev, islo, mirage, modal, vercel, …
npx flue add sandbox https://docs.provider.dev --print   # generic guide for an unlisted provider
```

Adapters are thin: your code creates/reuses/deletes provider sandboxes; Flue never destroys provider infrastructure. Create lazily **inside** `createSandbox(options)` — never at module scope — and key on `options.id` (the conversation id) to give each conversation a durable workspace:

```ts
useSandbox({
	async createSandbox(options) {
		const sandbox = await findOrCreate(options.id); // provider SDK
		return daytona(sandbox).createSandbox(options);
	},
});
```

An adapter may replace the default tool set via a `tools` factory (e.g. keep `read`/`write`/`edit`, swap shell tools) — check the adapter's docs before assuming `bash` exists. Cancelling a command rejects promptly, but most providers keep running it remotely.

Cloudflare: container-backed `cloudflareSandbox(getSandbox(env.Sandbox, id))` from `@flue/runtime/cloudflare` (needs `@cloudflare/sandbox`, a Sandbox DO export in `cloudflare.ts`, binding + container + migration in `wrangler.jsonc`, a Dockerfile); or durable SQLite-backed Cloudflare Computer (`flue add sandbox cloudflare-computer`). See `flue-cloudflare`.

## `cwd`, context, and conditional attachment

- `useSandbox(factory, { cwd: '/workspace' })` sets where commands run and where `AGENTS.md`/skills are discovered (resolved once per submission). A `task` call can point a child at another cwd — never another sandbox.
- Presence may be conditional: `if (investigating) useSandbox(local({ cwd: '/srv/repro' }))`. A flip swaps the environment at the next turn boundary (narrated as an `environment` signal; file tools come and go; prompt cache invalidated). Swapping factory A→B while staying attached only takes effect next submission.

## `harness.sandbox` (harness tools)

`exec(cmd, { signal, env, cwd })` → `{ stdout, stderr, exitCode }`, `readFile`, `readFileBuffer`, `writeFile` (creates parent dirs), `stat`, `readdir`, `exists`, `mkdir`, `rm`, `cwd`, `resolvePath`. Not recorded in the conversation — for staging inputs and collecting outputs the model shouldn't see. It's a live getter; don't cache it across turns if the agent swaps environments.

Docs: `flue docs read guide/sandboxes`, `reference/sandbox-api`, `guide/node-target` (local), `ecosystem/sandboxes/<provider>`.
