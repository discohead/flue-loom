---
name: flue-composition
description: Use when designing multi-agent workflows, calling session.task(), choosing between session.task() and the LLM-side task tool, or handling parent/child sandbox sharing.
---

# Composition: tasks, multi-agent flows

Flue supports two ways to compose work across agents/sessions, both routed through the same underlying runner:

1. **Host-side**: `session.task(prompt, options)` — your handler explicitly spawns a child session.
2. **LLM-side**: the model invokes the `task` tool during a turn — the model decides when to delegate.

Both create a detached child session that:
- Has its own message history (parent's history is not carried over).
- Inherits the parent's sandbox (same files, same env).
- Re-discovers `AGENTS.md`/`CLAUDE.md` and `.agents/skills/` from the child's `cwd` (which can differ from parent's).

## Host-side `session.task`

```typescript
const result = await session.task('Summarize the file at /workspace/notes.md', {
  cwd: '/workspace/notes',     // child sees a different AGENTS.md here
  role: 'concise-summarizer',  // optional role
  model: 'anthropic/claude-haiku-4-5',
});
```

Use when the parent handler knows exactly when and where to delegate. Cleaner than the LLM tool when the orchestration is structured.

## LLM-side `task` tool

When you call `init` with task config (or use built-in setup), the LLM gets a `task` tool with parameters:

```typescript
{ prompt: string, description?: string, role?: string, cwd?: string }
```

The model invokes it when it decides delegation is helpful. Use when you want the model to autonomously break down work — e.g., "review this repo" might decompose into per-file tasks.

## Multi-agent workflows

To coordinate multiple agents (not sessions):

```typescript
// Agent A returns work
const planResult = await ctx.invokeAgent('planner', payload);

// Pass to Agent B
const codeResult = await ctx.invokeAgent('coder', { plan: planResult });
```

Note: `ctx.invokeAgent` is **not a built-in primitive** — Flue agents communicate over HTTP when separate. Within a single handler, you can `await init({ id: 'other' })` to instantiate a *second* agent runtime sharing the request context, or use `session.task` to keep things in-process.

For deployed multi-agent setups, the canonical patterns:
- **HTTP composition**: agent A `fetch`es agent B's URL.
- **Cloudflare service bindings**: bind agent B's worker into agent A's `env` and call its DO directly.

## Cwd discovery semantics

`task` and child sessions rediscover their context (AGENTS.md, skills) from the *child's* cwd. This is why setting `cwd: '/some/repo'` on a task lets the child read project-specific instructions automatically.

```
session.task('Refactor', { cwd: '/repo-A' })  // sees /repo-A/AGENTS.md
session.task('Refactor', { cwd: '/repo-B' })  // sees /repo-B/AGENTS.md
```

Same parent agent, same sandbox, different contexts.

## When to compose vs. when to fold

Compose into separate agents when:
- They have distinct roles/responsibilities (planner, coder, reviewer)
- They should be independently deployable (CF: each agent is its own DO)
- You want isolated message histories

Stay in one agent when:
- The work is sequential within a single conversation
- You want the parent's history visible to children
- You're prototyping — you can split later

## Related

- `flue-sessions` — `task()` is one of the four call types
- `flue-sandboxes` — children share parent's sandbox
- `flue-agent-authoring` — using `init` for multiple agents in one handler
