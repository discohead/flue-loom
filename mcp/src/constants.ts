// Max size (in characters) of a single tool response body before truncation.
export const CHARACTER_LIMIT = 25_000;

// Default wall-clock timeout for streaming agent invocations.
export const DEFAULT_STREAM_TIMEOUT_MS = 300_000; // 5 minutes

// Hard cap on the number of SSE events accumulated in flue_stream_agent's
// event log. Real Flue streams emit O(10–1000) events per turn, so this
// only fires for runaway / pathological upstreams. Text and result
// accumulation continue past the cap so the agent's output is never lost.
export const MAX_EVENTS = 5000;
