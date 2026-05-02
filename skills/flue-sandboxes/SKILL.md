---
name: flue-sandboxes
description: Use when choosing the sandbox option for init(), implementing a custom BashFactory or SandboxFactory, or debugging sandbox-related errors.
---

# Sandboxes: where the agent's filesystem and shell live

Every Flue agent has a `SessionEnv` — a unified filesystem + exec interface. The `sandbox` option to `init()` decides which `SessionEnv` you get. Five resolution paths, evaluated in order (`packages/sdk/src/client.ts:138-167`):

```
1. 'empty' (default)        → in-memory, no host access
2. 'local'                   → mount process.cwd() at /workspace (Node only)
3. BashFactory (function)    → fresh just-bash instance per op
4. Platform hook             → CF Containers shim (cloudflare target)
5. SandboxFactory (object)   → connector-wrapped remote (Daytona, etc.)
```

## When to pick which

| Sandbox | Use when |
|---|---|
| `'empty'` | Tests, isolation, agents that don't need files |
| `'local'` | Local dev where the agent should see your repo (Node only — never CF) |
| `BashFactory` | Custom in-memory FS, restricted exec, or a specific `Bash` config (e.g., network policies) |
| Platform hook | Cloudflare deployment with `cloudflare/sandbox` Containers — auto-resolved if `getSandbox(env)` is passed |
| `SandboxFactory` | Remote sandboxes: Daytona, custom VM provisioners, etc. |

## `'local'` is Node-only

```typescript
const agent = await init({ sandbox: 'local' });  // mounts process.cwd() at /workspace
```

On Cloudflare, `'local'` throws — there's no host filesystem. Use `'empty'` or the platform hook instead.

## `BashFactory` — function returning fresh `BashLike`

```typescript
import { Bash, InMemoryFs } from 'just-bash';

const fs = new InMemoryFs();
const sandbox = () => new Bash({
  fs,
  network: { dangerouslyAllowFullInternetAccess: true },
});

const agent = await init({ sandbox });
```

Two contracts:
- **Fresh instance per op** — the factory is called for each operation. Don't return a singleton.
- **Share `fs` in closure** — to persist files across operations, share the `InMemoryFs` reference in the closure (as above). Each `Bash` instance has its own state, but they share the FS.

## `SandboxFactory` — object with `createSessionEnv`

```typescript
const myFactory: SandboxFactory = {
  async createSessionEnv({ id, cwd }) {
    // build a SessionEnv that wraps your remote sandbox
    return makeRemoteSessionEnv(id, cwd);
  },
};

const agent = await init({ sandbox: myFactory });
```

Use for connectors. `@flue/connectors/daytona` is the canonical example.

## Cloudflare Containers (platform hook)

```typescript
import { getSandbox } from '@cloudflare/sandbox';

export default async function ({ init, env }: FlueContext) {
  const sandbox = getSandbox(env, 'task-1');  // CF Sandbox DO instance
  const agent = await init({ sandbox });
}
```

Flue's CF build plugin provides a `resolveSandbox` hook that detects this shape and wraps it as a `SessionEnv`. Requires a `Sandbox` DO binding in your `wrangler.jsonc`.

## SessionEnv interface

What every sandbox implements (`packages/sdk/src/types.ts`):

```typescript
interface SessionEnv {
  exec(command, options?): Promise<ShellResult>;
  readFile(path): Promise<string>;
  readFileBuffer(path): Promise<Uint8Array>;
  writeFile(path, content): Promise<void>;
  stat(path): Promise<FileStat>;
  readdir(path): Promise<string[]>;
  exists(path): Promise<boolean>;
  mkdir(path, options?): Promise<void>;
  rm(path, options?): Promise<void>;
  cwd: string;
  resolvePath(p): string;
  cleanup(): Promise<void>;
}
```

Core code never branches on sandbox kind — all sandbox impls speak the same interface.

## Common pitfalls

- Returning a singleton from `BashFactory` — must be fresh each call.
- Using `'local'` on Cloudflare — throws.
- Forgetting to share `fs` in closure — every op starts with a blank FS.
- Passing a Bash instance directly — old API; must wrap in factory.

## Related

- `flue-cloudflare` — CF Sandbox DO setup
- `flue-node` — local sandbox semantics
- `flue-debugging` — sandbox-related errors
