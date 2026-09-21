import { FIXED_PROTOCOL_VALUE_70, FIXED_PROTOCOL_VALUE_71, FIXED_PROTOCOL_VALUE_72, PERSISTED_PROVIDER_SYSTEM } from "../src/model/signed-registry-constants";
import { z } from "zod";

import { SNO_OBSERVE_DEFAULT_AGENT_ID, SNO_OBSERVE_DEFAULT_BASE_URL } from "./index";

const AGENT_IDS = [PERSISTED_PROVIDER_SYSTEM as typeof PERSISTED_PROVIDER_SYSTEM, FIXED_PROTOCOL_VALUE_70 as typeof FIXED_PROTOCOL_VALUE_70, FIXED_PROTOCOL_VALUE_71 as typeof FIXED_PROTOCOL_VALUE_71, FIXED_PROTOCOL_VALUE_72 as typeof FIXED_PROTOCOL_VALUE_72] as const;

function parseObserveEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "true" || normalized === "1";
}

function isLoopbackUrl(url: URL): boolean {
	return (
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "::1" ||
		url.hostname === "[::1]"
	);
}

function validateObserveBaseUrl(value: string, ctx: z.RefinementCtx): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["baseUrl"],
			message: `Invalid SNO_OBSERVE_BASE_URL: "${value}"`,
		});
		return;
	}
	const normalized = parsed.origin;
	if (process.env.SNO_STATION_MEM_NODE_ENV === "test" && isLoopbackUrl(parsed)) {
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["baseUrl"],
				message: "SNO_OBSERVE_BASE_URL test fixture must use http or https",
			});
		}
		return;
	}
	if (normalized !== SNO_OBSERVE_DEFAULT_BASE_URL) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["baseUrl"],
			message: `SNO_OBSERVE_BASE_URL must be ${SNO_OBSERVE_DEFAULT_BASE_URL} outside loopback tests`,
		});
	}
}

export const observeConfigSchema: z.ZodType<
	{ enabled: boolean; baseUrl: string; agentId: (typeof AGENT_IDS)[number] },
	unknown
> = z
	.object({
		enabled: z.boolean().default(parseObserveEnabled(process.env.SNO_OBSERVE_ENABLED)),
		baseUrl: z.string().default(process.env.SNO_OBSERVE_BASE_URL ?? SNO_OBSERVE_DEFAULT_BASE_URL),
		agentId: z
			.enum(AGENT_IDS, {
				error: () => `observe.agentId must be one of ${AGENT_IDS.join(", ")}`,
			})
			.default(SNO_OBSERVE_DEFAULT_AGENT_ID as (typeof AGENT_IDS)[number]),
	})
	.prefault({})
	.superRefine((value, ctx) => {
		if (value.enabled) {
			validateObserveBaseUrl(value.baseUrl, ctx);
		}
	});
