# `@flue-loom/mcp` evaluation

10 deterministic Q&A pairs that test whether an LLM can use the MCP server to answer realistic questions about a Flue HTTP endpoint.

## Layout

```
mcp/eval/
├── eval.xml          # 10 <qa_pair> entries
├── fixture/          # Self-contained Flue workspace with deterministic agents
│   ├── package.json
│   ├── tsconfig.json
│   ├── AGENTS.md
│   └── .flue/
│       └── agents/   # 9 pure-function agents (no LLM calls)
│           ├── add-numbers.ts
│           ├── constant-pi.ts
│           ├── count-words.ts
│           ├── daily-summary.ts    (cron: 0 9 * * *)
│           ├── echo.ts
│           ├── hourly-task.ts      (cron: 0 * * * *)
│           ├── midnight-batch.ts   (cron: 0 0 * * *)
│           ├── reverse.ts
│           └── version.ts
└── README.md         # this file
```

The fixture agents are **pure functions** — they never call an LLM. Outputs are fully deterministic, which is what makes the eval answers stable.

## How to run

The eval runs in two pieces:

1. **Fixture Flue dev server** — must be started manually before the eval. Listens on `http://localhost:9999/`.
2. **MCP server** — launched automatically by the eval harness via stdio.

### Start the fixture

```bash
cd mcp/eval/fixture
pnpm install
pnpm dev    # runs `flue dev --target node --port 9999`
```

Verify with `curl http://localhost:9999/agents` — should list 9 agents.

### Run the eval harness

The harness ships with the `mcp-builder` skill (`scripts/evaluation.py`). From the skill directory:

```bash
export ANTHROPIC_API_KEY=sk-...
python scripts/evaluation.py \
  -t stdio \
  -c node \
  -a /path/to/flue-loom/mcp/dist/server.mjs \
  -o /tmp/flue-loom-eval-report.md \
  /path/to/flue-loom/mcp/eval/eval.xml
```

The report shows accuracy, per-question result, and the agent's feedback on tool descriptions / shape.

### Manual verification

Each answer can be verified by hand against the live fixture:

```bash
# Q1, Q2, Q6, Q8 — manifest queries
curl -s http://localhost:9999/agents | jq '.agents[] | select(.triggers.cron) | .name'
# → daily-summary, hourly-task, midnight-batch        (Q1: 3)
# → daily-summary fires at 0 9 * * *                  (Q2)

# Q3, Q4, Q5, Q7, Q10 — sync invocations
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"a":17,"b":25}' \
  http://localhost:9999/agents/add-numbers/q3 | jq .result.sum    # → 42

# Q9 — webhook mode
curl -i -X POST -H 'Content-Type: application/json' -H 'x-webhook: true' \
  -d '{"x":true}' \
  http://localhost:9999/agents/echo/q9                            # → HTTP/1.1 202

# Q10 — SSE
curl -N -X POST -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -d '{"name":"loom"}' \
  http://localhost:9999/agents/echo/q10                            # → result event
```

## Stability guarantees

- All agent return values are functions of their inputs (or hardcoded). No timestamps, no random IDs, no LLM calls.
- Cron expressions are part of the agent source — they don't change unless the fixture changes.
- The eval uses **explicit URL endpoints** (no registry lookups), so eval answers don't depend on a pre-existing endpoint registry.
- No question requires writing any state. `flue_add_endpoint` and `flue_remove_endpoint` are not needed to answer any question.

If the fixture agents change, **the eval answers must be re-derived**. The fixture is intentionally minimal so this is easy.

## Why these particular questions

The eval is designed to exercise:

| Tool | Used by |
|---|---|
| `flue_list_agents` | Q1, Q2, Q6, Q8 (manifest reasoning) |
| `flue_invoke_agent` (sync) | Q3, Q4, Q5, Q7 (payload-driven invocation + structured-result parsing) |
| `flue_invoke_agent` (webhook) | Q9 (alternative invocation mode) |
| `flue_invoke_agent` or `flue_stream_agent` | Q10 (constant-pi); LLM may choose either |
| `flue_stream_agent` | Q10 alt path; tests SSE handling and unwrap |

Together they cover trigger inspection, payload construction, sync/webhook/stream modes, structured-content parsing, and basic aggregation (count, sort, filter).
