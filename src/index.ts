/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

const VALID_ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 100;
const MAX_CONTENT_LENGTH = 32_000;

/**
 * Validates that messages is a non-empty array of well-formed ChatMessage objects.
 * Returns an error string on failure, or null if valid.
 */
function validateMessages(messages: unknown): string | null {
	if (!Array.isArray(messages) || messages.length === 0) {
		return "messages must be a non-empty array";
	}
	if (messages.length > MAX_MESSAGES) {
		return `messages array exceeds maximum length of ${MAX_MESSAGES}`;
	}
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) {
			return `messages[${i}] must be an object`;
		}
		const { role, content } = msg as Record<string, unknown>;
		if (typeof role !== "string" || !VALID_ROLES.has(role)) {
			return `messages[${i}].role must be "system", "user", or "assistant"`;
		}
		if (typeof content !== "string" || content.trim() === "") {
			return `messages[${i}].content must be a non-empty string`;
		}
		if (content.length > MAX_CONTENT_LENGTH) {
			return `messages[${i}].content exceeds maximum length of ${MAX_CONTENT_LENGTH}`;
		}
	}
	return null;
}

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		const messages: ChatMessage[] = Array.isArray((body as { messages?: unknown }).messages)
			? ((body as { messages: ChatMessage[] }).messages)
			: [];

		const validationError = validateMessages(messages);
		if (validationError) {
			return new Response(JSON.stringify({ error: validationError }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
				stream: true,
			},
			{
				// Uncomment to use AI Gateway
				// gateway: {
				//   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
				//   skipCache: false,      // Set to true to bypass cache
				//   cacheTtl: 3600,        // Cache time-to-live in seconds
				// },
			},
		);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}
