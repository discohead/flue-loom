---
description: Map an unfamiliar Flue workspace
argument-hint: "[path?]  (default: cwd)"
allowed-tools: ["Task", "Read", "Glob", "Grep", "Bash"]
---

Explore the Flue workspace via the `flue-explorer` subagent.

Arguments: $ARGUMENTS

## Dispatch

Invoke `flue-explorer` (Task tool, `subagent_type: flue-explorer`) with:

> Map the Flue workspace at `<path>` (default: cwd).
> Inventory agents, roles, workspace skills. Report patterns and conventions.
> Cite file paths for every claim.

## When to use

- Just cloned a Flue project, want a fast orientation.
- Before flue-architect designs additions — needs to know what exists.
- Before flue-author writes code — to mimic existing patterns.

## Output

The explorer produces:
- Layout (workspace path, target hint, output dir)
- Agents table (name, triggers, sandbox, model, role)
- Roles list (name + description)
- Workspace skills list
- Patterns observed (e.g., "all agents return structured results")
- Conventions (indentation, imports, naming)
- Surface area (HTTP routes if dev running)
- Notes on anything surprising

## Read-only

The explorer never edits.
