---
name: flue-sessions
description: Use when working with FlueSession (prompt/skill/task/shell), understanding session persistence, or configuring compaction.
---

# Sessions: the conversation unit

A `FlueSession` is the conversation thread. One agent can have many sessions; each session has its own message history. Sessions live in a `SessionStore` — InMemoryStore on Node (process-lifetime), DurableObject SQLite on Cloudflare (durable, queryable).

## The four call types

```typescript
const session = await agent.session('thread-1');

// prompt: full LLM turn with tools, optional structured result
const r1 = await session.prompt('What is 2+2?', {
  role: 'math-tutor',         // optional per-call role
  model: 'anthropic/claude-opus-4-7',  // optional per-call model
  tools: [myTool],            // optional per-call tools
  result: v.object({ ... }),  // optional valibot schema → typed return
});

// skill: invoke a workspace skill by name (.agents/skills/<name>/SKILL.md)
const r2 = await session.skill('greet', { args: { name: 'Ada' } });

// task: detached child session in another cwd; rediscovers AGENTS.md
const r3 = await session.task('Refactor this file', {
  cwd: '/some/other/dir',
});

// shell: non-LLM op in the sandbox; doesn't add to history
const r4 = await session.shell('cat AGENTS.md');
```

`prompt`, `skill`, and `task` all accept role/model/tools/commands per-call. `shell` is a sandbox passthrough — useful when the agent needs to read/write files directly without involving the LLM.

## Session id semantics

```typescript
await agent.session();              // session id = "default"
await agent.session('my-thread');   // explicit id
await agent.sessions.create('id');  // throws if exists
await agent.sessions.get('id');     // throws if missing
await agent.sessions.delete('id');  // no-op if missing
```

The session store keys by `(agent_id, session_id)`. Same session id under different agent ids = different threads.

## Persistence

| Platform | Default store | Where it lives |
|---|---|---|
| Node | `InMemorySessionStore` | Process memory. Lost on restart. |
| Cloudflare | DO SQLite | DurableObject per agent. Survives across worker invocations. |

Override via `init({ persist: myStore })` to plug a custom `SessionStore`.

## Compaction

Long conversations hit token budgets. Flue's loop runs compaction automatically — it summarizes older messages into a `compaction` entry that replaces them in the prompt context. Configure via `agentConfig.compaction` (a `CompactionConfig`).

`SessionEntry` is a union: `{ type: 'message', ... }` | `{ type: 'compaction', ... }` | `{ type: 'branch_summary', ... }`. When tailing or replaying, handle all three.

## When to use what

| Goal | Use |
|---|---|
| One LLM turn with tools | `prompt()` |
| Run a defined skill from `.agents/skills/` | `skill()` |
| Spawn a child session with its own history + cwd | `task()` |
| Write/read a file or run a command without burning a turn | `shell()` |

## Related

- `flue-composition` — `task()` patterns and multi-agent composition
- `flue-skills` — declaring workspace skills
- `flue-tools-and-mcp` — passing tools at the call site
- `flue-debugging` — inspecting session state
