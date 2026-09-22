import { afterEach, describe, expect, it, vi } from "vitest";

const originalObserveEnabled = process.env.SNO_OBSERVE_ENABLED;

async function parseObserveEnabledWithEnv(
	value: string | undefined,
): Promise<boolean> {
	vi.resetModules();
	if (value === undefined) {
		delete process.env.SNO_OBSERVE_ENABLED;
	} else {
		process.env.SNO_OBSERVE_ENABLED = value;
	}
	const { pluginConfigSchema } = await import(
		"../../../../packages/memory/src/engine/shared/types.ts"
	);
	return pluginConfigSchema.parse({
		embedding: { provider: "local-onnx" },
	}).observe.enabled;
}

afterEach(() => {
	vi.resetModules();
	if (originalObserveEnabled === undefined) {
		delete process.env.SNO_OBSERVE_ENABLED;
	} else {
		process.env.SNO_OBSERVE_ENABLED = originalObserveEnabled;
	}
});

describe("observe config defaults", () => {
	it("keeps observability disabled unless explicitly enabled", async () => {
		await expect(parseObserveEnabledWithEnv(undefined)).resolves.toBe(false);
		await expect(parseObserveEnabledWithEnv("false")).resolves.toBe(false);
		await expect(parseObserveEnabledWithEnv("0")).resolves.toBe(false);
		await expect(parseObserveEnabledWithEnv("yes")).resolves.toBe(false);
		await expect(parseObserveEnabledWithEnv("true")).resolves.toBe(true);
		await expect(parseObserveEnabledWithEnv("1")).resolves.toBe(true);
	});
});
