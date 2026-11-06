/**
 * M0: minimal multi-turn chat backend.
 *
 * Routes:
 *   POST /api/chat                 -> { conversationId, reply, persisted }
 *   GET  /api/conversations/:id    -> { conversationId, messages }
 *
 * Auth: `Authorization: Bearer <API_KEY>` (set in .dev.vars locally).
 * Storage: KV key `conv:<uuid>` -> JSON array of chat messages.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;

declare global {
	interface Env {
		API_KEY: string;
	}
}

type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

type AiResult = {
	response?: string;
	choices?: Array<{ message?: { content?: string } }>;
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function isAuthorized(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	return Boolean(env.API_KEY) && token === env.API_KEY;
}

function extractReply(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const output = result as AiResult;
	const content = output.response ?? output.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : "";
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
		return json({ error: `message too long (max ${MAX_MESSAGE_LENGTH} characters)` }, 400);
	}

	const requestedId =
		typeof body.conversationId === "string" ? body.conversationId.trim() : "";
	if (requestedId && !isValidConversationId(requestedId)) {
		return json({ error: "conversationId must be a UUID" }, 400);
	}
	const conversationId = requestedId || crypto.randomUUID();
	const key = `conv:${conversationId}`;

	let history: ChatMessage[];
	try {
		history = (await env.KV.get<ChatMessage[]>(key, "json")) ?? [];
		if (!Array.isArray(history)) history = [];
	} catch (error) {
		console.error("KV read failed", error);
		return json({ error: "failed to read conversation" }, 500);
	}

	history.push({ role: "user", content: message });

	let result: unknown;
	try {
		result = await env.AI.run(MODEL, {
			messages: history.slice(-MAX_MESSAGES),
		});
	} catch (error) {
		console.error("AI call failed", error);
		return json({ error: "AI call failed" }, 502);
	}

	const reply = extractReply(result);
	if (!reply) return json({ error: "AI returned an empty response" }, 502);

	history.push({ role: "assistant", content: reply });

	let persisted = true;
	try {
		await env.KV.put(key, JSON.stringify(history.slice(-MAX_MESSAGES)));
	} catch (error) {
		console.error("KV write failed", error);
		persisted = false;
	}

	return json({ conversationId, reply, persisted });
}

async function handleGetConversation(id: string, env: Env): Promise<Response> {
	let messages: ChatMessage[] | null;
	try {
		messages = await env.KV.get<ChatMessage[]>(`conv:${id}`, "json");
	} catch (error) {
		console.error("KV read failed", error);
		return json({ error: "failed to read conversation" }, 500);
	}

	if (!messages) return json({ error: "conversation not found" }, 404);
	return json({ conversationId: id, messages });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (!pathname.startsWith("/api/")) {
			return json({ error: "not found" }, 404);
		}

		if (!isAuthorized(request, env)) {
			return json({ error: "unauthorized" }, 401);
		}

		if (pathname === "/api/chat") {
			if (request.method !== "POST") {
				return new Response(JSON.stringify({ error: "method not allowed" }), {
					status: 405,
					headers: { "content-type": "application/json", allow: "POST" },
				});
			}
			return handleChat(request, env);
		}

		const match = pathname.match(/^\/api\/conversations\/([^/]+)$/);
		if (match) {
			if (request.method !== "GET") {
				return new Response(JSON.stringify({ error: "method not allowed" }), {
					status: 405,
					headers: { "content-type": "application/json", allow: "GET" },
				});
			}
			const id = decodeURIComponent(match[1]);
			if (!isValidConversationId(id)) {
				return json({ error: "conversationId must be a UUID" }, 400);
			}
			return handleGetConversation(id, env);
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
