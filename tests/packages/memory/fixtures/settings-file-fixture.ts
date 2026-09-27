/** Writes a complete, valid `<profile root>/settings.json` the way `sno` writes it. */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type SettingsDocument = { [key: string]: unknown };

export const MEMORY_PACKAGE_PATH = fileURLToPath(
	new URL("../../../../packages/memory", import.meta.url),
);
export const DEFAULT_SETTINGS_PATH = join(MEMORY_PACKAGE_PATH, "settings.default.json");

function isGroup(value: unknown): value is SettingsDocument {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(base: SettingsDocument, overrides: SettingsDocument): SettingsDocument {
	const merged: SettingsDocument = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		const current = merged[key];
		merged[key] = isGroup(current) && isGroup(value) ? merge(current, value) : value;
	}
	return merged;
}

/**
 * Reads the shipped default document, sets a 64-hex `store.encryptionKey`, fills the four machine
 * paths inside `profileRoot`, turns observe off (the shipped default sends to production; a test
 * that exercises observe turns it on and points `baseUrl` at a loopback), deep-merges `overrides` (objects merge, everything else replaces),
 * and writes `profileRoot/settings.json` at 0600.
 */
export function writeSettingsFixture(
	profileRoot: string,
	overrides: SettingsDocument = {},
): { path: string; settings: SettingsDocument } {
	const shipped = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, "utf8")) as SettingsDocument;
	const settings = merge(
		merge(shipped, {
			store: {
				path: join(profileRoot, "sno-station-mem", userInfo().username, "memory.sqlite"),
				encryptionKey: randomBytes(32).toString("hex"),
			},
			embedding: { cacheDir: join(profileRoot, ".cache", "sno-station", "models") },
			memoryPackage: { path: MEMORY_PACKAGE_PATH, node: process.execPath },
			telemetry: { observe: { enabled: false } },
		}),
		overrides,
	);
	const path = join(profileRoot, "settings.json");
	mkdirSync(profileRoot, { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`);
	chmodSync(path, 0o600);
	return { path, settings };
}
