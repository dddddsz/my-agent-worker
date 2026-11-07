import { SYSTEM_PROMPT, WINDOW_SIZE } from "./config";
import type { AiChatMessage, ChatMessage } from "./types";

/**
 * Prompt Layer: a fixed system prompt plus the most recent conversation
 * messages. The system prompt is not stored and is not part of the window.
 */
export function buildMessages(window: ChatMessage[]): AiChatMessage[] {
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		...window.slice(-WINDOW_SIZE).map(({ role, content }) => ({ role, content })),
	];
}
