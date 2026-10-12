---
name: review
description: Review Flue 2 code — scan and lint with flue-inspect, then a flue-reviewer pass for correctness, security, and framework best practices — and report findings by severity, offering fixes.
argument-hint: "[path | agent | changed]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-inspect.mjs *)
  - Bash(node *flue-models.mjs *)
  - Bash(npx tsc --noEmit *)
  - Bash(git diff *)
---

# /flue-loom:review

Arguments: `$ARGUMENTS`

1. **Scope.** A path or agent identity → that module plus what it imports. `changed` → Flue-related files changed on this branch (`git diff --name-only <base>...HEAD` plus uncommitted changes). Nothing → the whole project.
2. **Mechanical pass.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-inspect.mjs <project>` (scan errors, lint findings, mounts, migrations). Check each model id in scope with `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs --check <spec>`. Run `npx tsc --noEmit` when dependencies are installed.
3. **Judgment pass.** Spawn `flue-loom:flue-reviewer` (Agent tool) with the scope, the project root, and the full output of step 2:
   > Review `<scope>` in the Flue project at `<root>`. Mechanical results (treat as confirmed): <inspect + model check + tsc output>. Report confidence-filtered findings by severity with file:line.
4. **Report.** Merge the mechanical findings and the reviewer's into one list (Critical → Important → Suggestions → Looks good), deduplicated, each with file:line and a concrete fix.
5. **Offer fixes.** Ask which findings to fix; apply the chosen ones yourself (or via `flue-loom:flue-author` for larger changes), then re-run step 2 to confirm they're resolved.

Don't fix anything before the user chooses — a review is a report first.
