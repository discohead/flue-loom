---
name: docs
description: Look something up in the Flue docs that match the installed version — search, read a page, or answer a question from them — using `flue docs` and the Markdown shipped in @flue/cli.
argument-hint: "[search terms | page path | question]"
disable-model-invocation: true
allowed-tools:
  - Bash(bash *flue-cli.sh docs *)
---

# /flue-loom:docs

Arguments: `$ARGUMENTS`

The installed `@flue/cli` ships the docs for its exact version, so these answers match the project better than the website or memory.

## Find

- No arguments → list the pages: `bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh docs` (don't pipe it into `head`; 2.1.1 crashes with EPIPE — redirect to a file or read it whole).
- A page path (`guide/sandboxes`, `reference/agent-api`, `ecosystem/deploy/fly`) → `bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh docs read <path>`.
- Search terms or a question → `bash ${CLAUDE_PLUGIN_ROOT}/scripts/flue-cli.sh docs search "<terms>"`, then read the best one or two pages.
- Faster for targeted lookups inside a project: Grep `node_modules/@flue/cli/docs/**/*.md` directly (sections: `guide/`, `reference/`, `cli/`, `sdk/`, `ecosystem/{channels,databases,deploy,sandboxes,tooling}`).
- No project or CLI installed → `npx -y @flue/cli@latest docs …` (latest version; note that it may differ from what a project pins).

## Answer

Answer the question from the pages you read, quote the decisive lines, and cite the page path (`flue docs read <path>`). Add a short example adapted to the user's project when it helps. If the docs don't cover it, say so and check the installed `@flue/runtime` type definitions (`node_modules/@flue/runtime/dist/*.d.mts`) before concluding. Point to the matching flue-loom skill (`flue-agents`, `flue-tools`, `flue-routing`, …) for follow-up work.
