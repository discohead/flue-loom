// Maximum size (in characters) of a single tool response body before
// truncation kicks in. Picked to keep individual responses well under
// most clients' context budget while leaving headroom for tool descriptions
// and other turns. Override per-call by passing smaller payloads or by
// using sync mode (which omits the events log).
export const CHARACTER_LIMIT = 25_000;

// Default timeout for streaming agent invocations. SSE streams have no
// natural cap and a stalled agent can hang the call indefinitely.
export const DEFAULT_STREAM_TIMEOUT_MS = 300_000; // 5 minutes
