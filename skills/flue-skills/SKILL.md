---
name: flue-skills
description: Use when giving a Flue 2 agent skills (the runtime's SKILL.md expertise, not Claude Code skills) — importing SKILL.md and mounting with useSkill, defineSkill for inline or generated skills, supporting files, workspace skills discovered from .agents/skills, how activate_skill works, and the Agent Skills frontmatter rules Flue validates at build time.
user-invocable: false
---

# Skills for Flue agents

A Flue skill packages a procedure (markdown instructions + optional supporting files) that the agent loads **on demand**: each mounted skill costs one catalog line (name + description) in the system prompt; the model calls the framework's `activate_skill` tool to receive the full instructions as a tool result (the prompt prefix never changes). Flue follows the open [Agent Skills](https://agentskills.io) format.

## Author and import

```
src/skills/refunds/
├─ SKILL.md      # frontmatter + instructions
└─ POLICY.md     # supporting file — read only when needed
```

```markdown
---
name: refunds
description: Process a customer refund request end-to-end. Use when a customer asks for a refund or disputes a charge.
---

1. Confirm the order id and reason.
2. Read `POLICY.md` and check eligibility.
3. If eligible, call `issue_refund`; otherwise explain which rule applies.
```

```ts
'use agent';
import { useModel, useSkill } from '@flue/runtime';
import refunds from '../skills/refunds/SKILL.md'; // static import → SkillReference; packages the whole directory

export function Support() {
	useModel('anthropic/claude-sonnet-5');
	useSkill(refunds);
	return 'Answer support questions. Activate the `refunds` skill before handling any refund.';
}
```

Frontmatter (validated strictly at build time for imported skills):
- `name` — lowercase letters/digits/single hyphens, ≤ 64 chars, **must equal the directory name**.
- `description` — required, ≤ 1024 chars; state what it does **and when to use it** (this is the entire routing decision).
- Optional: `license`, `compatibility` (≤ 500), `metadata` (string map), `allowed-tools` (accepted, **not enforced** — authorize in your tools).

Rules: imports must be static (`import('./x/SKILL.md')` is a build error); one mount per name per render; packaging skips `node_modules`/`.git`/`dist`, warns over 1 MB, and **refuses `.env` files, private keys, and symlinks**. Imports from packages work if the package publishes the directory (and exports the `SKILL.md` subpath). Supporting files ship in the bundle and are served read-only at virtual paths (`read_skill_resource`), never copied into the sandbox.

## Inline skills: `defineSkill`

```ts
import { defineSkill } from '@flue/runtime';
import runbook from './incident-runbook.md'; // any non-SKILL.md .md import is a plain string

export const incidents = defineSkill({
	name: 'incidents',
	description: 'Run the incident procedure. Use when an outage or security event is reported.',
	instructions: runbook,
	files: { 'CHECKLIST.md': checklistText }, // optional supporting files
});
```

`useSkill()` also takes an inline definition object. Import attributes (`with { type: 'skill' }`) are gone.

## Workspace skills

With a sandbox attached, the runtime also discovers `<cwd>/.agents/skills/<name>/SKILL.md` at session start (same catalog, no import). Their instructions are read from disk at activation; malformed ones are skipped with a warning; a name colliding with an imported skill is an error. Use them when the expertise belongs to a checked-out repository or prepared workspace; use imports when it belongs to your application. `AGENTS.md` in the sandbox cwd is also folded into the system prompt.

## Choosing

- Always-needed guidance → put it in the returned instructions or `useInstruction()` (a plain `.md` import works).
- Procedure needed sometimes → skill.
- Deterministic code → tool. Isolated context or parallel work → subagent (`flue-subagents`).
- Steer activation from code by naming the skill in instructions or in `harness.prompt()` text; conditional `useSkill()` unlocks a skill mid-conversation without busting the prompt cache.

flue-loom's edit lint checks imported `SKILL.md` frontmatter and flags secrets in skill directories. Docs: `flue docs read guide/skills`, `reference/agent-api` (SkillDefinition).
