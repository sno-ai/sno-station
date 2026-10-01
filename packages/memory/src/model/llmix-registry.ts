import { FIXED_EXTERNAL_VALUE_8, FIXED_EXTERNAL_VALUE_9 } from "./signed-registry-constants";
import { isTransientLlmStatus } from "./llm-failure";
/** @file llmix-registry.ts
 * @purpose Loads the bundled signed LLMIx registry for sno-station-mem.
 * @boundary Trust-anchor verification and package-relative asset resolution only.
 */

import { Buffer } from "node:buffer";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DidWebVerifier } from "@snoai/mda-config";
import {
	ConfigRegistryManager,
	loadLlmixTrustManifest,
	registryRootOptionsFromTrustManifest,
	type Provider,
} from "@snoai/llmix";
import type {
	LlmPreset,
	LlmProvider,
	ResolvedLlmConfig,
} from "./llm-client-types";

export const SNO_STATION_MEM_RELEASE_ANCHOR_URL: typeof FIXED_EXTERNAL_VALUE_8 =
	FIXED_EXTERNAL_VALUE_8;
export const SNO_STATION_MEM_RELEASE_DID = "did:web:www.sno.ai";
export const SNO_STATION_MEM_RELEASE_KEY_ID: typeof FIXED_EXTERNAL_VALUE_9 =
	FIXED_EXTERNAL_VALUE_9;
export const SNO_STATION_MEM_RELEASE_ANCHOR_TIMEOUT_MS = 5_000;
const SNO_STATION_MEM_RELEASE_ANCHOR_ATTEMPTS = 2;
const SNO_STATION_MEM_RELEASE_ANCHOR_RETRY_DELAY_MS = 50;
const ALLOWED_HTTP_ENDPOINT_HOSTS = new Set(["localhost", "127.0.0.1", "100.100.200.71"]);

type RegistryManager = Awaited<ReturnType<typeof ConfigRegistryManager.open>>;

type RegistryPaths = {
	registryDir: string;
	trustManifestPath: string;
};

type ReleaseAnchorVerifierOptions = {
	anchorTimeoutMs?: number;
};

export type ResolvedBundledLlmixEndpoint = {
	url: string;
	preset: ResolvedLlmConfig;
};

function parsePresetId(preset: LlmPreset): { module: string; preset: string } {
	const [module, presetName] = preset.split("/");
	if (!module || !presetName) {
		throw new Error(`sno-station-mem llm-client: invalid LLMIx preset id "${preset}"`);
	}
	return { module, preset: presetName };
}

function assertSupportedProvider(provider: Provider): LlmProvider {
	if (provider === "openai" || provider === "openrouter" || provider === "sno-gpu") {
		return provider;
	}
	throw new Error(`sno-station-mem llm-client: unsupported LLMIx provider "${provider}"`);
}

function resolveEndpointBase(baseSource: string, preservePath: boolean): string {
	let parsed: URL;
	try {
		parsed = new URL(baseSource);
	} catch {
		throw new Error(`sno-station-mem llm-client: invalid extraction.llm.baseURL "${baseSource}"`);
	}
	if (parsed.protocol !== "https:" && !ALLOWED_HTTP_ENDPOINT_HOSTS.has(parsed.hostname)) {
		throw new Error("sno-station-mem llm-client: extraction.llm.baseURL must use https");
	}
	if (parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "api.openai.com") {
		throw new Error(
			"sno-station-mem llm-client: direct api.openai.com transport is forbidden; use local ccproxy or an explicit custom endpoint",
		);
	}
	if (!preservePath) return parsed.origin;
	const base = parsed.toString();
	return base.endsWith("/") ? base : `${base}/`;
}

function packageRootFromImportMeta(): string {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const bundledRoot = path.resolve(moduleDir, "..");
	const sourceRoot = path.resolve(moduleDir, "../..");
	return [bundledRoot, sourceRoot].find(hasBundledRegistryAssets) ?? bundledRoot;
}

function hasBundledRegistryAssets(packageRoot: string): boolean {
	return (
		existsSync(path.join(packageRoot, "config", "llm", "current.json")) &&
		existsSync(path.join(packageRoot, "config", "llm.trust.json"))
	);
}

export function resolveBundledLlmixRegistryPaths(packageRoot: string = packageRootFromImportMeta()): RegistryPaths {
	const registryDir = path.join(packageRoot, "config", "llm");
	const trustManifestPath = path.join(packageRoot, "config", "llm.trust.json");
	if (!hasBundledRegistryAssets(packageRoot)) {
		throw new Error("sno-station-mem LLMIx registry assets are missing from the installed package");
	}
	return { registryDir, trustManifestPath };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPublicKeyJwk(document: unknown): JsonWebKey | null {
	if (!isJsonObject(document) || document.id !== SNO_STATION_MEM_RELEASE_DID) return null;
	const methods = document.verificationMethod;
	if (!Array.isArray(methods)) return null;
	for (const method of methods) {
		if (!isJsonObject(method) || method.id !== SNO_STATION_MEM_RELEASE_KEY_ID) continue;
		const jwk = method.publicKeyJwk;
		if (
			isJsonObject(jwk) &&
			jwk.kty === "OKP" &&
			jwk.crv === "Ed25519" &&
			typeof jwk.x === "string"
		) {
			return jwk as JsonWebKey;
		}
	}
	return null;
}

function verifyEd25519(jwk: JsonWebKey, paeBytes: Uint8Array, signature: string): boolean {
	const publicKey = createPublicKey({ key: jwk, format: "jwk" });
	return verifySignature(
		null,
		Buffer.from(paeBytes),
		publicKey,
		Buffer.from(signature, "base64"),
	);
}

function releaseAnchorFailureMessage(error: unknown): string | null {
	if (!isJsonObject(error) || !isJsonObject(error.details)) return null;
	const cause = error.details.cause;
	if (typeof cause !== "string") return null;
	return cause.includes("sno-station-mem LLMIx release anchor fetch") ? cause : null;
}

async function fetchReleaseAnchorOnce(
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new Error(`sno-station-mem LLMIx release anchor fetch timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			fetchImpl(SNO_STATION_MEM_RELEASE_ANCHOR_URL, { signal: controller.signal }),
			timeoutPromise,
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function isTransientAnchorResponse(response: Response): boolean {
	return isTransientLlmStatus(response.status);
}

async function fetchReleaseAnchor(
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<Response> {
	for (let attempt = 1; attempt <= SNO_STATION_MEM_RELEASE_ANCHOR_ATTEMPTS; attempt++) {
		try {
			const response = await fetchReleaseAnchorOnce(fetchImpl, timeoutMs);
			if (attempt === SNO_STATION_MEM_RELEASE_ANCHOR_ATTEMPTS || !isTransientAnchorResponse(response)) {
				return response;
			}
		} catch (error) {
			if (attempt === SNO_STATION_MEM_RELEASE_ANCHOR_ATTEMPTS) throw error;
		}
		await new Promise<void>((resolve) =>
			setTimeout(resolve, SNO_STATION_MEM_RELEASE_ANCHOR_RETRY_DELAY_MS),
		);
	}
	throw new Error("sno-station-mem LLMIx release anchor fetch exhausted");
}

export function createSnoMemSnoStationMemDidWebVerifier(
	fetchImpl: typeof fetch = globalThis.fetch,
	options: ReleaseAnchorVerifierOptions = {},
): DidWebVerifier {
	const anchorTimeoutMs = options.anchorTimeoutMs ?? SNO_STATION_MEM_RELEASE_ANCHOR_TIMEOUT_MS;
	return {
		async verify(input) {
			if (input.domain !== "www.sno.ai" || input.keyId !== SNO_STATION_MEM_RELEASE_KEY_ID) {
				return false;
			}
			if (input.algorithm !== "ed25519") return false;
			const response = await fetchReleaseAnchor(fetchImpl, anchorTimeoutMs);
			if (!response.ok) return false;
			const jwk = readPublicKeyJwk(await response.json());
			if (jwk === null) return false;
			return verifyEd25519(jwk, input.paeBytes, input.signature);
		},
	};
}

export async function openBundledLlmixRegistry(
	packageRoot?: string,
	fetchImpl: typeof fetch = globalThis.fetch,
	options: ReleaseAnchorVerifierOptions = {},
): Promise<RegistryManager> {
	const paths = resolveBundledLlmixRegistryPaths(packageRoot);
	const trustManifest = await loadLlmixTrustManifest(paths.trustManifestPath);
	const signedRoot = registryRootOptionsFromTrustManifest(trustManifest, {
		didWebVerifier: createSnoMemSnoStationMemDidWebVerifier(fetchImpl, options),
	});
	try {
		return await ConfigRegistryManager.open(paths.registryDir, { signedRoot });
	} catch (error) {
		const anchorFailure = releaseAnchorFailureMessage(error);
		if (anchorFailure !== null) throw new Error(anchorFailure, { cause: error });
		throw error;
	}
}

export async function resolveBundledLlmixPreset(
	presetId: LlmPreset,
): Promise<ResolvedLlmConfig> {
	const registry = await openBundledLlmixRegistry();
	return loadBundledLlmixPreset(registry, presetId);
}

async function loadBundledLlmixPreset(
	registry: RegistryManager,
	presetId: LlmPreset,
): Promise<ResolvedLlmConfig> {
	const id = parsePresetId(presetId);
	const preset = await registry.getPreset(id.module, id.preset);
	return {
		preset: presetId,
		provider: assertSupportedProvider(preset.provider),
		model: preset.model,
		...(preset.providerOptions ? { providerOptions: preset.providerOptions } : {}),
		...(preset.timeout?.totalTime ? { timeoutMs: preset.timeout.totalTime * 1_000 } : {}),
	};
}

export function materializeBundledLlmixEndpoint(input: {
	preset: ResolvedLlmConfig;
	baseSource: string;
}): ResolvedBundledLlmixEndpoint {
	const path =
		input.preset.provider === "sno-gpu"
			? input.preset.providerOptions?.["sno-gpu"]?.gpuPath
			: "chat/completions";
	if (!path) {
		throw new Error(
			`sno-station-mem llm-client: signed endpoint path missing from preset ${input.preset.preset}`,
		);
	}
	return {
		url: new URL(
			path,
			resolveEndpointBase(input.baseSource, input.preset.provider !== "sno-gpu"),
		).toString(),
		preset: input.preset,
	};
}

export async function resolveConfiguredBundledLlmixEndpoint(input: {
	configuredPresetId: LlmPreset;
	selectEndpointPreset: (provider: LlmProvider) => LlmPreset;
	selectBaseSource: (provider: LlmProvider) => string;
}): Promise<ResolvedBundledLlmixEndpoint> {
	const registry = await openBundledLlmixRegistry();
	const configured = await loadBundledLlmixPreset(registry, input.configuredPresetId);
	const endpointPresetId = input.selectEndpointPreset(configured.provider);
	const endpointPreset =
		endpointPresetId === input.configuredPresetId
			? configured
			: await loadBundledLlmixPreset(registry, endpointPresetId);
	return materializeBundledLlmixEndpoint({
		preset: endpointPreset,
		baseSource: input.selectBaseSource(configured.provider),
	});
}
