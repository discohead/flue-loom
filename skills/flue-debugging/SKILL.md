---
name: flue-debugging
description: Use when an agent fails to invoke, returns unexpected results, has a malformed triggers export, hits a model resolution error, or any other "why isn't this working" Flue scenario.
---

# Debugging Flue agents

A diagnostic flow that catches 90% of issues fast.

## Step 1: read the manifest

```bash
cat <output-dir>/dist/manifest.json
```

`flue build` writes a manifest listing every discovered agent and its parsed triggers. If the manifest is missing or shows wrong triggers, the problem is at build time.

```jsonc
{
  "agents": [
    { "name": "hello", "triggers": { "webhook": true } },
    { "name": "scheduler", "triggers": { "cron": "0 9 * * *" } }
  ]
}
```

## Step 2: probe `/agents`

```bash
curl -s http://localhost:3583/agents | jq .
```

Live verification of what the running server thinks is registered. If `flue dev` is running but an agent is missing here, the file failed to import — check the dev log.

## Step 3: invoke sync (no streaming yet)

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{}' http://localhost:3583/agents/hello/test-1 | jq .
```

Sync mode returns `{ result: ... }` or `{ error: { ... } }` (the structured error envelope from PR #18). Most failures show up clearly here.

## Step 4: SSE for streaming detail

```bash
bash scripts/sse-invoke.sh http://localhost:3583/agents/hello/test-1 '{}'
```

Or via curl:

```bash
curl -N -X POST -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -d '{}' http://localhost:3583/agents/hello/test-1
```

Lets you see `text`, `tool_use`, and `idle` events in real-time — useful when an agent stalls mid-turn.

## Common failures and recipes

### Trigger regex didn't match

**Symptom**: agent in `/agents` list but missing from manifest, or `triggers: {}` even though you wrote `{ webhook: true }`.

**Cause**: source-level shape doesn't match `/export\s+const\s+triggers\s*=\s*\{([^}]*)\}/`.

**Fix**: write `triggers` as a literal object expression on its own line. No spread, no computed keys, no factory functions.

```typescript
// ✅
export const triggers = { webhook: true };

// ❌
export const triggers = { ...defaults, webhook: true };
const t = { webhook: true };
export { t as triggers };
```

The plugin's `scripts/post-edit-flue.mjs` hook lints this on save.

### Agent returns 403/404

**Cause**: trigger-less agent hit in non-local mode.

**Fix**: either add `triggers: { webhook: true }`, or set `FLUE_MODE=local` (auto-set by `flue dev` and `flue run`).

### Model resolution error

**Symptom**: `Error: No model resolved for this call`.

**Cause**: no `init({ model })`, no per-call `model`, no role-level `model`, no build-time default.

**Fix**: set one. Cheapest: `init({ model: 'anthropic/claude-haiku-4-5' })`.

### Tool name collision

**Symptom**: throws on agent init or first prompt.

**Cause**: custom tool name matches a built-in (`read`/`write`/`edit`/`bash`/`grep`/`glob`/`task`).

**Fix**: rename. `read-config`, `task-router`, etc.

### Env file path resolution

**Symptom**: `--env .env.local` not loaded.

**Cause**: relative paths resolve against `--output` (default cwd), not against `--workspace`.

**Fix**: Either pass an absolute path, or run from the directory where `--output` points.

### Custom skill not discovered

**Symptom**: `session.skill('greet')` throws "skill not found".

**Cause**: `.agents/skills/greet/SKILL.md` lives under `.flue/` instead of project root, OR the session's `cwd` doesn't point where the skills are.

**Fix**: move `.agents/` to project root. Verify session cwd matches the project root.

### Cloudflare compat date error

**Symptom**: build fails: "compatibility_date is too old".

**Fix**: bump `wrangler.jsonc:compatibility_date` to `"2026-04-01"` or later.

### Custom tool returns wrong shape

**Symptom**: LLM doesn't see the tool result clearly.

**Cause**: `execute` returned a non-string. Tools must return strings.

**Fix**: `JSON.stringify(...)` complex returns.

## Diagnostic command palette

```bash
# Build status
node packages/cli/dist/flue.js build --target node 2>&1 | tail

# Manifest after build
jq . dist/manifest.json

# Live agents
curl -s http://localhost:3583/agents | jq .

# Sync invoke
curl -s -X POST -d '{}' http://localhost:3583/agents/<name>/<id> | jq .

# SSE invoke
bash scripts/sse-invoke.sh http://localhost:3583/agents/<name>/<id> '{}'

# Tail dev log (when launched with run_in_background)
# Use Monitor tool on the bash shell id.
```

## When to escalate

If you've checked manifest + `/agents` + sync + SSE and the failure is still unclear, dispatch the `flue-debugger` subagent — it knows the deeper recipes for sandbox failures, MCP issues, and compaction edge cases.

## Related

- `flue-triggers` — trigger gating
- `flue-tools-and-mcp` — tool name rules
- `flue-lifecycle` — env file resolution
- `flue-cloudflare` — compat date
