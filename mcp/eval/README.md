# `@flue-loom/mcp` evaluation

Ten deterministic questions that check whether a model can operate the MCP server against a real Flue 2 app: discovery, sending and continuing conversations, creation data, signals, pending replies, failures, credentials, and idempotency.

## Layout

```
mcp/eval/
├── eval.xml         # 10 <qa_pair> entries (exact-match answers)
└── fixture/         # Flue 2 project with deterministic agents (faux models, no API keys)
    ├── package.json · flue.config.ts · vite.config.ts · tsconfig.json
    └── src/
        ├── app.ts           # mounts /agents/{echo,calc,counter,slow,profile,inbox,broken} and /secure/vault (bearer auth)
        ├── faux.ts          # registers a deterministic faux model per agent
        └── agents/*.ts
```

| Agent | Mount | Behavior |
|---|---|---|
| Echo | `/agents/echo` | replies `echo: <message>` |
| Calc | `/agents/calc` | calls the `add` tool with the first two integers, emits a `progress` data part, replies `The sum is N.` |
| Counter | `/agents/counter` | durable per-conversation counter (`usePersistentState`), replies `count: N` |
| Slow | `/agents/slow` | `wait` tool sleeps for the milliseconds in the message (default 3000), abortable |
| Profile | `/agents/profile` | `initialData` schema `{ name, plan: free \| pro \| team }`, greets the member |
| Inbox | `/agents/inbox` | acknowledges user messages and signals (type, attributes, body) |
| Broken | `/agents/broken` | model always errors → submission fails (`operation_failed`) |
| Vault | `/secure/vault` | behind `bearerAuth` (`VAULT_TOKEN`, default `open-sesame`) |

The same fixture backs the automated tests in `mcp/test/`.

## Run

1. Start the fixture (port 9999):

   ```bash
   cd mcp/eval/fixture
   npm install
   VAULT_TOKEN=open-sesame npm run dev
   ```

2. Build the server: `cd mcp && pnpm install && pnpm build`.

3. Run the harness from the `mcp-builder` skill (`scripts/evaluation.py`), passing the server its environment:

   ```bash
   export ANTHROPIC_API_KEY=…
   python scripts/evaluation.py -t stdio -c node \
     -a /path/to/flue-loom/mcp/dist/server.mjs \
     -e FLUE_LOOM_PROJECT_DIR=/path/to/flue-loom/mcp/eval/fixture \
        FLUE_LOOM_BASE_URL=http://localhost:9999 \
        FLUE_LOOM_HOME=/tmp/flue-loom-eval \
        FLUE_EVAL_TOKEN=open-sesame \
     -o /tmp/flue-loom-eval-report.md \
     /path/to/flue-loom/mcp/eval/eval.xml
   ```

   Pick the model with `-m`. `FLUE_LOOM_HOME` isolates the eval's agent registry from your real one.

Dev-server conversations persist in `fixture/node_modules/.cache/flue/dev.db` until the server cold-starts; the questions are written to give the same answers on repeated runs.
