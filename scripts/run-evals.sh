#!/usr/bin/env bash
# Run the plugin's eval suite (evals/) with `claude plugin eval`.
#
# Runs from a clean copy of the working tree: the harness grants the agent
# read access file by file, and installed node_modules (mcp/, fixtures)
# overflow the child process's argument list (E2BIG). Passes --scaffold,
# which the cases need to copy their fixture projects into each run's
# workspace (our own scaffold.sh scripts), --trust-plugin for this repo, and
# --allow-tools Write Edit for the authoring cases.
# Results land in evals/results/<timestamp>/ as usual.
#
#   scripts/run-evals.sh                       # every case, 3 runs each, with/without-plugin arms
#   scripts/run-evals.sh --case new-agent --runs 1
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
copy="$(mktemp -d "${TMPDIR:-/tmp}/flue-loom-evals.XXXXXX")"
trap 'rm -rf "$copy"' EXIT

tar -C "$root" --exclude=node_modules --exclude=.git --exclude=evals/results --exclude='*.mcpb' -cf - . | tar -C "$copy" -xf -

status=0
claude plugin eval "$copy" --scaffold --trust-plugin --allow-tools Write Edit --output-dir "$copy/evals/results/latest" "$@" || status=$?

if [ -d "$copy/evals/results/latest" ]; then
	dest="$root/evals/results/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
	mkdir -p "$dest"
	cp -R "$copy/evals/results/latest/." "$dest/"
	echo "results: $dest"
fi
exit "$status"
