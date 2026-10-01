/** @file conversation-access-policy.ts
 * @purpose Grants this plugin host-level conversation access so its typed hooks register.
 * @boundary Reads host version + config, writes one host-config key via the SDK; gateway-mode only.
 * @see openclaw-plugin-runtime.ts (register), openclaw-runtime-mode.ts (isGatewayMode).
 */

import { createLogger as createDiagnosticLogger } from "@snoai/utils/logger";
const diagnosticLog = createDiagnosticLogger("mem-claw:conversation-access-policy");
import { isGatewayMode } from "@snoai/memory/internal/engine/bindings/sno-station-mem-runtime-mode";
import type { SnoStationMemPluginApi } from "../tools/memory-tool-dependencies";
import { APP_NAME, MINIMUM_CONVERSATION_GATE_VERSION } from "../constants";

/**
 * Minimum provider-v1 host version. The package is pinned to OpenClaw 2026.6.9,
 * so older hosts are treated as unsupported instead of carrying a compatibility
 * branch for pre-release provider behavior.
 */

/**
 * Parse the leading numeric `x.y.z` from a host version string, ignoring any
 * trailing suffix (`-beta.1`, build hash, etc.). Returns undefined when the
 * string does not start with a three-segment version — the safe signal that
 * we cannot prove the host enforces the gate.
 *
 * The regex is intentionally unanchored at the end: a real host reports
 * `"2026.6.9 (f066dd2)"` with a space-separated build hash, which an anchored
 * `…$` form would reject. Do not add an end anchor — the test locks this case.
 */
export function parseVersionTriple(raw: unknown): [number, number, number] | undefined {
	if (typeof raw !== "string") return undefined;
	const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when the host version is at or above the supported conversation-gate version. An
 * unparsable version returns false so we never patch a host we cannot vouch for.
 */
export function hostEnforcesConversationGate(rawVersion: unknown): boolean {
	const version = parseVersionTriple(rawVersion);
	if (!version) return false;
	const [major, minor, patch] = version;
	const [minMajor, minMinor, minPatch] = MINIMUM_CONVERSATION_GATE_VERSION;
	if (major !== minMajor) return major > minMajor;
	if (minor !== minMinor) return minor > minMinor;
	return patch >= minPatch;
}

/** Narrow view of the host config along the single path this module reads/writes. */
type HookPolicyConfigView = {
	plugins?: {
		entries?: Record<string, { hooks?: { allowConversationAccess?: boolean } }>;
	};
};

/** Reads whether the host config already grants this plugin conversation access. */
function conversationAccessAlreadyGranted(config: SnoStationMemPluginApi["config"]): boolean {
	const entry = (config as HookPolicyConfigView).plugins?.entries?.[APP_NAME];
	return entry?.hooks?.allowConversationAccess === true;
}

/**
 * Self-heal the host config so this plugin's typed conversation hooks
 * (auto-recall, reflection, ambient learning) are not silently blocked on
 * OpenClaw 2026.6.9+, which gates conversation access behind
 * `plugins.entries.<id>.hooks.allowConversationAccess=true` for non-bundled
 * plugins. The manifest cannot satisfy this gate — the host reads only the
 * per-plugin config entry — so we write it through the SDK on first start and
 * let the gateway restart to pick it up. A no-op once granted.
 *
 * Fire-and-forget: `register()` must return synchronously, and a successful
 * patch ends in a gateway restart that supersedes the rest of this start.
 */
export function ensureConversationAccessGranted(api: SnoStationMemPluginApi): void {
	// CLI subcommands (plugins install/uninstall, completion) also load the
	// plugin; only the live gateway should mutate the user's host config.
	if (!isGatewayMode()) return;
	if (!hostEnforcesConversationGate(api.runtime.version)) return;
	if (conversationAccessAlreadyGranted(api.config)) return;

	diagnosticLog.info("sno-mem-claw: granting hooks.allowConversationAccess in host config (required for typed hooks on OpenClaw 2026.6.9+); gateway will restart", undefined, {
		event_name: "mem_claw.conversation-access-policy.sno.mem.claw.granting.hooks.allowconversationaccess.in.host.config.req",
		file: "apps/mem-claw/src/install/conversation-access-policy.ts",
		function: "ensureConversationAccessGranted",
		site_id: "conversation-access-policy.ensureConversationAccessGranted.2e15c2b7fb",
	});

	api.runtime.config
		.mutateConfigFile({
			afterWrite: { mode: "restart", reason: "sno-mem-claw conversation-access policy" },
			mutate: (draft) => {
				const view = draft as unknown as HookPolicyConfigView;
				if (!view.plugins) view.plugins = {};
				if (!view.plugins.entries) view.plugins.entries = {};
				const entries = view.plugins.entries;
				const entry = entries[APP_NAME] ?? {};
				entry.hooks = { ...entry.hooks, allowConversationAccess: true };
				entries[APP_NAME] = entry;
			},
		})
		.catch((error: unknown) => {
			// error-grade, not warn: a failed grant leaves conversation hooks
			// (auto-recall, reflection, ambient learning) silently dead for the
			// whole session, which is invisible to the operator otherwise.
			diagnosticLog.error("Conversation access grant failed", { error }, { event_name: "memory.conversation_access_policy.conversation.access.grant.failed", file: "apps/mem-claw/src/install/conversation-access-policy.ts", function: "ensureConversationAccessGranted", site_id: "plugin.conversation-access-policy.ensureConversationAccessGranted.d508d2f9f8" });
		});
}
