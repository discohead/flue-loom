---
name: deploy
description: Ship a Flue 2 project — flue-deployer runs pre-flight checks, the build, and a dry run and returns a plan; you confirm with the user, run the deploy, and verify the live agent.
argument-hint: "[cloudflare|node|<platform>] [--env <name>]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
---

# /flue-loom:deploy

Arguments: `$ARGUMENTS`

## 1. Readiness (subagent)

Spawn the `flue-loom:flue-deployer` agent (Agent tool) with:

> Prepare the Flue project at `<project root>` for deployment. Target/platform: `<from arguments, else detect>`. Environment: `<--env value or default>`. Run the full pre-flight, build, and dry run; apply only safe additive config fixes; return the readiness report and the exact deploy plan. Do not deploy.

## 2. Decide with the user

Show the pre-flight results, any changes the deployer made, and the plan. If anything is ❌, stop and help fix it first (`/flue-loom:debug`, or apply the proposed patches with the user's OK). Otherwise ask for explicit confirmation — naming what goes live, where, and how reversible it is — before running anything that changes remote state.

## 3. Deploy (main conversation, after a yes)

- **Cloudflare**: secrets first if missing (`npx wrangler secret put <NAME>` — the user types the value at the prompt; never pass it on the command line or through the conversation), then `npx wrangler deploy` from the project root (it follows `.wrangler/deploy/config.json` to the built config). Not logged in → the user runs `npx wrangler login` themselves.
- **Node platforms**: run the platform's own deploy command from the plan (Docker build/push, `fly deploy`, Render/Railway via git push, …) or hand the user the steps when it needs their credentials or UI.

## 4. Verify

- Send one message to a deployed conversation URL: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-talk.mjs https://<host><mount>/deploy-check -m "ping" --json` (add `--token-env <VAR>` for protected routes).
- Point the user at logs: `npx wrangler tail` (Cloudflare) or the platform's log stream; tracing per `flue-observability`.
- Report the URL(s), what changed, and rollback options (`npx wrangler rollback`, redeploying the previous image/commit).

Never skip the dry run, never deploy without the user's go-ahead in this conversation, and never edit `dist/` or `.wrangler/` by hand.
