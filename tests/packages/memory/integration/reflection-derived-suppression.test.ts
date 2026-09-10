/**
 * Reflection derived-injection suppression after `/new` / `/reset`.
 *
 * When a session-boundary reflection action (`command:new` / `command:reset`)
 * runs, derived deltas from the just-closed session must NOT leak into the
 * fresh-prompt window. Suppression lasts
 * `DEFAULT_REFLECTION_BOUNDARY_DERIVED_SUPPRESSION_MS` (120s).
 *
 * Two derived injection paths must both honor the suppression:
 *   - v2 `<derived-focus>` (priority 15, gated by `injectMode === "inheritance+derived"`)
 *   - v3 `<reflection-derived>` (priority 14, gated by `injectIntoPrompt: true`)
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createReflectionHarness,
	installEmbeddedRunnerStub,
	type ReflectionHarness,
} from "./_helpers/reflection-command-new-harness.ts";

beforeAll(() => {
	installEmbeddedRunnerStub();
});

const harnesses: ReflectionHarness[] = [];
let diagnosticWrites: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	vi.stubEnv("LOG_LEVEL", "debug");
	diagnosticWrites = vi.spyOn(process.stderr, "write");
});
function hasSuppression(reason: string): boolean {
	return diagnosticWrites.mock.calls.some(([bytes]) => {
		try {
			const record = JSON.parse(String(bytes));
			return record.event_name === "memory.reflection_injection_hooks.reflection.derived.injection.suppressed"
				&& record.attributes.reason_code === reason && record.severity_text === "DEBUG";
		} catch { return false; }
	});
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	while (harnesses.length > 0) {
		const h = harnesses.pop();
		try {
			h?.cleanup();
		} catch {
			// best-effort
		}
	}
});

function newHarness(
	options?: Parameters<typeof createReflectionHarness>[0],
): Promise<ReflectionHarness> {
	return createReflectionHarness(options).then((h) => {
		harnesses.push(h);
		return h;
	});
}

function tk(name: string, agentId = "main"): string {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	return `agent:${agentId}:${name}-${suffix}`;
}

const REFLECTION_MARKDOWN_WITH_DERIVED = `## Context
- Suppression behavioral test.

## Invariants
- Always run typecheck after editing TypeScript files.

## Derived
- BOUNDARY-DERIVED-LEAK-MARKER should not leak post-boundary.
- Another delta that must also stay suppressed.
`;

async function fireV2DerivedFocus(
	h: ReflectionHarness,
	params: { sessionKey: string; agentId: string },
): Promise<{ prependContext?: string } | undefined> {
	const reg = h.harness.registeredOnHooks.find(
		(x) => x.hookName === "before_prompt_build" && x.opts?.priority === 15,
	);
	if (!reg) return undefined;
	const handler = reg.handler as (
		event: unknown,
		ctx: Record<string, unknown>,
	) => Promise<{ prependContext?: string } | undefined>;
	const result = await handler(
		{},
		{ sessionKey: params.sessionKey, agentId: params.agentId, workspaceDir: h.workspaceDir },
	);
	return (result as { prependContext?: string } | undefined) ?? undefined;
}

async function fireSessionEnd(
	h: ReflectionHarness,
	params: { sessionKey: string; agentId: string; sessionId?: string },
): Promise<void> {
	const reg = h.harness.registeredOnHooks.find(
		(x) => x.hookName === "session_end" && x.opts?.priority === 20,
	);
	if (!reg) throw new Error("session_end hook not registered");
	const handler = reg.handler as (
		event: unknown,
		ctx: Record<string, unknown>,
	) => Promise<undefined>;
	await handler(
		{},
		{
			sessionKey: params.sessionKey,
			sessionId: params.sessionId ?? params.sessionKey,
			agentId: params.agentId,
		},
	);
}

describe("reflection derived suppression", () => {
	it("v2 derived-focus: `/new` suppresses derived injection in same-session fresh prompt", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "inheritance+derived",
					storeToDb: true,
					injectIntoPrompt: false,
				},
			},
			reflectionMarkdown: REFLECTION_MARKDOWN_WITH_DERIVED,
		});

		const sessionKey = tk("v2-new-suppress");
		await h.fireCommandNew({ sessionKey, agentId: "main", action: "new" });
		await h.pollForReflectionRow(8000);

		const result = await fireV2DerivedFocus(h, { sessionKey, agentId: "main" });
		const text = result?.prependContext ?? "";
		expect(text).not.toContain("<derived-focus>");
		expect(text).not.toContain("BOUNDARY-DERIVED-LEAK-MARKER");
		expect(hasSuppression("new")).toBe(true);
	});

	it("v3 reflection-derived: `/reset` suppresses derived block (flag ON)", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
			reflectionMarkdown: REFLECTION_MARKDOWN_WITH_DERIVED,
		});

		const sessionKey = tk("v3-reset-suppress");
		await h.fireCommandNew({ sessionKey, agentId: "main", action: "reset" });
		await h.pollForReflectionRow(8000);

		const result = await h.firePromptBuild({ sessionKey, agentId: "main" });
		const text = result?.prependContext ?? "";
		// Reflection-invariants must still appear (suppression is derived-only).
		expect(text).toContain("<reflection-invariants>");
		// Derived block must be suppressed.
		expect(text).not.toContain("<reflection-derived>");
		expect(text).not.toContain("BOUNDARY-DERIVED-LEAK-MARKER");
		expect(hasSuppression("reset")).toBe(true);
	});

	it("non-boundary recall: prompt-build without prior boundary command leaves derived injection enabled", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
			reflectionMarkdown: REFLECTION_MARKDOWN_WITH_DERIVED,
		});

		// Run a reflection from a DIFFERENT session so derived rows exist in the DB.
		const seedSession = tk("seed");
		await h.fireCommandNew({ sessionKey: seedSession, agentId: "main", action: "new" });
		await h.pollForReflectionRow(8000);

		// Now fire prompt-build on a brand-new session that NEVER hit a boundary
		// reflection — suppression Map has no entry for this key.
		const freshSession = tk("non-boundary-recall");
		const result = await h.firePromptBuild({ sessionKey: freshSession, agentId: "main" });
		const text = result?.prependContext ?? "";
		expect(text).toContain("<reflection-derived>");
		expect(text).toContain("BOUNDARY-DERIVED-LEAK-MARKER");
		// No suppression event logged for this session key.
		expect(
			h.harness.logMessages.debug.some((m) => m.includes(freshSession)),
		).toBe(false);
	});

	it("session_end clears suppression so the next session is not blocked", async () => {
		const h = await newHarness({
			pluginConfigOverrides: {
				memoryReflection: {
					injectMode: "none",
					storeToDb: true,
					injectIntoPrompt: true,
				},
			},
			reflectionMarkdown: REFLECTION_MARKDOWN_WITH_DERIVED,
		});

		const sessionKey = tk("session-end-clears");
		await h.fireCommandNew({ sessionKey, agentId: "main", action: "new" });
		await h.pollForReflectionRow(8000);

		// Confirm suppression is in effect first.
		const beforeEnd = await h.firePromptBuild({ sessionKey, agentId: "main" });
		expect(beforeEnd?.prependContext ?? "").not.toContain("<reflection-derived>");

		// Clear the prior debug log entries so we can assert the next outcome cleanly.
		h.harness.logMessages.debug.length = 0;

		// Fire session_end for that sessionKey — should evict suppression.
		await fireSessionEnd(h, { sessionKey, agentId: "main" });

		// A fresh sessionKey for the "next" session: derived injection runs as normal.
		const nextSession = tk("session-end-next");
		const afterEnd = await h.firePromptBuild({ sessionKey: nextSession, agentId: "main" });
		const text = afterEnd?.prependContext ?? "";
		expect(text).toContain("<reflection-derived>");
		expect(text).toContain("BOUNDARY-DERIVED-LEAK-MARKER");
	});
});
