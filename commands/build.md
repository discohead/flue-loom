---
description: Build the workspace into dist/ for deployment
argument-hint: "[--target node|cloudflare] [--output path]"
allowed-tools: ["Bash", "Read"]
---

Build the current Flue workspace.

Arguments: $ARGUMENTS

## Steps

1. Parse `--target` (default `node`) and `--output` (default cwd).
2. Resolve the CLI: `${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh`.
3. Run:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh" build --target "$target" --output "$output"
   ```
4. After completion, summarize what was produced:
   - **Node**: `dist/server.mjs` + `dist/manifest.json`
   - **Cloudflare**: `dist/_entry.ts` + `dist/wrangler.jsonc` + `dist/manifest.json`
5. Print the manifest summary (agents discovered, triggers parsed):
   ```bash
   jq -r '.agents | map("\(.name)\t\(.triggers)") | .[]' "$output/dist/manifest.json"
   ```

## Pitfalls

- Workspace not found → errors clearly with the resolution waterfall path.
- Cloudflare build failing on compat date → suggest editing `wrangler.jsonc:compatibility_date` to `"2026-04-01"`.
- Stale `dist/` from a different target → clear it (`rm -rf dist`) before switching targets.
- Missing `nodejs_compat` flag (CF) → suggest fix.

## Next steps to suggest

- For Node: `node dist/server.mjs` to run, or use `/flue:dev` for watch mode.
- For Cloudflare: `wrangler deploy --config dist/wrangler.jsonc` (or `/flue:deploy cloudflare` to use the deployer subagent).
