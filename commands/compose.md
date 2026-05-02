---
description: Design and implement a multi-agent Flue workflow
argument-hint: "<description of the workflow>"
allowed-tools: ["Task", "Read", "Write", "Edit", "Glob", "Grep"]
---

Compose a multi-agent Flue workflow.

Arguments: $ARGUMENTS

## Dispatch chain

This is a three-step chain:

### Step 1: Architecture (flue-architect)

Invoke `flue-architect` (Task tool) with:

> Design a multi-agent workflow for: `<description>`.
> Workspace cwd: `<cwd>`.
> Read existing agents/roles first to avoid duplication.
> Output: spec doc with agents, roles, skills, custom tools, composition diagram, open questions.

Wait for the spec. If the spec has open questions, ask the user before proceeding.

### Step 2: Orchestration (flue-orchestrator)

Invoke `flue-orchestrator` (Task tool) with:

> Implement the orchestration layer for the spec below.
> Decide where delegation happens (host-side `session.task()` vs LLM-side `task` tool).
> Write the orchestration agent that composes the others.
>
> <paste spec from step 1>

### Step 3: Author the supporting files (flue-author)

For each new agent / role / skill / tool the spec calls for, invoke `flue-author` to write the file.

## Why three steps

- **Architect**: separates *what* from *how*. The user sees the design before code is written.
- **Orchestrator**: knows the composition primitives (`task`, parallel `init`, HTTP, service bindings).
- **Author**: writes idiomatic Flue code following SDK conventions.

You can short-circuit: if the user gives a complete spec already, jump to step 2.

## Output

- The spec (markdown) shown to the user.
- The list of files created/modified.
- A brief explanation of who calls whom, with what data.
- Suggested next steps: `/flue:dev` to test, `/flue:review` to validate.

## Pitfalls

- Designing for hypothetical future requirements — keep to what the user asked.
- Adding agents the user didn't request to "round out" the system.
- Skipping the architect step and inventing the design as you write code.
