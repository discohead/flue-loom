Deterministic Flue fixture. Used by `flue-loom/mcp/eval/eval.xml` to test the MCP server against a stable corpus.

All agents are pure functions — they do not call any LLM. Their outputs are fixed by their inputs (or hardcoded). Do not modify these agents without also updating the eval answers.
