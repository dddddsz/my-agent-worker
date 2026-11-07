export const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Hard cap on messages stored per conversation. */
export const MAX_STORED_MESSAGES = 100;

/** Number of recent messages sent to the model (system prompt excluded). */
export const WINDOW_SIZE = 10;

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_OUTPUT_TOKENS = 512;

export const SYSTEM_PROMPT = `You are a helpful assistant.
Reply in the user's language. Be concise.`;
