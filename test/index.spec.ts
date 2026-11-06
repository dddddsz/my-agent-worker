import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

const API_KEY = "test-key";

type ChatMessage = { role: string; content: string };

function makeEnv(overrides: Record<string, unknown> = {}): Env {
	return { KV: env.KV, API_KEY, ...overrides } as unknown as Env;
}

function makeAi(reply = "assistant reply") {
	const calls: ChatMessage[][] = [];
	const run = vi.fn(async (_model: string, input: { messages: ChatMessage[] }) => {
		calls.push(input.messages);
		return { response: reply };
	});
	return { ai: { run } as unknown as Ai, calls };
}

function chatRequest(body: unknown, token = API_KEY): Request {
	return new Request("http://example.com/api/chat", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
}

function getRequest(path: string, token = API_KEY): Request {
	return new Request(`http://example.com${path}`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

const ctx = {} as ExecutionContext;

describe("POST /api/chat", () => {
	it("rejects requests without a valid API key", async () => {
		const response = await worker.fetch(chatRequest({ message: "hi" }, "wrong"), makeEnv(), ctx);
		expect(response.status).toBe(401);
	});

	it("creates a conversation, calls AI, and persists both messages", async () => {
		const { ai, calls } = makeAi("你好，我是助手");
		const testEnv = makeEnv({ AI: ai });

		const response = await worker.fetch(chatRequest({ message: "你好" }), testEnv, ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			conversationId: string;
			reply: string;
			persisted: boolean;
		};
		expect(body.reply).toBe("你好，我是助手");
		expect(body.persisted).toBe(true);
		expect(body.conversationId).toMatch(/^[0-9a-f-]{36}$/i);

		expect(calls[0]).toEqual([{ role: "user", content: "你好" }]);

		const stored = await testEnv.KV.get<ChatMessage[]>(
			`conv:${body.conversationId}`,
			"json",
		);
		expect(stored).toEqual([
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "你好，我是助手" },
		]);
	});

	it("sends prior history when continuing an existing conversation", async () => {
		const { ai, calls } = makeAi("你叫小明");
		const testEnv = makeEnv({ AI: ai });

		const first = await worker.fetch(chatRequest({ message: "我叫小明" }), testEnv, ctx);
		const { conversationId } = (await first.json()) as { conversationId: string };

		const second = await worker.fetch(
			chatRequest({ conversationId, message: "我叫什么？" }),
			testEnv,
			ctx,
		);
		expect(second.status).toBe(200);

		expect(calls[1]).toEqual([
			{ role: "user", content: "我叫小明" },
			{ role: "assistant", content: "你叫小明" },
			{ role: "user", content: "我叫什么？" },
		]);

		const stored = await testEnv.KV.get<ChatMessage[]>(`conv:${conversationId}`, "json");
		expect(stored).toHaveLength(4);
	});

	it("returns 200 with persisted:false when KV write fails", async () => {
		const { ai } = makeAi("still answering");
		const kv = {
			get: env.KV.get.bind(env.KV),
			put: async () => {
				throw new Error("kv unavailable");
			},
		} as unknown as KVNamespace;
		const testEnv = makeEnv({ AI: ai, KV: kv });

		const response = await worker.fetch(chatRequest({ message: "hello" }), testEnv, ctx);
		expect(response.status).toBe(200);

		const body = (await response.json()) as { reply: string; persisted: boolean };
		expect(body.reply).toBe("still answering");
		expect(body.persisted).toBe(false);
	});

	it("rejects empty messages and malformed conversation IDs", async () => {
		const testEnv = makeEnv({ AI: makeAi().ai });

		const empty = await worker.fetch(chatRequest({ message: "   " }), testEnv, ctx);
		expect(empty.status).toBe(400);

		const badId = await worker.fetch(
			chatRequest({ message: "hi", conversationId: "not-a-uuid" }),
			testEnv,
			ctx,
		);
		expect(badId.status).toBe(400);
	});

	it("rejects non-POST methods", async () => {
		const response = await worker.fetch(getRequest("/api/chat"), makeEnv(), ctx);
		expect(response.status).toBe(405);
	});
});

describe("GET /api/conversations/:id", () => {
	it("returns the stored messages", async () => {
		const { ai } = makeAi("remembered");
		const testEnv = makeEnv({ AI: ai });

		const created = await worker.fetch(chatRequest({ message: "hi" }), testEnv, ctx);
		const { conversationId } = (await created.json()) as { conversationId: string };

		const response = await worker.fetch(
			getRequest(`/api/conversations/${conversationId}`),
			testEnv,
			ctx,
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as { conversationId: string; messages: ChatMessage[] };
		expect(body.conversationId).toBe(conversationId);
		expect(body.messages).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "remembered" },
		]);
	});

	it("returns 404 for an unknown conversation", async () => {
		const response = await worker.fetch(
			getRequest(`/api/conversations/${crypto.randomUUID()}`),
			makeEnv(),
			ctx,
		);
		expect(response.status).toBe(404);
	});

	it("rejects malformed IDs", async () => {
		const response = await worker.fetch(
			getRequest("/api/conversations/not-a-uuid"),
			makeEnv(),
			ctx,
		);
		expect(response.status).toBe(400);
	});
});
