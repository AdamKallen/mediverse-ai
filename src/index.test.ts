import {
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./index";
import type { Env } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(aiRunImpl?: (model: string, opts: unknown) => unknown): Env {
	return {
		AI: {
			run: vi.fn(
				aiRunImpl ??
					(() => {
						const encoder = new TextEncoder();
						return new ReadableStream({
							start(controller) {
								controller.enqueue(
									encoder.encode('data: {"response":"Hi"}\n\n'),
								);
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							},
						});
					}),
			),
		} as unknown as Ai,
		ASSETS: {
			fetch: vi.fn(() =>
				Promise.resolve(new Response("<!doctype html>", { status: 200 })),
			),
		},
	};
}

function post(body: unknown) {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe("routing", () => {
	it("serves static assets for GET /", async () => {
		const env = makeEnv();
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request("http://localhost/"),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
	});

	it("returns 404 for unknown API routes", async () => {
		const env = makeEnv();
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request("http://localhost/api/unknown"),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(404);
	});

	it("returns 405 for GET /api/chat", async () => {
		const env = makeEnv();
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request("http://localhost/api/chat"),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(405);
	});
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("POST /api/chat – validation", () => {
	let env: Env;

	beforeEach(() => {
		env = makeEnv();
	});

	it("returns 400 for invalid JSON", async () => {
		const ctx = createExecutionContext();
		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		const json = await res.json<{ error: string }>();
		expect(json.error).toMatch(/invalid json/i);
	});

	it("returns 400 when messages is missing", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(post({}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
	});

	it("returns 400 when messages is empty array", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(post({ messages: [] }), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid role", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			post({ messages: [{ role: "hacker", content: "hi" }] }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		const json = await res.json<{ error: string }>();
		expect(json.error).toMatch(/role/i);
	});

	it("returns 400 for empty content", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			post({ messages: [{ role: "user", content: "   " }] }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		const json = await res.json<{ error: string }>();
		expect(json.error).toMatch(/content/i);
	});

	it("returns 400 when messages array exceeds limit", async () => {
		const ctx = createExecutionContext();
		const messages = Array.from({ length: 101 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: "x",
		}));
		const res = await worker.fetch(post({ messages }), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		const json = await res.json<{ error: string }>();
		expect(json.error).toMatch(/maximum length/i);
	});

	it("returns 400 when a message content exceeds max length", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			post({ messages: [{ role: "user", content: "x".repeat(32_001) }] }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
		const json = await res.json<{ error: string }>();
		expect(json.error).toMatch(/maximum length/i);
	});
});

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("POST /api/chat – happy path", () => {
	it("returns a streaming SSE response for a valid request", async () => {
		const env = makeEnv();
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			post({ messages: [{ role: "user", content: "Hello" }] }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
	});

	it("prepends system prompt when none provided", async () => {
		const env = makeEnv();
		const ctx = createExecutionContext();
		await worker.fetch(
			post({ messages: [{ role: "user", content: "Hello" }] }),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const calledMessages = (env.AI.run as ReturnType<typeof vi.fn>).mock
			.calls[0][1].messages as Array<{ role: string }>;
		expect(calledMessages[0].role).toBe("system");
	});

	it("does not duplicate system prompt when already present", async () => {
		const env = makeEnv();
		const ctx = createExecutionContext();
		await worker.fetch(
			post({
				messages: [
					{ role: "system", content: "Custom prompt" },
					{ role: "user", content: "Hello" },
				],
			}),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const calledMessages = (env.AI.run as ReturnType<typeof vi.fn>).mock
			.calls[0][1].messages as Array<{ role: string }>;
		const systemMessages = calledMessages.filter((m) => m.role === "system");
		expect(systemMessages).toHaveLength(1);
	});
});
