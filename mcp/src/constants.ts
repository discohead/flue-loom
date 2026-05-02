// Maximum size (in characters) of a single tool response body before
// truncation kicks in. Picked to keep individual responses well under
// most clients' context budget while leaving headroom for tool descriptions
// and other turns. Override per-call by passing smaller payloads or by
// using sync mode (which omits the events log).
export const CHARACTER_LIMIT = 25_000;

// Default timeout for streaming agent invocations. SSE streams have no
// natural cap and a stalled agent can hang the call indefinitely.
export const DEFAULT_STREAM_TIMEOUT_MS = 300_000; // 5 minutes

// Hard cap on the number of SSE events accumulated in flue_stream_agent's
// event log before it stops growing. Real Flue streams emit O(10–1000)
// events per turn, so this only kicks in for pathological / runaway
// upstreams. Text and result accumulation continue past the cap so the
// agent's actual output is never lost.
export const MAX_EVENTS = 5000;
