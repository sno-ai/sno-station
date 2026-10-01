/** @file openclaw-plugin-runtime.ts
 * @purpose Exposes the OpenClaw plugin entry point and stable runtime helper exports.
 * @boundary SDK registration facade only; runtime composition lives in focused modules.
 * @see openclaw-runtime-registration.ts, openclaw-runtime-hooks.ts, openclaw-runtime-service.ts.
 */

import type {
	OpenClawPluginApi as SnoStationMemPluginApi,
	OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/core";
import { registerCompletionTools } from "../commands/openclaw-command-registration";
import { ensureConversationAccessGranted } from "./conversation-access-policy";
import { isCompletionMode } from "@snoai/memory/internal/engine/bindings/sno-station-mem-runtime-mode";
import { registerRuntime } from "./openclaw-runtime-registration";
import { APP_DESCRIPTION, APP_DISPLAY_NAME, APP_NAME } from "../constants";

export {
	deriveSessionDateTime,
	extractAllMessageTexts,
	isAmbientLearningMessage,
	normalizeMessageTimestampMs,
} from "@snoai/memory/internal/engine/bindings/sno-station-mem-message-transcript";
export {
	isChatIdBasedAgentId,
	isCompletionMode,
	isGatewayMode,
	parseAgentIdFromSessionKey,
	resolveHookAgentId,
} from "@snoai/memory/internal/engine/bindings/sno-station-mem-runtime-mode";
export { registerRuntime } from "./openclaw-runtime-registration";

export const memClawPlugin: OpenClawPluginDefinition = {
	id: APP_NAME,
	name: APP_DISPLAY_NAME,
	description: APP_DESCRIPTION,
	kind: "memory" as const,
	/** Registers the plugin definition with the OpenClaw host runtime. */
	register(api: SnoStationMemPluginApi): void {
		// OpenClaw expects register() to return synchronously. Runtime setup
		// continues in the background after config validation.

		if (isCompletionMode()) {
			registerCompletionTools(api);
			return;
		}

		// Self-heal the host config so our typed conversation hooks (auto-recall,
		// reflection, ambient learning) are not silently blocked on OpenClaw
		// 2026.6.9+, which gates conversation access behind a per-plugin config
		// key. No-op once granted; on first start it patches the config and the
		// gateway restarts to pick it up before the rest of registration matters.
		ensureConversationAccessGranted(api);

		registerRuntime(api);
	},
};

export default memClawPlugin;
