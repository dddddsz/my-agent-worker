/**
 * M1: D1-backed multi-turn chat with SSE streaming.
 *
 * Routes:
 *   POST /api/chat                 -> text/event-stream (start / delta / done / error)
 *   GET  /api/conversations/:id    -> { conversationId, messages }
 *
 * Auth: `Authorization: Bearer <API_KEY>` (set in .dev.vars locally).
 * Storage: D1, at most MAX_STORED_MESSAGES messages per conversation.
 * Prompt: fixed system prompt + the newest WINDOW_SIZE messages.
 */

import { MAX_MESSAGE_LENGTH, MAX_OUTPUT_TOKENS, MODEL } from "./config";
import {
	appendAssistantMessage,
	appendUserMessage,
	conversationExists,
	createConversation,
	getConversation,
	getWindow,
} from "./db";
import { buildMessages } from "./prompt";
import { createSseResponse, SSE_HEADERS } from "./sse";
import type { ChatMessage } from "./types";

declare global {
	interface Env {
		API_KEY: string;
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function methodNotAllowed(allow: string): Response {
	return new Response(JSON.stringify({ error: "method not allowed" }), {
		status: 405,
		headers: {
			"content-type": "application/json; charset=utf-8",
			allow,
		},
	});
}

function isAuthorized(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	return Boolean(env.API_KEY) && token === env.API_KEY;
}

function isValidConversationId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function handleChat(request: Request, env: Env): Promise<Response> {
	let body: { message?: unknown; conversationId?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: "invalid JSON body" }, 400);
	}

	const message = typeof body.message === "string" ? body.message.trim() : "";
	if (!message) return json({ error: "message is required" }, 400);
	if (message.length > MAX_MESSAGE_LENGTH) {
		return json(
			{ error: `message too long (max ${MAX_MESSAGE_LENGTH} characters)` },
			400,
		);
	}

	const requestedId =
		typeof body.conversationId === "string" ? body.conversationId.trim() : "";
	if (requestedId && !isValidConversationId(requestedId)) {
		return json({ error: "conversationId must be a UUID" }, 400);
	}

	let conversationId: string;
	try {
		if (requestedId) {
			if (!(await conversationExists(env.DB, requestedId))) {
				return json({ error: "conversation not found" }, 404);
			}
			conversationId = requestedId;
		} else {
			conversationId = crypto.randomUUID();
			await createConversation(env.DB, conversationId);
		}
		await appendUserMessage(env.DB, conversationId, message);
	} catch (error) {
		console.error("D1 write failed", error);
		return json({ error: "failed to store message" }, 500);
	}

	let window: ChatMessage[];
	try {
		window = await getWindow(env.DB, conversationId);
	} catch (error) {
		console.error("D1 read failed", error);
		return json({ error: "failed to read conversation" }, 500);
	}

	const messages = buildMessages(window);

	let upstream: ReadableStream<Uint8Array>;
	try {
		const result = await env.AI.run(MODEL, {
			messages,
			stream: true,
			max_tokens: MAX_OUTPUT_TOKENS,
		});
		if (!(result instanceof ReadableStream)) {
			throw new Error("AI did not return a stream");
		}
		upstream = result;
	} catch (error) {
		console.error("AI call failed", error);
		return json({ error: "AI call failed" }, 502);
	}

	const stream = createSseResponse(upstream, conversationId, async (fullText) => {
		await appendAssistantMessage(env.DB, conversationId, fullText);
		return true;
	});

	return new Response(stream, { headers: SSE_HEADERS });
}

async function handleGetConversation(
	id: string,
	env: Env,
): Promise<Response> {
	try {
		if (!(await conversationExists(env.DB, id))) {
			return json({ error: "conversation not found" }, 404);
		}
		const messages = await getConversation(env.DB, id);
		return json({ conversationId: id, messages });
	} catch (error) {
		console.error("D1 read failed", error);
		return json({ error: "failed to read conversation" }, 500);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (!pathname.startsWith("/api/")) {
			return json({ error: "not found" }, 404);
		}

		if (!isAuthorized(request, env)) {
			return json({ error: "unauthorized" }, 401);
		}

		if (pathname === "/api/chat") {
			if (request.method !== "POST") return methodNotAllowed("POST");
			return handleChat(request, env);
		}

		const match = pathname.match(/^\/api\/conversations\/([^/]+)$/);
		if (match) {
			if (request.method !== "GET") return methodNotAllowed("GET");
			const id = decodeURIComponent(match[1]);
			if (!isValidConversationId(id)) {
				return json({ error: "conversationId must be a UUID" }, 400);
			}
			return handleGetConversation(id, env);
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
