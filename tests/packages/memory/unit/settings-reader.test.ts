/** Proves the memory service's strict `settings.json` reader (PRD single-settings-file, change 1). */

import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSettingsPath, readSettings } from "../../../../packages/memory/src/contract/profile";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { settingsToPluginConfig } from "../../../../packages/memory/config/settings";
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

/** Returns the part of the refusal between `<path>: ` and the setup link, after checking both ends. */
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
	const tail = "; see https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md";
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

it("refuses a 63-character store.encryptionKey", async () => {
	const { path } = writeSettingsFixture(root, { store: { encryptionKey: "a".repeat(63) } });
	expect(await refusal(path)).toContain("store.encryptionKey");
});

it("refuses a non-hex store.encryptionKey", async () => {
	const { path } = writeSettingsFixture(root, { store: { encryptionKey: "g".repeat(64) } });
	expect(await refusal(path)).toContain("store.encryptionKey");
});

it("refuses an uppercase store.encryptionKey", async () => {
	const { path } = writeSettingsFixture(root, { store: { encryptionKey: "A".repeat(64) } });
	expect(await refusal(path)).toContain("store.encryptionKey");
});

it("refuses a non-UUID user.id", async () => {
	const { path } = writeSettingsFixture(root, { user: { id: "not-a-uuid" } });
	expect(await refusal(path)).toContain("user.id");
});

it("refuses a UUID-v4 user.id", async () => {
	const { path } = writeSettingsFixture(root, { user: { id: "e64bc6da-26cf-4e1c-b173-1e7c3c27e52c" } });
	expect(await refusal(path)).toContain("user.id");
});

it("refuses an uppercase UUID-v7 user.id", async () => {
	const { path } = writeSettingsFixture(root, { user: { id: "01997C9B-843F-70FB-8B86-86FC5CE574AE" } });
	expect(await refusal(path)).toContain("user.id");
});

it("reads a lowercase UUID-v7 user.id", async () => {
	const id = "01997c9b-843f-70fb-8b86-86fc5ce574ae";
	writeSettingsFixture(root, { user: { id } });
	expect((await readSettings()).user.id).toBe(id);
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

it("reads the local lesson generation destination from shipped settings", async () => {
	writeSettingsFixture(root);

	expect((await readSettings()).modelCalls.R5).toEqual({
		"local-first": "host", "agent-native": "off", "rem-enhanced": "off",
	});
});

it("reads published settings without the local lesson row and preserves supplied destinations", async () => {
	const { path, settings } = writeSettingsFixture(root, {
		modelCalls: { R2: { "agent-native": "off" } },
	});
	const calls = group(settings, "modelCalls");
	delete calls.R5;
	rewrite(path, settings);
	expect(Object.keys(calls)).toHaveLength(31);
	const read = await readSettings();
	expect(read.modelCalls.R5).toEqual({
		"local-first": "host", "agent-native": "off", "rem-enhanced": "off",
	});
	const { R5, ...supplied } = read.modelCalls;
	expect(supplied).toEqual(calls);
	const plugin = settingsToPluginConfig(read);
	expect(plugin.modelCalls).toEqual(read.modelCalls);
});

it("honors an explicit disabled local lesson row in settings and plugin configuration", async () => {
	writeSettingsFixture(root, {
		modelCalls: { R5: { "local-first": "off", "agent-native": "off", "rem-enhanced": "off" } },
	});
	const read = await readSettings();
	expect(read.modelCalls.R5["local-first"]).toBe("off");
	expect(pluginConfigSchema.parse({ mode: "local-first", modelCalls: read.modelCalls }).modelCalls)
		.toEqual(read.modelCalls);
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
	expect(read.user.id).toBe("");
	expect(read.modelCalls.R3).toEqual({
		"local-first": "off",
		"agent-native": "sno-gpu",
		"rem-enhanced": "sno-gpu",
	});
	expect(read.store.encryptionKey).toBe(group(settings, "store").encryptionKey);
	expect(read.store.encryptionKey).toMatch(/^[0-9a-f]{64}$/u);
});
