---
description: Scaffold a new Flue workspace at the current directory
argument-hint: "[target?]  (node | cloudflare; default: node)"
allowed-tools: ["Bash", "Read", "Write"]
---

Scaffold a new Flue workspace at the current working directory.

Arguments: $ARGUMENTS

## Steps

1. Determine target from `$ARGUMENTS` (default: `node`).
2. Verify cwd is empty enough to scaffold safely. If `package.json` already exists, ask the user before overwriting; if `.flue/` already exists, error out.
3. Copy `${CLAUDE_PLUGIN_ROOT}/templates/workspace/` to cwd (preserving directory structure).
4. If target is `cloudflare`, also copy `${CLAUDE_PLUGIN_ROOT}/templates/wrangler.jsonc.tmpl` → `./wrangler.jsonc` and edit `package.json` to add `wrangler` to devDeps.
5. Replace `{{NAME}}` placeholder in `package.json` with the basename of cwd (or ask the user for a name).
6. Print next-step suggestions:
   - `pnpm install`
   - `/flue:new agent <name>` to create the first agent
   - `/flue:dev` to start the dev server

## Important

- Use the bundled templates verbatim — do not invent file contents.
- The target only changes whether `wrangler.jsonc` is included; the agent file shape is identical.
- If the user passes an unrecognized target, error out with the supported list.
