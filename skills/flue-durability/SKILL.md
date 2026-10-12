---
name: flue-durability
description: Use when reasoning about what survives crashes, restarts, and redeploys in Flue 2 — submissions and settlement outcomes, recovery rules, the durability static (maxAttempts/timeoutMs), durable tools, persistent-state atomicity, db.ts persistence adapters (sqlite, Postgres, libSQL, MySQL, MongoDB, Redis), the one-live-owner rule on Node, and schema resets.
user-invocable: false
---

# Durability and persistence

## The contract

Every input — HTTP POST, `dispatch()`, `init().dispatch()`, channel delivery, schedule — is admitted as a **submission**, recorded durably *before* model work starts. Each submission reaches exactly one terminal outcome: `completed`, `failed`, or `aborted` (recorded as `submission_settled`; the SDK's `wait()`/`read()` and `init().read()` resolve from it). Per conversation, submissions run one at a time in admission order; a message arriving mid-response joins it at the next turn boundary; nothing queued is lost. `abort()` records a durable intent on all unsettled submissions.

## Recovery (what an interruption does)

- Persisted but never applied → requeued cleanly. Completed response on record → settles `completed`.
- Partial streamed text → the model is told its stream was interrupted and continues.
- Tool calls in flight: recorded results are kept; **ordinary** unresolved calls settle with an *unknown outcome* error the model sees (never blindly re-run); `durable: true` tools re-execute with completed `step.do` steps replayed; delegated tasks resume from the child's own transcript.
- Transient provider errors retry with backoff; context overflow compacts and retries.
- Discipline: **exactly-once recording, at-least-once execution** — event-hook callbacks and steps may re-run; external side effects must be idempotent (key on `toolCallId`/step names) or guarded by persistent state.

## Retry budget

```ts
MyAgent.durability = { maxAttempts: 5, timeoutMs: 7_200_000 }; // defaults: 10 attempts, 1 hour per submission
```

A static (applied while the function isn't running, even after a crash in render); may be an expression (`process.env.CI ? … : …`). Exhausted → `submission_retry_exhausted` (with `meta.interruptedTools`) or `submission_interrupted`; over time → `submission_timeout`. Tool `timeoutMs` bounds single calls inside that budget.

## State

- `usePersistentState` writes commit atomically with the tool batch/hook seam that made them — the correct guard for one-shot effects (`flue-hooks`).
- Workspace files are **not** conversation state: the virtual sandbox is rebuilt fresh per initialization; durable files need a durable workspace adapter keyed on the instance id (`flue-sandboxes`). A durable database does not make a sandbox durable, and vice versa.
- `init().read()` / SDK `wait()` promises are not durable — persist the receipt/`submissionId` and re-attach.

## Persistence: `db.ts` (Node only)

| Command | Without `db.ts` |
|---|---|
| `vite dev` | cache file `node_modules/.cache/flue/dev.db` (survives reloads, resets on cold start) |
| `flue run` | cache file `node_modules/.cache/flue/run.db` (never reset — `--id` continues) |
| built server | **in-memory — a restart loses every conversation and queued submission** |

```ts
// src/db.ts — single host
import { sqlite } from '@flue/runtime/node';
export default sqlite('./data/flue.db'); // WAL mode; creates dirs; node:sqlite (no extra deps)
```

```bash
npx flue add database postgres --print   # also: libsql, turso, mysql, mongodb, redis, valkey, supabase
```

Ecosystem adapters (`@flue/postgres`, `@flue/libsql`, `@flue/mysql`, `@flue/mongodb`, `@flue/redis`) are **bring-your-own-driver**: you wrap your pool as `{ query, transaction, close }` and export `postgres({ … })` from `db.ts`. `migrate()` runs at boot (idempotent; no manual migrations) and a database stamped by an incompatible Flue format version refuses to start. Custom adapters implement `PersistenceAdapter` from `@flue/runtime/adapter` (`connect()` → submission, conversation-stream, and attachment stores) and should pass the contract suites in `@flue/runtime/test-utils`. Standalone `start()` scripts take `db:` directly and ignore `db.ts`.

**Cloudflare** uses Durable Object SQLite per conversation automatically; a `db.ts` is a build error there.

## Node ownership rules

- Recovery is only as durable as the database (in-memory → nothing survives a restart).
- A replacement process recovers interrupted work at startup and via periodic lease scans; graceful shutdown drains at turn boundaries.
- **One live owner per conversation**: a shared database enables replacement, not active-active. Multi-replica deployments must route each conversation to one process (sticky routing by conversation id) and avoid overlapping owners.

## Schema resets across major upgrades

Flue 2 stores schema version 8; pre-2.0 databases are rejected before app code runs (no in-place migration). Export anything you need from the old app first, then start fresh (on Cloudflare: retire old classes with `deleted_classes`). See `flue-migration`.

Docs: `flue docs read guide/durability`, `guide/database`, `reference/data-persistence-api`, `ecosystem/databases/<name>`.
