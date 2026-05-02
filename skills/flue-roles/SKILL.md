---
name: flue-roles
description: Use when creating role markdown files in roles/, understanding role precedence, or deciding between agent-level vs per-call roles.
---

# Roles: call-scoped system prompt overlays

A role is a markdown file at `<workspace>/roles/<name>.md` that overlays the system prompt for a specific call. Roles are *not* persisted in the session's message history — they apply to one turn at a time.

## File shape

```markdown
---
description: A friendly greeter that welcomes users with enthusiasm
model: anthropic/claude-haiku-4-5
---

## Mission

You are the official greeter. Your job is to welcome users warmly
and make them feel appreciated. Always be enthusiastic and positive.
```

YAML frontmatter:
- `description` (required) — single-line summary, surfaced in tooling
- `model` (optional) — model override that applies when this role is used

Markdown body — the role's instructions. Becomes part of the system prompt for the call.

## Three places you can apply a role

```typescript
// 1. Agent-wide default (init)
const agent = await init({ role: 'friendly' });

// 2. Session default (session())
const session = await agent.session('id', { role: 'friendly' });

// 3. Per-call (prompt/skill/task)
await session.prompt('Hi', { role: 'friendly' });
```

Per-call wins over session, which wins over agent.

## Model precedence with roles

When a role declares `model`, the call's model resolution is:

```
per-call model
  > role model
  > agent model
  > build-time default
```

This means a role can carry its own model preference (e.g., a debugging role uses Opus while a fast-response role uses Haiku) without polluting the agent's overall config.

## Discovery

Roles are discovered at build time via `discoverRoles` in `packages/sdk/src/build.ts`. The role name is the filename without `.md`. Frontmatter is parsed; missing or malformed frontmatter does NOT silently fail — `assertRoleExists` (in `packages/sdk/src/roles.ts`) throws if you reference an unknown role.

## When to reach for a role vs. a tool/skill

- **Role** → "shape the model's voice / persona / instructions for this turn"
- **Skill** → "invoke a defined task with structured args (`session.skill('greet', { args })`)"
- **Tool** → "give the model a callable function it can use mid-turn"

A skill can pair with a role: `session.skill('summarize', { role: 'concise' })`.

## Common pitfalls

- Forgetting the frontmatter — the file is parsed but `description` ends up empty.
- Reusing a role name across workspaces — roles are workspace-scoped; no global registry.
- Putting the role's instructions in the frontmatter — instructions go in the markdown body.
- Calling a session with `{ role: 'name' }` when no `roles/<name>.md` exists — throws at agent init via `assertRoleExists`.

## Related

- `flue-skills` — workspace skills (different from roles)
- `flue-agent-authoring` — passing `role` in `init`
- `flue-sessions` — per-call options
