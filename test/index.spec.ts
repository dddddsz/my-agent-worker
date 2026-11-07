import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL, SYSTEM_PROMPT } from "../src/config";
import worker from "../src/index";
import type { AiChatMessage } from "../src/types";

const API_KEY = "test-key";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ctx = {} as ExecutionContext;

type StoredMessage = { role: string; content: string };
type SseEvent = { event: string; data: Record<string, unknown> };

function makeEnv(overrides: Record<string, unknown> = {}): Env {
	return {
		DB: env.DB,
		AI: env.AI,
		API_KEY,
		TEST_MIGRATIONS: env.TEST_MIGRATIONS,
		...overrides,
	} as unknown as Env;
}

function sseChunk(text: string): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`);
}

function makeAi(chunks: string[], options: { failAfter?: number } = {}) {
	const calls: AiChatMessage[][] = [];
	const run = vi.fn(async (_model: string, input: { messages: AiChatMessage[] }) => {
		calls.push(input.messages);
		let index = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (options.failAfter !== undefined && index >= options.failAfter) {
					controller.error(new Error("stream failed"));
					return;
				}
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				controller.enqueue(sseChunk(chunks[index++]));
			},
		});
	});
	return { ai: { run } as unknown as Ai, calls };
}

function makeHangingAi(firstChunk = "partial"): Ai {
	return {
		run: async () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(sseChunk(firstChunk));
					// Never closes: simulates a long-running answer.
				},
			}),
	} as unknown as Ai;
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

function parseSse(text: string): SseEvent[] {
	const events: SseEvent[] = [];
	for (const block of text.split("\n\n")) {
		if (!block.trim()) continue;
		const lines = block.split("\n");
		const event = lines
			.find((line) => line.startsWith("event:"))
			?.slice("event:".length)
			.trim();
		const data = lines
			.find((line) => line.startsWith("data:"))
			?.slice("data:".length)
			.trim();
		if (event && data) {
			events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
		}
	}
	return events;
}

async function collect(response: Response): Promise<SseEvent[]> {
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	return parseSse(await response.text());
}

async function storedMessages(conversationId: string): Promise<StoredMessage[]> {
	const { results } = await env.DB.prepare(
		"SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC",
	)
		.bind(conversationId)
		.all<StoredMessage>();
	return results ?? [];
}

async function seedConversation(id: string, count: number): Promise<void> {
	await env.DB.prepare("INSERT INTO conversations (id) VALUES (?)").bind(id).run();
	for (let i = 0; i < count; i++) {
		await env.DB.prepare(
			"INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
		)
			.bind(id, i % 2 === 0 ? "user" : "assistant", `m${i}`)
			.run();
	}
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM messages"),
		env.DB.prepare("DELETE FROM conversations"),
	]);
});

describe("auth", () => {
	it("rejects requests without a valid API key", async () => {
		const unauthorized = await worker.fetch(
			chatRequest({ message: "hi" }, "wrong"),
			makeEnv(),
			ctx,
		);
		expect(unauthorized.status).toBe(401);

		const missing = await worker.fetch(
			new Request("http://example.com/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "hi" }),
			}),
			makeEnv(),
			ctx,
		);
		expect(missing.status).toBe(401);
	});
});

describe("POST /api/chat", () => {
	it("streams a reply and persists both messages", async () => {
		const { ai, calls } = makeAi(["你", "好"]);
		const testEnv = makeEnv({ AI: ai });

		const response = await worker.fetch(
			chatRequest({ message: "你好" }),
			testEnv,
			ctx,
		);
		const events = await collect(response);

		const start = events.find((event) => event.event === "start");
		expect(start).toBeDefined();
		const conversationId = start?.data.conversationId as string;
		expect(conversationId).toMatch(/^[0-9a-f-]{36}$/i);

		expect(events.filter((event) => event.event === "delta")).toEqual([
			{ event: "delta", data: { text: "你" } },
			{ event: "delta", data: { text: "好" } },
		]);
		expect(events.at(-1)).toEqual({
			event: "done",
			data: { conversationId, persisted: true },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: "你好" },
		]);

		expect(await storedMessages(conversationId)).toEqual([
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "你好" },
		]);
	});

	it("sends the recent history when continuing a conversation", async () => {
		const { ai, calls } = makeAi(["你", "好"]);
		const testEnv = makeEnv({ AI: ai });

		const first = await worker.fetch(
			chatRequest({ message: "我叫小明" }),
			testEnv,
			ctx,
		);
		const firstEvents = await collect(first);
		const conversationId = firstEvents[0].data.conversationId as string;

		const second = await worker.fetch(
			chatRequest({ conversationId, message: "我叫什么？" }),
			testEnv,
			ctx,
		);
		const secondEvents = await collect(second);
		expect(secondEvents.at(-1)?.event).toBe("done");

		expect(calls[1]).toEqual([
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: "我叫小明" },
			{ role: "assistant", content: "你好" },
			{ role: "user", content: "我叫什么？" },
		]);

		expect(await storedMessages(conversationId)).toHaveLength(4);
	});

	it("only sends the latest 10 messages to the model", async () => {
		const conversationId = crypto.randomUUID();
		await seedConversation(conversationId, 12);
		const { ai, calls } = makeAi(["ok"]);
		const testEnv = makeEnv({ AI: ai });

		const response = await worker.fetch(
			chatRequest({ conversationId, message: "new" }),
			testEnv,
			ctx,
		);
		await collect(response);

		const window = calls[0];
		expect(window).toHaveLength(11); // system + 10 messages
		expect(window[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
		expect(window[1]).toEqual({ role: "assistant", content: "m3" });
		expect(window.at(-1)).toEqual({ role: "user", content: "new" });
	});

	it("keeps at most 100 messages per conversation", async () => {
		const conversationId = crypto.randomUUID();
		await seedConversation(conversationId, 100);
		const { ai } = makeAi(["ok"]);
		const testEnv = makeEnv({ AI: ai });

		const response = await worker.fetch(
			chatRequest({ conversationId, message: "new" }),
			testEnv,
			ctx,
		);
		await collect(response);

		const stored = await storedMessages(conversationId);
		expect(stored).toHaveLength(100);
		// Two oldest messages were pruned (user insert + assistant insert).
		expect(stored[0]).toEqual({ role: "user", content: "m2" });
		expect(stored.at(-1)).toEqual({ role: "assistant", content: "ok" });

		const readBack = await worker.fetch(
			getRequest(`/api/conversations/${conversationId}`),
			testEnv,
			ctx,
		);
		const body = (await readBack.json()) as { messages: StoredMessage[] };
		expect(body.messages).toHaveLength(100);
	});

	it("returns 404 for an unknown conversation and does not call the model", async () => {
		const { ai, calls } = makeAi(["nope"]);
		const testEnv = makeEnv({ AI: ai });
		const conversationId = crypto.randomUUID();

		const response = await worker.fetch(
			chatRequest({ conversationId, message: "hi" }),
			testEnv,
			ctx,
		);
		expect(response.status).toBe(404);
		expect(calls).toHaveLength(0);
		expect(await storedMessages(conversationId)).toEqual([]);
	});

	it("emits an error and keeps only the user message when the stream fails", async () => {
		const { ai } = makeAi(["part", "ial"], { failAfter: 2 });
		const testEnv = makeEnv({ AI: ai });

		const response = await worker.fetch(
			chatRequest({ message: "hello" }),
			testEnv,
			ctx,
		);
		const events = await collect(response);
		const conversationId = events[0].data.conversationId as string;

		expect(events.map((event) => event.event)).toEqual([
			"start",
			"delta",
			"delta",
			"error",
		]);
		expect(events.some((event) => event.event === "done")).toBe(false);

		expect(await storedMessages(conversationId)).toEqual([
			{ role: "user", content: "hello" },
		]);
	});

	it("emits an error for an empty reply and stores no assistant message", async () => {
		const { ai } = makeAi([]);
		const testEnv = makeEnv({ AI: ai });

		const response = await worker.fetch(
			chatRequest({ message: "hello" }),
			testEnv,
			ctx,
		);
		const events = await collect(response);
		const conversationId = events[0].data.conversationId as string;

		expect(events.at(-1)).toEqual({
			event: "error",
			data: { error: "AI returned an empty response" },
		});
		expect(await storedMessages(conversationId)).toEqual([
			{ role: "user", content: "hello" },
		]);
	});

	it("does not persist the assistant reply when the client disconnects", async () => {
		const testEnv = makeEnv({ AI: makeHangingAi() });

		const response = await worker.fetch(
			chatRequest({ message: "hello" }),
			testEnv,
			ctx,
		);
		expect(response.body).not.toBeNull();

		const reader = response.body!.getReader();
		const first = await reader.read();
		const startText = decoder.decode(first.value ?? new Uint8Array());
		const match = startText.match(/"conversationId":"([^"]+)"/);
		const conversationId = match?.[1];
		expect(conversationId).toBeTruthy();

		await reader.cancel("test disconnect");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(await storedMessages(conversationId!)).toEqual([
			{ role: "user", content: "hello" },
		]);
	});

	it("rejects invalid input", async () => {
		const testEnv = makeEnv({ AI: makeAi(["ok"]).ai });

		const empty = await worker.fetch(chatRequest({ message: "   " }), testEnv, ctx);
		expect(empty.status).toBe(400);

		const tooLong = await worker.fetch(
			chatRequest({ message: "a".repeat(4001) }),
			testEnv,
			ctx,
		);
		expect(tooLong.status).toBe(400);

		const badId = await worker.fetch(
			chatRequest({ message: "hi", conversationId: "not-a-uuid" }),
			testEnv,
			ctx,
		);
		expect(badId.status).toBe(400);

		const badJson = await worker.fetch(
			new Request("http://example.com/api/chat", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${API_KEY}`,
				},
				body: "{",
			}),
			testEnv,
			ctx,
		);
		expect(badJson.status).toBe(400);
	});

	it("rejects non-POST methods", async () => {
		const response = await worker.fetch(getRequest("/api/chat"), makeEnv(), ctx);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	it("uses the configured model", async () => {
		const calls: string[] = [];
		const ai = {
			run: async (model: string) => {
				calls.push(model);
				return new ReadableStream<Uint8Array>();
			},
		} as unknown as Ai;

		await worker.fetch(
			chatRequest({ message: "hi" }),
			makeEnv({ AI: ai }),
			ctx,
		);
		expect(calls).toEqual([MODEL]);
	});
});

describe("GET /api/conversations/:id", () => {
	it("returns the stored messages", async () => {
		const { ai } = makeAi(["remembered"]);
		const testEnv = makeEnv({ AI: ai });

		const created = await worker.fetch(
			chatRequest({ message: "hi" }),
			testEnv,
			ctx,
		);
		const events = await collect(created);
		const conversationId = events[0].data.conversationId as string;

		const response = await worker.fetch(
			getRequest(`/api/conversations/${conversationId}`),
			testEnv,
			ctx,
		);
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			conversationId: string;
			messages: StoredMessage[];
		};
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

	it("rejects malformed IDs and non-GET methods", async () => {
		const malformed = await worker.fetch(
			getRequest("/api/conversations/not-a-uuid"),
			makeEnv(),
			ctx,
		);
		expect(malformed.status).toBe(400);

		const wrongMethod = await worker.fetch(
			new Request(
				`http://example.com/api/conversations/${crypto.randomUUID()}`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${API_KEY}` },
				},
			),
			makeEnv(),
			ctx,
		);
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("GET");
	});
});
