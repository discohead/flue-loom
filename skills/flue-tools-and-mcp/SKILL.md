---
name: flue-tools-and-mcp
description: Use when defining custom tools, understanding the built-in tools, debugging tool name collisions, or wiring a remote MCP server with connectMcpServer.
---

# Tools and MCP

A tool is a callable function the LLM can invoke during a turn. Flue ships seven built-ins and lets you define custom tools via `Type` from pi-ai or wire remote tools via `connectMcpServer`.

## Built-in tools

From `packages/sdk/src/agent.ts:11`:

```typescript
export const BUILTIN_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'bash', 'grep', 'glob', 'task',
]);
```

| Tool | Purpose | Notable limit |
|---|---|---|
| `read` | Read a file or directory listing | 2000 lines / 50 KB max |
| `write` | Write a file (creates parent dirs) | — |
| `edit` | Exact-match replace; supports `replaceAll` | — |
| `bash` | Run a shell command in the sandbox | Output truncated to 2000 lines / 50 KB |
| `grep` | Regex search | 100 matches max |
| `glob` | File pattern search | 1000 results max |
| `task` | Spawn a detached child session | Only added when `init` configures it |

Limits are at `packages/sdk/src/agent.ts:5-9`. They prevent context blowups from massive files/searches.

## Custom tools

```typescript
import { Type, type FlueContext, type ToolDef } from '@flue/sdk/client';

const calculator: ToolDef = {
  name: 'calculator',
  description: 'Perform arithmetic. Returns the numeric result as a string.',
  parameters: Type.Object({
    expression: Type.String({ description: 'A math expression like "2 + 3"' }),
  }),
  execute: async (args) => {
    const expr = args.expression as string;
    return String(Function(`"use strict"; return (${expr})`)());
  },
};

await session.prompt('Compute 7*6', { tools: [calculator] });
```

Pattern:
1. Build `parameters` with `Type.Object({...})` (from pi-ai, re-exported from `@flue/sdk/client`).
2. `execute` returns a string. If you want to return JSON, `JSON.stringify` it.
3. Pass per-call via `prompt({ tools: [...] })` or agent-wide via `init({ tools: [...] })`.

## Tool name collisions

Custom tool names **must not collide** with `BUILTIN_TOOL_NAMES`. The runtime throws on collision. If you want a tool named "read" or "task", rename it (e.g., `read-config`, `task-router`).

Multiple custom tools with the same name across agent-wide and per-call also collide. Per-call wins for that call (replaces agent-wide of the same name).

## Remote tools via MCP

```typescript
import { connectMcpServer } from '@flue/sdk/client';

const linear = await connectMcpServer('linear', {
  url: 'https://mcp.linear.app/sse',
  transport: 'sse',
});

const agent = await init({ tools: linear.tools });
```

`connectMcpServer` returns `{ name, tools, close }`. Tools are namespaced as `${serverName}__${originalName}` to avoid collisions across servers.

Transports: `'streamable-http'` (default, modern) or `'sse'` (older). Pass `headers` for auth.

Always call `mcp.close()` when done — `cleanup()` on the agent doesn't close MCP connections.

## Where tools surface

Tools added at:
- `init({ tools })` — every prompt/skill/task call sees them
- `session.prompt('...', { tools })` — only this call sees them (added on top)
- `session.skill('name', { tools })` — same

## Related

- `flue-agent-authoring` — passing tools in `init`
- `flue-sessions` — per-call tools
- `flue-debugging` — tool name collision recipes
