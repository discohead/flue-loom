---
name: flue-subagents
description: Use when a Flue 2 agent should delegate work — useSubagent, defineSubagent, GeneralSubagent (flue-general), the model-driven task tool, what delegates inherit and don't, model/thinkingLevel overrides, the depth limit, parallel fan-out, and choosing between a subagent, tool, skill, or separately dispatched agent.
user-invocable: false
---

# Subagents

A subagent is a named delegate the model hands a focused task to via the framework's `task` tool. The child runs in a **fresh context** in the parent's environment; only its final message returns as the tool result.

```ts
'use agent';
import { GeneralSubagent, useModel, useSubagent } from '@flue/runtime';

function Reproducer() {
	// NOT exported: an exported capitalized function would register as a top-level agent.
	useTool(searchIssues);
	useSkill(reproduceSkill);
	return 'Reproduce the reported issue. Write your findings to report.md.';
}

export function Triage() {
	useModel('anthropic/claude-sonnet-5');
	useSubagent({
		name: 'reproducer',
		description: 'Sets up a reproduction for one issue and writes report.md.', // what + when
		agent: Reproducer,
		model: 'anthropic/claude-haiku-4-5', // optional; inherits the parent's model
		// thinkingLevel: 'low',              // optional; inherits
	});
	useSubagent(GeneralSubagent); // optional blank delegate named `flue-general`
	return 'Delegate reproduction to `reproducer` with a complete, self-contained brief; then read report.md.';
}
```

## Semantics

- Delegation is **model-driven**: the `task` tool is always present, but its required `agent` parameter only resolves against declared subagents (no declarations → cannot delegate). The model may pass a `cwd` and forward conversation images.
- The **task prompt is the entire briefing** — the child sees none of the parent's conversation. Instruct the parent to write self-contained prompts.
- Inherited: the sandbox and its tools, workspace context (`AGENTS.md`, workspace skills) from the cwd, and the parent's model/reasoning effort unless overridden. Not inherited: history, instructions, tools, skills, subagents, persistent state, initial data.
- The delegate's function renders fresh per task. Allowed there: `useTool`, `useSkill`, `useInstruction`, nested `useSubagent`, custom hooks. Throw: `useModel`, `useSandbox`, `useMcpConnection`, `usePersistentState`, `useDataWriter`, `useDispatchMessage`, event hooks.
- Files are the natural hand-off (shared sandbox). Tool calls in one batch run in parallel, so the model can fan out several tasks at once.
- Depth is capped at **4** (`delegation_depth_exceeded`), counting harness invocations. Child sessions are durable: an interrupted task resumes from its own transcript on recovery.
- Declarations may be conditional (roster changes are narrated without busting the cache); duplicate names in one render throw. `flue-general` is reserved.

## Sharing a delegate

```ts
// src/subagents/issue-classifier.ts — an ordinary module (no 'use agent')
import { defineSubagent } from '@flue/runtime';

function IssueClassifier() {
	return 'Return the likely product area and urgency for the reported issue.';
}
export const issueClassifier = defineSubagent({
	name: 'issue_classifier',
	description: 'Classifies support issues for routing.',
	agent: IssueClassifier,
});
// any agent: useSubagent({ ...issueClassifier, model: 'anthropic/claude-haiku-4-5' })
```

## Pick the right primitive

| Need | Use |
|---|---|
| Deterministic code, API call, bounded job | tool (`flue-tools`; `harness: true` for model work inside it) |
| Guidance the current agent should follow | skill (`flue-skills`) |
| Isolated context, different instructions/tools/model, parallel exploration | subagent |
| Another party messages it over time; its own id, state, and history | a separate registered agent + `dispatch()` (`flue-workflows`) |

Application code can force a particular delegate by naming it in a harness tool's `harness.prompt()` text.

Docs: `flue docs read guide/subagents`, `reference/agent-hooks-api` (useSubagent), `reference/agent-api` (SubagentDefinition, GeneralSubagent).
