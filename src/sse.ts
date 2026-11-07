const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DONE = Symbol("done");

export const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache",
	"x-accel-buffering": "no",
};

export function sseEvent(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function extractText(value: unknown): string {
	if (!value || typeof value !== "object") return "";

	const payload = value as {
		response?: unknown;
		choices?: Array<{
			delta?: { content?: unknown };
			message?: { content?: unknown };
		}>;
	};

	if (typeof payload.response === "string") return payload.response;

	const choice = payload.choices?.[0];
	const content = choice?.delta?.content ?? choice?.message?.content;
	return typeof content === "string" ? content : "";
}

function parseLine(rawLine: string): string | typeof DONE | null {
	const line = rawLine.trim();
	if (!line || line.startsWith(":")) return null;

	let data: string;
	if (line.startsWith("data:")) {
		data = line.slice(5).trim();
	} else if (line.startsWith("{")) {
		// Some providers omit the SSE "data:" prefix.
		data = line;
	} else {
		return null;
	}

	if (!data) return null;
	if (data === "[DONE]") return DONE;

	try {
		const text = extractText(JSON.parse(data));
		return text || null;
	} catch {
		return null;
	}
}

/**
 * Convert a Workers AI SSE stream into our own SSE protocol.
 *
 * - start: sent immediately with the conversation ID
 * - delta: incremental text
 * - done:  persisted status after the full reply is stored
 * - error: upstream failure or empty reply
 *
 * If the client disconnects, `cancel()` aborts the upstream reader and the
 * partial assistant reply is intentionally NOT persisted.
 */
export function createSseResponse(
	upstream: ReadableStream<Uint8Array>,
	conversationId: string,
	persist: (fullText: string) => Promise<boolean>,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	let buffer = "";
	let fullText = "";
	let finished = false;
	let cancelled = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(sseEvent("start", { conversationId }));
			void pump(controller);
		},
		cancel(reason) {
			cancelled = true;
			void reader.cancel(reason).catch(() => undefined);
		},
	});

	async function finish(controller: ReadableStreamDefaultController<Uint8Array>) {
		if (finished) return;
		finished = true;

		if (!fullText.trim()) {
			controller.enqueue(sseEvent("error", { error: "AI returned an empty response" }));
			controller.close();
			return;
		}

		let persisted = false;
		try {
			persisted = await persist(fullText);
		} catch (error) {
			console.error("failed to persist assistant message", error);
		}

		controller.enqueue(sseEvent("done", { conversationId, persisted }));
		controller.close();
	}

	async function pump(controller: ReadableStreamDefaultController<Uint8Array>) {
		try {
			while (!cancelled) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);

					const parsed = parseLine(line);
					if (parsed === DONE) {
						await finish(controller);
						return;
					}
					if (parsed) {
						fullText += parsed;
						controller.enqueue(sseEvent("delta", { text: parsed }));
					}
				}
			}

			// Flush any trailing partial UTF-8 sequence before the final line.
			buffer += decoder.decode();

			if (buffer.trim()) {
				const parsed = parseLine(buffer);
				if (parsed && parsed !== DONE) {
					fullText += parsed;
					controller.enqueue(sseEvent("delta", { text: parsed }));
				}
			}

			if (!cancelled) await finish(controller);
		} catch (error) {
			if (cancelled || finished) return;
			console.error("AI stream failed", error);
			finished = true;
			controller.enqueue(sseEvent("error", { error: "AI stream failed" }));
			controller.close();
		}
	}
}
