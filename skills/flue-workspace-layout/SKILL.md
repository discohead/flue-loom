---
name: flue-workspace-layout
description: Use when scaffolding a new Flue workspace, debugging "agents not found" errors, deciding where files go, or understanding the resolution waterfall between .flue/ and project root.
---

# Flue workspace layout

A Flue workspace is a directory containing agents, roles, and (optionally) workspace skills. The CLI resolves the workspace via a waterfall.

## Resolution waterfall

In `packages/sdk/src/build.ts:resolveWorkspaceFromCwd`:

1. If `--workspace <path>` is passed, use it verbatim. **No fallback.** This is the explicit override.
2. Otherwise, check `./.flue/` — if it exists, that's the workspace.
3. Otherwise, check `./` itself — must contain an `agents/` subdir.
4. If neither: hard error.

This means a typical project keeps Flue files under `.flue/` (so the project root stays clean for app code), and `flue dev` / `flue run` / `flue build` discover them automatically when you run from the project root.

## Canonical layout

```
my-agents/
├── package.json              # depends on @flue/sdk, valibot, etc.
├── tsconfig.json             # ESM, strict, allowImportingTsExtensions
├── AGENTS.md                 # workspace-level system prompt (optional)
├── .flue/
│   ├── agents/               # *.{ts,js,mts,mjs}, one file per agent
│   │   ├── hello.ts
│   │   └── greeter.ts
│   ├── roles/                # *.md, one per role
│   │   └── friendly.md
│   └── flue.config.ts        # optional: build defaults, model, etc.
└── .agents/skills/           # workspace skills, runtime-discovered
    └── greet/
        └── SKILL.md
```

Note: `.agents/skills/` is at the **project root**, not under `.flue/`. Flue discovers it from each session's `cwd` at runtime via `discoverLocalSkills` in `packages/sdk/src/context.ts:94`. Same for `AGENTS.md` and `CLAUDE.md` — runtime-discovered, not bundled at build.

## Output vs workspace

Two flags, two purposes:

- `--workspace <path>` — where to read agents/roles from
- `--output <path>` — where to write `dist/` (default: cwd, NOT `--workspace`)

The split matters for Cloudflare: `wrangler.jsonc` must land at the project root where `wrangler deploy` expects it, not nested under `.flue/`. So `--output` defaults to cwd while `--workspace` walks the waterfall.

## Common pitfalls

- Putting `.agents/skills/` under `.flue/` — won't be discovered. Skills resolve from session cwd.
- Leaving an empty `agents/` dir at project root — the waterfall picks `./` as the workspace before checking `./.flue/`. Always order: pick one location.
- Forgetting `AGENTS.md` is per-cwd — when `session.task({ cwd })` runs, it discovers a *different* AGENTS.md in that cwd, not the workspace's.

## Related

- `flue-agent-authoring` — what goes in `agents/*.ts`
- `flue-roles` — `roles/*.md` shape
- `flue-skills` — `.agents/skills/` shape
- `flue-lifecycle` — using `flue dev`/`run`/`build` against this layout
