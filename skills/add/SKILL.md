---
name: add
description: Add an official Flue blueprint — a channel (Slack, GitHub, Discord, Linear, Stripe, …), database adapter (Postgres, Turso, Redis, …), sandbox provider (Daytona, E2B, Modal, Vercel, Cloudflare, …), or tooling (Sentry, Braintrust, vitest-evals) — by fetching its implementation guide with `flue add` and following it; also updates previously added blueprints.
argument-hint: "[channel|database|sandbox|tooling] [name | docs-url] | update <kind> <name>"
disable-model-invocation: true
allowed-tools:
  - Bash(bash *flue-cli.sh add *)
  - Bash(bash *flue-cli.sh update *)
  - Bash(node *flue-inspect.mjs *)
---

# /flue-loom:add

Arguments: `$ARGUMENTS`

Blueprints are version-matched implementation guides written for coding agents: which files to write (verbatim adapter code), dependencies, wiring, and verification. You execute them.

## 1. Choose

- No arguments → list the catalog: `bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh add` and help the user pick (kind + name).
- `<kind> <name>` → that blueprint. `<kind> <url>` → a from-scratch guide that uses the URL (provider docs, SDK reference, repo) as the starting point.
- `update <kind> <name|url>` → the updated guide for a blueprint already in the project (files carry a `// flue-blueprint: <kind>/<name>@<version>` header — grep for it to find what's installed and at which version).

## 2. Fetch

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh add <kind> <name|url> --print
bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh update <kind> <name|url> --print
```

Read the whole guide before acting. It's fetched over the network — if that fails, say so; don't reconstruct a blueprint from memory.

## 3. Execute

- Follow the guide's instructions exactly, including "write this file verbatim". Resolve its placeholders from the project (source root via `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs --no-lint`, target, package manager).
- Where the guide says to confirm with the user (unusual layout, credentials, provider choices), ask.
- Secrets: create the variable *names* the guide requires and tell the user where to set values (`.env`, `.dev.vars`, `wrangler secret put`, the provider dashboard); never write real values.
- Channels: mount the channel route in `app.ts` as instructed and point its handler at the right agent with `dispatch()`; webhook URLs must be reachable (a tunnel for local testing).
- For `update`, diff the new guide against the installed files and apply only the changes it calls for, preserving the user's edits where the guide allows.

## 4. Verify

Run the guide's own verification steps, then `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs` and `npx tsc --noEmit`. Report files added/changed, dependencies installed, variables the user must set, and how to test it end to end. Background knowledge: `flue-channels`, `flue-sandboxes`, `flue-observability`, and `flue-project` (databases).
