#!/usr/bin/env bash
# Resolve the `flue` CLI binary and exec it with the passed args.
# Resolution order:
#   1. $FLUE_CLI_BIN (explicit override)
#   2. ./node_modules/.bin/flue (project-local, walking up)
#   3. `flue` on PATH

set -euo pipefail

if [ -n "${FLUE_CLI_BIN:-}" ] && [ -x "$FLUE_CLI_BIN" ]; then
	exec "$FLUE_CLI_BIN" "$@"
fi

# Walk up from $PWD looking for node_modules/.bin/flue.
dir="$PWD"
while [ "$dir" != "/" ]; do
	if [ -x "$dir/node_modules/.bin/flue" ]; then
		exec "$dir/node_modules/.bin/flue" "$@"
	fi
	dir="$(dirname "$dir")"
done

# Fall back to PATH.
if command -v flue >/dev/null 2>&1; then
	exec flue "$@"
fi

echo "flue-loom: could not locate the \`flue\` CLI." >&2
echo "  Set FLUE_CLI_BIN, or install @flue/cli (pnpm add -D @flue/cli)." >&2
exit 127
