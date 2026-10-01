import http from "node:http";
import https from "node:https";
import {
	getArrayField,
	getObjectField,
	getStringField,
	isRecord,
	parseJson,
	parseJsonMaybe,
} from "./json";
import type {
	GatewayTurn,
	GatewayUsageSummary,
	HttpResult,
	JsonObject,
	TestConfig,
} from "./types";

export async function sendGatewayTurn(
	config: TestConfig,
	sessionKey: string,
	payload: JsonObject,
	options: { agentId?: string } = {},
): Promise<GatewayTurn> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${config.openClawToken}`,
		"Content-Type": "application/json",
		"x-openclaw-session-key": sessionKey,
	};
	const agentId = options.agentId ?? process.env.SNO_AGENT_E2E_AGENT_ID;
	if (agentId) {
		headers["x-openclaw-agent-id"] = agentId;
	}
	if (process.env.SNO_AGENT_E2E_MODEL_OVERRIDE) {
		headers["x-openclaw-model"] = process.env.SNO_AGENT_E2E_MODEL_OVERRIDE;
	}

	const response = await requestJson(`${config.gatewayUrl}/v1/responses`, {
		body: payload,
		headers,
		method: "POST",
		rejectUnauthorized: config.rejectUnauthorized,
		timeoutMs: config.gatewayTimeoutMs,
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(
			`Gateway /v1/responses failed with HTTP ${response.statusCode}: ${response.text}`,
		);
	}

	return {
		body: response.body,
		text: extractResponseText(response.body),
		usage: extractUsage(response.body),
	};
}

export type GatewayToolInvocation = {
	body: unknown;
	payload: JsonObject;
	result: JsonObject;
	text: string;
};

export async function invokeGatewayTool(
	config: TestConfig,
	sessionKey: string,
	payload: JsonObject,
): Promise<GatewayToolInvocation> {
	const response = await requestJson(`${config.gatewayUrl}/tools/invoke`, {
		body: { ...payload, sessionKey },
		headers: {
			Authorization: `Bearer ${config.openClawToken}`,
			"Content-Type": "application/json",
		},
		method: "POST",
		rejectUnauthorized: config.rejectUnauthorized,
		timeoutMs: config.gatewayTimeoutMs,
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(
			`Gateway /tools/invoke failed with HTTP ${response.statusCode}: ${response.text}`,
		);
	}
	if (!isRecord(response.body) || response.body.ok !== true) {
		throw new Error(`Gateway /tools/invoke returned failure: ${response.text}`);
	}
	const result = response.body.result;
	if (!isRecord(result)) {
		throw new Error(`Gateway /tools/invoke returned non-object result: ${response.text}`);
	}
	const text = extractToolResultText(result);
	const details = getObjectField(result, "details");
	const parsedText = parseJsonMaybe(text);
	const payloadObject = details ?? (isRecord(parsedText) ? parsedText : {});
	return {
		body: response.body,
		payload: payloadObject,
		result,
		text,
	};
}

export function summarizeGatewayUsage(usage: JsonObject): GatewayUsageSummary {
	return {
		completionTokens:
			numberFromObject(usage, [
				"output",
				"output_tokens",
				"outputTokens",
				"completion_tokens",
				"completionTokens",
			]) ?? 0,
		promptTokens:
			numberFromObject(usage, [
				"input",
				"input_tokens",
				"inputTokens",
				"prompt_tokens",
				"promptTokens",
			]) ?? 0,
	};
}

export async function requestJson(
	input: string,
	options: {
		body?: unknown;
		headers?: Record<string, string>;
		method?: string;
		rejectUnauthorized?: boolean;
		timeoutMs?: number;
	} = {},
): Promise<HttpResult> {
	const url = new URL(input);
	const bodyText =
		options.body === undefined ? undefined : JSON.stringify(options.body);
	const client = url.protocol === "https:" ? https : http;

	return new Promise((resolveRequest, rejectRequest) => {
		const request = client.request(
			url,
			{
				headers: {
					...(options.headers ?? {}),
					...(bodyText === undefined
						? {}
						: { "Content-Length": Buffer.byteLength(bodyText).toString() }),
				},
				method: options.method ?? "GET",
				rejectUnauthorized: options.rejectUnauthorized,
				timeout: options.timeoutMs ?? 30_000,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolveRequest({
						body: parseJson(text),
						headers: response.headers,
						statusCode: response.statusCode ?? 0,
						text,
					});
				});
			},
		);
		request.on("error", rejectRequest);
		request.on("timeout", () =>
			request.destroy(new Error(`HTTP timeout: ${input}`)),
		);
		if (bodyText !== undefined) {
			request.write(bodyText);
		}
		request.end();
	});
}

function extractResponseText(body: unknown): string {
	const texts: string[] = [];
	for (const item of getArrayField(body, "output")) {
		const itemText = getStringField(item, "text");
		if (itemText) {
			texts.push(itemText);
		}
		for (const content of getArrayField(item, "content")) {
			const text = getStringField(content, "text");
			if (text) {
				texts.push(text);
			}
		}
	}
	const directText = getStringField(body, "text");
	if (directText) {
		texts.push(directText);
	}
	return texts.join("\n").trim();
}

function extractToolResultText(body: unknown): string {
	const texts: string[] = [];
	for (const content of getArrayField(body, "content")) {
		const text = getStringField(content, "text");
		if (text) {
			texts.push(text);
		}
	}
	const directText = getStringField(body, "text");
	if (directText) {
		texts.push(directText);
	}
	return texts.join("\n").trim();
}

function extractUsage(body: unknown): JsonObject {
	if (!isRecord(body) || !isRecord(body.usage)) {
		return {};
	}
	return body.usage;
}

function numberFromObject(
	value: JsonObject,
	keys: readonly string[],
): number | undefined {
	for (const key of keys) {
		const field = value[key];
		if (typeof field === "number" && Number.isFinite(field) && field >= 0) {
			return Math.trunc(field);
		}
	}
	return undefined;
}
