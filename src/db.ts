import { MAX_STORED_MESSAGES, WINDOW_SIZE } from "./config";
import type { ChatMessage } from "./types";

/**
 * Keep only the newest MAX_STORED_MESSAGES messages for a conversation.
 * Run inside a batch so the insert + prune commit atomically.
 */
function pruneStatement(db: D1Database, conversationId: string): D1PreparedStatement {
	return db
		.prepare(
			`DELETE FROM messages
			 WHERE conversation_id = ?
			   AND id NOT IN (
			     SELECT id FROM messages
			     WHERE conversation_id = ?
			     ORDER BY id DESC
			     LIMIT ?
			   )`,
		)
		.bind(conversationId, conversationId, MAX_STORED_MESSAGES);
}

export async function conversationExists(
	db: D1Database,
	conversationId: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM conversations WHERE id = ?")
		.bind(conversationId)
		.first<{ id: string }>();
	return Boolean(row);
}

export async function createConversation(
	db: D1Database,
	conversationId: string,
): Promise<void> {
	await db
		.prepare("INSERT INTO conversations (id) VALUES (?)")
		.bind(conversationId)
		.run();
}

/**
 * Insert a user message and enforce the 100-message cap in one transaction.
 */
export async function appendUserMessage(
	db: D1Database,
	conversationId: string,
	content: string,
): Promise<void> {
	await db.batch([
		db
			.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)")
			.bind(conversationId, content),
		pruneStatement(db, conversationId),
	]);
}

/**
 * Insert an assistant message, enforce the cap, and bump the conversation
 * timestamp in one transaction.
 */
export async function appendAssistantMessage(
	db: D1Database,
	conversationId: string,
	content: string,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				"INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)",
			)
			.bind(conversationId, content),
		pruneStatement(db, conversationId),
		db
			.prepare("UPDATE conversations SET updated_at = unixepoch() WHERE id = ?")
			.bind(conversationId),
	]);
}

/**
 * Latest WINDOW_SIZE messages (including the just-inserted user message),
 * returned in chronological order for the model.
 */
export async function getWindow(
	db: D1Database,
	conversationId: string,
): Promise<ChatMessage[]> {
	const { results } = await db
		.prepare(
			`SELECT role, content FROM (
			   SELECT id, role, content FROM messages
			   WHERE conversation_id = ?
			   ORDER BY id DESC
			   LIMIT ?
			 ) ORDER BY id ASC`,
		)
		.bind(conversationId, WINDOW_SIZE)
		.all<ChatMessage>();
	return results ?? [];
}

/** All stored messages (at most MAX_STORED_MESSAGES), oldest first. */
export async function getConversation(
	db: D1Database,
	conversationId: string,
): Promise<ChatMessage[]> {
	const { results } = await db
		.prepare(
			`SELECT role, content FROM (
			   SELECT id, role, content FROM messages
			   WHERE conversation_id = ?
			   ORDER BY id DESC
			   LIMIT ?
			 ) ORDER BY id ASC`,
		)
		.bind(conversationId, MAX_STORED_MESSAGES)
		.all<ChatMessage>();
	return results ?? [];
}
