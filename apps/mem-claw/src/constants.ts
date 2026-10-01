import {
	HOST_MODEL_CALLBACK_HOST,
	HOST_MODEL_CALLBACK_PATH,
} from "@snoai/memory/internal/config/skin-defaults";

export const APP_NAME: "sno-mem-claw" = "sno-mem-claw";
export const APP_DISPLAY_NAME: "Memory service for OpenClaw" = "Memory service for OpenClaw";
export const APP_DESCRIPTION: "Long-term memory service for OpenClaw" =
	"Long-term memory service for OpenClaw";
export const SKIN_ID: "mem-claw" = "mem-claw";

export const HOST_REGISTRATION_SESSION_ID: "host-registration" = "host-registration";
export const HOST_COMMAND_SESSION_ID: "host-command" = "host-command";
export const HOST_MODEL_ID: "host-agent" = "host-agent";

export const MODEL_CALLBACK: {
	readonly host: typeof HOST_MODEL_CALLBACK_HOST;
	readonly path: typeof HOST_MODEL_CALLBACK_PATH;
	readonly maxBodyBytes: number;
	readonly timeoutMs: number;
} = {
	host: HOST_MODEL_CALLBACK_HOST,
	path: HOST_MODEL_CALLBACK_PATH,
	maxBodyBytes: 8 * 1024 * 1024,
	timeoutMs: 120_000,
} as const;

export const MINIMUM_CONVERSATION_GATE_VERSION: readonly [2026, 6, 9] = [2026, 6, 9];
