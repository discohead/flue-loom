#!/usr/bin/env bash
# Invoke a Flue agent via SSE and stream events to stdout.
# Usage:
#   sse-invoke.sh <url> <payload-json>
#
# Example:
#   sse-invoke.sh http://localhost:3583/agents/hello/test-1 '{}'
#
# Emits:
#   - text events to stdout as plain text (the LLM's streaming output)
#   - other events (start, tool_use, idle) to stderr as JSON for debugging
#   - the final result to stdout as a final line: RESULT: <json>

set -euo pipefail

url="${1:-}"
payload="${2:-{}}"

if [ -z "$url" ]; then
	echo "usage: sse-invoke.sh <url> <payload-json>" >&2
	exit 2
fi

# curl -N disables buffering; -X POST with SSE headers triggers streaming mode.
# Read line-by-line and parse `event: …` + `data: …` pairs.

curl -N -sS -X POST \
	-H 'Accept: text/event-stream' \
	-H 'Content-Type: application/json' \
	-d "$payload" \
	"$url" \
| awk '
	BEGIN { event = ""; data = ""; }
	/^event: / { event = substr($0, 8); next; }
	/^data: / {
		data = substr($0, 7);
		if (event == "text") {
			# Print the streaming text directly. Decode \n in JSON-ish text.
			# Simplest pragmatic decode: replace common escapes; let consumers
			# handle the rest.
			gsub(/\\n/, "\n", data);
			gsub(/\\"/, "\"", data);
			# data is JSON of shape {"text":"..."}. Strip the wrapper if needed.
			if (match(data, /^\{"text":"/)) {
				# Drop {"text":" prefix and "} suffix.
				inner = substr(data, RLENGTH + 1);
				sub(/"\}\s*$/, "", inner);
				printf "%s", inner;
			} else {
				printf "%s", data;
			}
		} else if (event == "result") {
			print "";
			print "RESULT: " data;
		} else {
			# Diagnostic events to stderr.
			printf "[%s] %s\n", event, data > "/dev/stderr";
		}
		event = ""; data = "";
		next;
	}
	/^$/ { event = ""; data = ""; next; }
'
