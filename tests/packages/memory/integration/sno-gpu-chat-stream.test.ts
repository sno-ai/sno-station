import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { DispatchContext } from "../../../../packages/memory/src/model/llm-client-types.ts";
import { callProvider } from "../../../../packages/memory/src/model/llm-provider-transport.ts";

// Cloudflare cut non-streamed Sno GPU extractions at 125 s with HTTP 524 (2026-10-27); a streamed reply keeps
// bytes flowing. The wrapper sends `: ping` comments until the first token and the usage in the last chunk.
async function withGpu(writeReply: (response: ServerResponse) => Promise<void>, run: (url: string) => Promise<void>) {
	const bodies: Record<string, unknown>[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
		await writeReply(response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP server has no port");
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
	return bodies;
}

function context(url: string): DispatchContext {
	return {
		provider: "sno-gpu", model: "qwen3.8-27b-extract", apiKey: "internal-token",
		messages: [{ role: "user", content: "Extract durable memories as JSON" }],
		kwargs: { max_tokens: 16_384 },
		config: { provider: "sno-gpu", model: "qwen3.8-27b-extract", endpointUrl: `${url}/extract/v1/chat/completions` },
	};
}

const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe("Sno GPU chat replies are streamed", () => {
	it("asks for a stream with usage and joins split frames, pings and usage into the non-streamed result", async () => {
		const frames = [
			": ping\n\n",
			chunk({ id: "chatcmpl-1", model: "qwen3.8-27b-extract", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
			chunk({ id: "chatcmpl-1", model: "qwen3.8-27b-extract", choices: [{ index: 0, delta: { content: '{"facts":[{"fact":"Larry ' }, finish_reason: null }] }),
			chunk({ id: "chatcmpl-1", model: "qwen3.8-27b-extract", choices: [{ index: 0, delta: { content: 'uses vitest"}]}' }, finish_reason: "stop" }] }),
			chunk({ id: "chatcmpl-1", model: "qwen3.8-27b-extract", choices: [], usage: { prompt_tokens: 3003, completion_tokens: 2725, total_tokens: 5728 } }),
			"data: [DONE]\n\n",
		].join("");
		let result: Awaited<ReturnType<typeof callProvider>> | undefined;
		const bodies = await withGpu(async (response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			// Cut the bytes mid-frame and mid-character so assembly cannot rely on TCP write boundaries.
			for (let at = 0; at < frames.length; at += 37) {
				response.write(frames.slice(at, at + 37));
				await sleep(1);
			}
			response.end();
		}, async (url) => { result = await callProvider(context(url)); });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, max_tokens: 16_384 });
		expect(result).toEqual({
			success: true,
			content: '{"facts":[{"fact":"Larry uses vitest"}]}',
			model: "qwen3.8-27b-extract",
			usage: { inputTokens: 3003, outputTokens: 2725, totalTokens: 5728 },
		});
	});

	it("fails a stream that carries no choice as a missing-content 502 instead of an empty answer", async () => {
		let error: unknown;
		await withGpu(async (response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`: ping\n\n${chunk({ id: "chatcmpl-2", choices: [], usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 } })}data: [DONE]\n\n`);
		}, async (url) => { error = await callProvider(context(url)).catch((caught: unknown) => caught); });

		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ statusCode: 502, message: "Chat completion response is missing choices[0].message.content" });
	});
});
