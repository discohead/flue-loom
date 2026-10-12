export const SERVER_NAME = 'flue-loom';
export const SERVER_VERSION = '0.2.0';

// Max characters of text returned in one tool result before truncation.
export const CHARACTER_LIMIT = 25_000;

// Where relative mount URLs ("/agents/support") and discovered project mounts
// point by default: Vite's dev server. Override with FLUE_LOOM_BASE_URL.
export const DEFAULT_BASE_URL = 'http://localhost:5173';

// How long flue_send_message / flue_read_reply wait for a settlement.
export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 3_600;

// Minimum spacing between progress notifications for streamed reply text.
export const PROGRESS_INTERVAL_MS = 250;

// Messages returned by flue_get_conversation unless the caller asks for more.
export const DEFAULT_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_MESSAGES = 200;
