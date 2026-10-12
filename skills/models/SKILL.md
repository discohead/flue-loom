---
name: models
description: List, search, or validate the model ids a Flue project can use (`provider/model` specifiers from the installed Pi catalog), with context windows, reasoning support, and the credential each provider needs.
argument-hint: "[filter | --check <provider/model>] [--details]"
disable-model-invocation: true
allowed-tools:
  - Bash(node *flue-models.mjs *)
---

# /flue-loom:models

Arguments: `$ARGUMENTS`

Driver: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs` — reads the catalog from the project's installed `@earendil-works/pi-ai` (exactly what `useModel()` resolves against), falling back to the published catalog outside a project.

- **Search**: `node ${CLAUDE_PLUGIN_ROOT}/scripts/flue-models.mjs <filter> [--details]` — e.g. `anthropic/`, `sonnet`, `openai/gpt`. `--details` adds context window, max output, image input, and the thinking levels each model accepts.
- **Validate**: `--check <provider/model>` exits 0 when the id exists; otherwise it prints close matches. Check every `useModel(...)`, subagent `model`, and per-call `model` in the project when asked to "check models" (grep for them first).
- **Recommend** when asked, by role: `anthropic/claude-sonnet-5-5` as the general default, `anthropic/claude-haiku-5-5` for cheap/fast steps and subagents, `anthropic/claude-opus-5-5` for hard reasoning, `anthropic/claude-fable-5-1` for the hardest — or the user's preferred provider's equivalents from the catalog. Sonnet 5.5 and Haiku 5.5 need Flue ≥ 2.3 (Opus 5.5 and Fable 5.1: ≥ 2.2); on an older install, recommend from what it lists. These models can't turn thinking off — for cheap, fast turns suggest `thinkingLevel: 'low'`, never `'off'` (which leaves the default `high` effort).

Report ids exactly as the catalog prints them, the environment variable each provider needs (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), and where it goes (`.env` for Node dev and `flue run`, `.dev.vars`/`.env` for Cloudflare dev, platform secrets in production). Custom or self-hosted providers (OpenAI-compatible endpoints, Workers AI) are registered in code — see the `flue-models` skill.
