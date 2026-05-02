---
name: flue-skills
description: Use when creating workspace skills in .agents/skills/, invoking session.skill(), or understanding the difference between roles and skills.
---

# Workspace skills

A workspace skill is a structured task you can invoke from a session via `session.skill('name', options)`. Skills are stored at `.agents/skills/<name>/SKILL.md` and discovered at runtime from the session's `cwd`.

## File shape

`.agents/skills/greet/SKILL.md`:

```markdown
---
name: greet
description: Generate a personalized greeting for a given name. Use when asked to greet someone.
---

Given the name provided in the arguments, generate a warm, personalized
greeting. Keep it to one or two sentences.
```

## Where they live

```
project-root/
├── .flue/
│   └── agents/
└── .agents/
    └── skills/
        └── greet/
            └── SKILL.md
```

**Important**: `.agents/skills/` is at the project root, *not* under `.flue/`. Reason: skills are discovered at runtime per-session, not bundled at build time. They live with the project so any session whose `cwd` lands in this project picks them up.

Discovery happens in `packages/sdk/src/context.ts:discoverLocalSkills` (line 94 in v0.3.5). It walks up from the session's `cwd` looking for `.agents/skills/`.

## Invocation

```typescript
const session = await agent.session();

const result = await session.skill('greet', {
  args: { name: 'Ada' },
  result: v.object({ greeting: v.string() }),
  role: 'friendly',     // optional per-call role
  model: 'anthropic/claude-haiku-4-5',  // optional per-call model
});
```

Args become available to the skill body (the LLM sees them as part of the system prompt). The skill body itself is markdown — there's no separate executor; the LLM reads it as instructions and responds.

## Skill vs. role

| | Role | Skill |
|---|---|---|
| File | `roles/<name>.md` | `.agents/skills/<name>/SKILL.md` |
| Where | Workspace | Project root |
| Discovery | Build time | Runtime per-session-cwd |
| Invoke | `session.prompt('...', { role })` | `session.skill('name', { args })` |
| Carries args | No | Yes |
| Effect | Overlays system prompt | Defines a callable task |

A skill can use a role: `session.skill('greet', { role: 'friendly' })`.

## Sub-skills (nested)

Skills can have additional files in their directory (e.g., reference docs, sub-workflows). Convention: keep `SKILL.md` as the entry; use sibling files for richer content the LLM can read on demand. Flue itself doesn't enforce a deep structure — just `<name>/SKILL.md` is the contract.

## Related

- `flue-roles` — the call-scoped overlay alternative
- `flue-composition` — `task()` rediscovers skills per child cwd
- `flue-workspace-layout` — where everything lives
