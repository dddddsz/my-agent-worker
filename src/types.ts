export type ChatRole = "user" | "assistant";

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface AiChatMessage {
	role: ChatRole | "system";
	content: string;
}
