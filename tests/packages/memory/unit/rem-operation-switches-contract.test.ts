import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../../../../packages/memory/src/contract/profile";
import { writeSettingsFixture } from "../fixtures/settings-file-fixture";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function remSettings(rem: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "rem-settings-"));
	roots.push(root);
	vi.stubEnv("SNO_PROFILE_DIR", root);
	writeSettingsFixture(root, { rem });
	return readSettings().rem;
}

describe("REM settings", () => {
	it.each([
		[true, ["rem-update"]],
		[true, ["rem-replace"]],
		[true, ["rem-update", "rem-replace"]],
		[false, ["rem-update", "rem-replace"]],
	] as const)("reads tick %s and operation choices %j", (tick, operations) => {
		expect(remSettings({ tick, operations })).toEqual({ tick, operations });
	});

	it("rejects removed operations and an unknown switch", () => {
		expect(() => remSettings({ operations: ["rem-distill"] })).toThrow(/docs\/memory-setup\.md/);
		expect(() => remSettings({ operations: ["rem-update", "rem-retire"] })).toThrow(/docs\/memory-setup\.md/);
		expect(() => remSettings({ enabled: true })).toThrow(/docs\/memory-setup\.md/);
	});
});
