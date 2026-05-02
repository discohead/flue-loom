---
description: Review the current workspace's Flue code for SDK best practices
argument-hint: "[path?]  (default: workspace)"
allowed-tools: ["Task", "Read", "Glob", "Grep"]
---

Review Flue code via the `flue-reviewer` subagent.

Arguments: $ARGUMENTS

## Dispatch

Invoke `flue-reviewer` (Task tool, `subagent_type: flue-reviewer`) with:

> Review the Flue workspace at `<path>` (default: cwd).
> Check trigger correctness, import hygiene, tool definitions, sandbox choices,
> model resolution, roles, skills, Cloudflare specifics, and resource hygiene.
> Confidence-filter: only surface high-priority findings.
> Output: critical / important / suggestions / LGTM groupings.

## When to use

- Before opening a PR for Flue code.
- After flue-author writes new files (sanity check).
- When debugging "this should work but doesn't" (reviewer often spots the cause).

## Scope discipline

The reviewer limits itself to:
- `.flue/agents/*.ts`
- `.flue/roles/*.md`
- `.agents/skills/<name>/SKILL.md`
- `wrangler.jsonc`, `package.json`, `flue.config.ts`

It will NOT review unrelated app code in the same repo.

## Read-only

The reviewer never edits. After it reports, you (or flue-author) can apply suggested fixes.
