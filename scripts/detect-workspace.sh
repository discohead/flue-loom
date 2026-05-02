#!/usr/bin/env bash
# SessionStart hook for flue-loom.
# Detects whether the current working directory is a Flue workspace
# and emits a non-blocking informational message via stdout.
#
# Reads the SessionStart hook input on stdin (JSON with cwd field),
# but also tolerates being called outside Claude Code by falling back to $PWD.

set -euo pipefail

# Read JSON from stdin if available; extract cwd if present. Otherwise use $PWD.
input=""
if [ ! -t 0 ]; then
	input="$(cat || true)"
fi

cwd="$PWD"
if [ -n "$input" ] && command -v jq >/dev/null 2>&1; then
	maybe_cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
	if [ -n "$maybe_cwd" ] && [ -d "$maybe_cwd" ]; then
		cwd="$maybe_cwd"
	fi
fi

# Detect a Flue workspace via the same waterfall as resolveWorkspaceFromCwd:
# 1. ./.flue/agents/  -> workspace at ./.flue
# 2. ./agents/         -> workspace at ./
flue_workspace=""
if [ -d "$cwd/.flue/agents" ]; then
	flue_workspace="$cwd/.flue"
elif [ -d "$cwd/agents" ]; then
	flue_workspace="$cwd"
fi

if [ -z "$flue_workspace" ]; then
	# Not a Flue workspace; exit silently.
	exit 0
fi

agent_count="$(find "$flue_workspace/agents" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mts' -o -name '*.mjs' \) 2>/dev/null | wc -l | tr -d ' ')"

# Hooks emit JSON with a `hookSpecificOutput.additionalContext` field for
# SessionStart in newer Claude Code versions. We emit both shapes — the legacy
# stdout text is harmless if ignored.
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Flue workspace detected at ${flue_workspace} (${agent_count} agents). flue-loom skills available: flue-overview, flue-workspace-layout, flue-agent-authoring, flue-sessions, flue-roles, flue-skills, flue-tools-and-mcp, flue-composition, flue-sandboxes, flue-triggers, flue-lifecycle, flue-cloudflare, flue-node, flue-debugging."
  }
}
EOF
