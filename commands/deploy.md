---
description: Deploy the workspace via flue-deployer (validates and ships)
argument-hint: "[--target cloudflare|node]"
allowed-tools: ["Task", "Read", "Bash"]
---

Deploy the current Flue workspace by dispatching the `flue-deployer` subagent.

Arguments: $ARGUMENTS

## Dispatch

Invoke the `flue-deployer` agent (Task tool, `subagent_type: flue-deployer`) with this brief:

> Deploy the current workspace at `<cwd>` to target `<target>` (from arguments, default cloudflare).
> Run pre-flight checks. Confirm with the user before any irreversible action. Report results.

## Why use the subagent

- Validates compat date, `nodejs_compat`, DO bindings, migrations, secrets.
- Pauses at confirmation gates before destructive ops.
- Has Bash for `wrangler deploy`, Edit for `wrangler.jsonc` if needed.
- Surfaces deploy URLs and verification steps after success.

## What happens

1. Subagent verifies the build artifact exists; runs `/flue:build` first if not.
2. For Cloudflare: validates `dist/wrangler.jsonc`, runs `wrangler deploy --dry-run`, asks for confirmation, then deploys.
3. For Node: builds, validates `ANTHROPIC_API_KEY`, hands off (Node deploy is operator-defined).
4. Reports the deploy URL (CF) or next-step instructions (Node).

## Pitfalls

- Cloudflare without `wrangler` installed → subagent will say so. Run `pnpm add -D wrangler` first.
- Missing Worker secret `ANTHROPIC_API_KEY` → subagent prompts for `wrangler secret put`.
- User edited `dist/wrangler.jsonc` directly → subagent will detect drift; the source `wrangler.jsonc` is the truth.
