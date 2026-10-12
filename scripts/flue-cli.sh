#!/usr/bin/env bash
# Resolve the project's `flue` CLI (@flue/cli) and exec it with the given args.
# Resolution order:
#   1. $FLUE_CLI_BIN (explicit override)
#   2. node_modules/.bin/flue, walking up from $PWD (npm, pnpm, yarn, bun)
#   3. `flue` on PATH
#
# The project-local CLI matters: `flue run`, `flue docs`, and `flue add`
# answer for the installed Flue version, not the latest release. Dev servers
# and builds are not CLI commands in Flue 2 — use `vite dev` / `vite build`.

set -euo pipefail

if [ -n "${FLUE_CLI_BIN:-}" ] && [ -x "$FLUE_CLI_BIN" ]; then
	exec "$FLUE_CLI_BIN" "$@"
fi

dir="$PWD"
while :; do
	if [ -x "$dir/node_modules/.bin/flue" ]; then
		exec "$dir/node_modules/.bin/flue" "$@"
	fi
	[ "$dir" = "/" ] && break
	dir="$(dirname "$dir")"
done

if command -v flue >/dev/null 2>&1; then
	exec flue "$@"
fi

echo "flue-loom: could not find the \`flue\` CLI (@flue/cli) from $PWD." >&2
echo "  In a project:    npm install -D @flue/cli   (or pnpm add -D / yarn add -D)" >&2
echo "  Without one:     npx -y @flue/cli@latest $*" >&2
echo "  Or point FLUE_CLI_BIN at a flue binary." >&2
exit 127
