import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Settings, settingsToPluginConfig } from "../../../../packages/memory/config/settings";
import { DEFAULT_SETTINGS_PATH } from "../fixtures/settings-file-fixture";

function observeEnabledFrom(enabled: boolean): boolean {
	const shipped = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as Settings;
	return settingsToPluginConfig({ ...shipped, telemetry: { ...shipped.telemetry,
		observe: { ...shipped.telemetry.observe, enabled } } }).observe.enabled;
}

describe("observe config", () => {
	it("turns observability on or off exactly as settings.telemetry.observe.enabled says", () => {
		expect(observeEnabledFrom(false)).toBe(false);
		expect(observeEnabledFrom(true)).toBe(true);
	});
});
