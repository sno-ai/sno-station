import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createSnoMemSnoStationMemDidWebVerifier,
	SNO_STATION_MEM_RELEASE_ANCHOR_URL,
	SNO_STATION_MEM_RELEASE_KEY_ID,
	openBundledLlmixRegistry,
} from "../../../../packages/sno-station-mem/src/model/llmix-registry.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const didDocument = {
	"@context": ["https://www.w3.org/ns/did/v1"],
	id: "did:web:www.sno.ai",
	verificationMethod: [
		{
			id: "did:web:www.sno.ai#sno-mem-openclaw-release",
			type: "JsonWebKey2020",
			controller: "did:web:www.sno.ai",
			publicKeyJwk: {
				kty: "OKP",
				crv: "Ed25519",
				x: "R3iNBApxAAc87QxWxd7aAFwwWOoEnYaKgLWKWBD-P_o",
			},
		},
	],
	assertionMethod: ["did:web:www.sno.ai#sno-mem-openclaw-release"],
};

function anchorFetch(input: string | URL | Request): Promise<Response> {
	if (String(input) === SNO_STATION_MEM_RELEASE_ANCHOR_URL) {
		return Promise.resolve(
			new Response(JSON.stringify(didDocument), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	}
	return Promise.resolve(new Response("not found", { status: 404 }));
}

describe("mem-claw signed LLMIx registry", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads all six signed presets through ConfigRegistryManager", async () => {
		const registry = await openBundledLlmixRegistry(undefined, anchorFetch as typeof fetch);
		await expect(registry.availablePresets()).resolves.toEqual([
			"mem_claw/openai_gpt_5_nano",
			"mem_claw/openrouter_auto",
			"mem_claw/sno_ai_extract",
			"mem_claw/sno_conflict_verdict",
			"mem_claw/sno_extract_chat",
			"mem_claw/sno_extract_profile",
		]);
		const openaiPreset = await registry.getPreset("mem_claw", "openai_gpt_5_nano");
		expect(openaiPreset).toMatchObject({
			provider: "openai",
			model: "gpt-5.6-terra",
		});
		expect(openaiPreset.providerOptions).toBeUndefined();
		const openrouterPreset = await registry.getPreset("mem_claw", "openrouter_auto");
		expect(openrouterPreset).toMatchObject({
			provider: "openrouter",
			model: "openrouter/auto",
		});
		expect(openrouterPreset.providerOptions).toBeUndefined();
		const snoGpuPreset = await registry.getPreset("mem_claw", "sno_ai_extract");
		expect(snoGpuPreset).toMatchObject({
			provider: "sno-gpu",
			model: "qwen3.8-27b-extract",
		});
		expect(snoGpuPreset.providerOptions).toBeUndefined();
	});

	it("rejects tampered generated registry output", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "mem-claw-llmix-"));
		tempRoots.push(tempRoot);
		cpSync(resolve(repoRoot, "packages/sno-station-mem/config"), join(tempRoot, "config"), {
			recursive: true,
		});
		const current = JSON.parse(
			readFileSync(join(tempRoot, "config/llm/current.json"), "utf8"),
		) as { revision: string };
		const resolvedPresetPath = join(
			tempRoot,
			"config/llm/compiled",
			current.revision,
			"resolved/mem_claw/sno_ai_extract.json",
		);
		const tampered = readFileSync(resolvedPresetPath, "utf8").replace(
			"qwen3.8-27b-extract",
			"qwen3.8-27b-tampered",
		);
		writeFileSync(resolvedPresetPath, tampered);

		await expect(openBundledLlmixRegistry(tempRoot, anchorFetch as typeof fetch)).rejects.toThrow();
	});

	it("rejects the wrong DID, wrong key id, and generic did:web fallback", async () => {
		const verifier = createSnoMemSnoStationMemDidWebVerifier(anchorFetch as typeof fetch);
		await expect(
			verifier.verify({
				domain: "www.sno.ai",
				keyId: "did:web:www.sno.ai#wrong",
				algorithm: "ed25519",
				signature: "",
				payloadType: "application/vnd.snoai.llmix.registry-root+json",
				payloadBytes: new Uint8Array(),
				paeBytes: new Uint8Array(),
			}),
		).resolves.toBe(false);
		await expect(
			verifier.verify({
				domain: "evil.example.test",
				keyId: SNO_STATION_MEM_RELEASE_KEY_ID,
				algorithm: "ed25519",
				signature: "",
				payloadType: "application/vnd.snoai.llmix.registry-root+json",
				payloadBytes: new Uint8Array(),
				paeBytes: new Uint8Array(),
			}),
		).resolves.toBe(false);
		expect(SNO_STATION_MEM_RELEASE_KEY_ID).toBe("did:web:www.sno.ai#sno-mem-openclaw-release");
	});

	it("fetches only the fixed Sno release anchor URL", async () => {
		const urls: string[] = [];
		const verifier = createSnoMemSnoStationMemDidWebVerifier((async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify(didDocument), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch);

		await verifier.verify({
			domain: "www.sno.ai",
			keyId: SNO_STATION_MEM_RELEASE_KEY_ID,
			algorithm: "ed25519",
			signature: "",
			payloadType: "application/vnd.snoai.llmix.registry-root+json",
			payloadBytes: new Uint8Array(),
			paeBytes: new Uint8Array(),
		});

		expect(urls).toEqual([SNO_STATION_MEM_RELEASE_ANCHOR_URL]);
		expect(urls).not.toContain("https://www.sno.ai/.well-known/did.json");
	});

	it("fails fast when the release anchor fetch stalls", async () => {
		const hangingFetch = (() => new Promise<Response>(() => {})) as typeof fetch;

		await expect(
			openBundledLlmixRegistry(undefined, hangingFetch, { anchorTimeoutMs: 10 }),
		).rejects.toThrow("sno-station-mem LLMIx release anchor fetch timed out after 10ms");
	});
});
