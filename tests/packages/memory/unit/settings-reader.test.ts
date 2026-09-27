/** Proves the memory service's strict `settings.json` reader (PRD single-settings-file, change 1). */

import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSettingsPath, readSettings } from "../../../../packages/memory/src/contract/profile";
import {
	DEFAULT_SETTINGS_PATH,
	type SettingsDocument,
	writeSettingsFixture,
} from "../fixtures/settings-file-fixture";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "profile-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function group(doc: SettingsDocument, ...keys: string[]): SettingsDocument {
	let current: unknown = doc;
	for (const key of keys) current = (current as SettingsDocument)[key];
	expect(current, keys.join(".")).toBeTypeOf("object");
	return current as SettingsDocument;
}

function rewrite(path: string, doc: SettingsDocument): void {
	writeFileSync(path, JSON.stringify(doc));
}

/** Returns the part of the refusal between `<path>: ` and `; run sno setup`, after checking both ends. */
async function refusal(path: string): Promise<string> {
	let failure: unknown;
	try {
		await readSettings();
	} catch (error) {
		failure = error;
	}
	expect(failure, "readSettings accepted the file").toBeInstanceOf(Error);
	const message = (failure as Error).message;
	const head = `settings unavailable: ${path}: `;
	const tail = "; run sno setup";
	expect(message.startsWith(head), message).toBe(true);
	expect(message.endsWith(tail), message).toBe(true);
	return message.slice(head.length, message.length - tail.length);
}

it("takes the path from the profile root", () => {
	expect(getSettingsPath()).toBe(join(root, "settings.json"));
});

it("refuses a missing file", async () => {
	await refusal(join(root, "settings.json"));
});

it("refuses an unknown key and names it", async () => {
	const { path, settings } = writeSettingsFixture(root);
	rewrite(path, { ...settings, extraneousSetting: true });
	expect(await refusal(path)).toContain("extraneousSetting");
});

it("refuses a missing field and names it", async () => {
	const { path, settings } = writeSettingsFixture(root);
	const prompt = group(settings, "recall", "prompt");
	expect(prompt).toHaveProperty("minScore");
	delete prompt.minScore;
	rewrite(path, settings);
	expect(await refusal(path)).toContain("recall.prompt.minScore");
});

it("refuses an empty store.encryptionKey", async () => {
	const { path } = writeSettingsFixture(root, { store: { encryptionKey: "" } });
	expect(await refusal(path)).toContain("store.encryptionKey");
});

it("refuses a value outside its allowed values", async () => {
	const { path } = writeSettingsFixture(root, { mode: "fast" });
	expect(await refusal(path)).toContain("mode");
});

it("refuses a modelCalls table missing one id", async () => {
	const { path, settings } = writeSettingsFixture(root);
	const calls = group(settings, "modelCalls");
	expect(calls).toHaveProperty("R3");
	delete calls.R3;
	rewrite(path, settings);
	const field = await refusal(path);
	expect(field).toContain("modelCalls");
	expect(field).toContain("R3");
});

it("refuses a modelCalls table with an extra id", async () => {
	const { path } = writeSettingsFixture(root, {
		modelCalls: { R9: { "local-first": "off", "agent-native": "host", "rem-enhanced": "host" } },
	});
	const field = await refusal(path);
	expect(field).toContain("modelCalls");
	expect(field).toContain("R9");
});

it("reads a 0644 file with valid content", async () => {
	const { path } = writeSettingsFixture(root, { mode: "local-first" });
	chmodSync(path, 0o644);
	expect((await readSettings()).mode).toBe("local-first");
});

it("refuses the shipped default as-is for its empty encryption key", async () => {
	const path = join(root, "settings.json");
	copyFileSync(DEFAULT_SETTINGS_PATH, path);
	expect(await refusal(path)).toContain("store.encryptionKey");
});

it("parses the shipped default once sno fills the key and the four machine paths", async () => {
	const { settings } = writeSettingsFixture(root, { mode: "rem-enhanced" });
	const read = await readSettings();
	expect(read.mode).toBe("rem-enhanced");
	expect(read.modelCalls.R3).toEqual({
		"local-first": "off",
		"agent-native": "sno-gpu",
		"rem-enhanced": "sno-gpu",
	});
	expect(read.store.encryptionKey).toBe(group(settings, "store").encryptionKey);
	expect(read.store.encryptionKey).toMatch(/^[0-9a-f]{64}$/u);
});
