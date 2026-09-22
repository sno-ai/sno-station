import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const GUARD = join(REPO_ROOT, "dev-scripts/check-llm-endpoint-construction.sh");
const SOURCE_ROOTS = [
	"contract", "model", "store", "sidecar",
	"engine/bindings", "engine/diagnostics", "engine/eval", "engine/extraction",
	"engine/i18n", "engine/maintenance", "engine/observability", "engine/operations",
	"engine/provider", "engine/reflection", "engine/retrieval", "engine/security",
	"engine/shared", "engine/telemetry",
].map((directory) => join(REPO_ROOT, "packages/memory/src", directory));
SOURCE_ROOTS.push(join(REPO_ROOT, "apps/mem-claw/src"));
const temporaryDirectories: string[] = [];

function runGuard(source: string): ReturnType<typeof spawnSync> {
	const directory = mkdtempSync(join(tmpdir(), "llm-endpoint-guard-"));
	temporaryDirectories.push(directory);
	const fixture = join(directory, "violation.ts");
	writeFileSync(fixture, source);
	return spawnSync("bash", [GUARD, fixture], { encoding: "utf8" });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("LLM endpoint construction guard", () => {
	it("rejects route concatenation", () => {
		const result = runGuard('const endpoint = `${baseUrl}/chat/completions`;\n');

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("route concatenation");
	});

	it("rejects two-argument URL construction", () => {
		const result = runGuard('const endpoint = new URL(completionPath, llmBaseUrl);\n');

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("two-argument URL join");
	});

	it("rejects a relative inference path joined to a generic base URL", () => {
		const result = runGuard(
			'const baseUrl = "https://example.invalid/v1";\nconst endpoint = new URL("chat/completions", baseUrl);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("two-argument URL join");
	});

	it("rejects inference client base URL configuration", () => {
		const result = runGuard(
			'const options = { baseURL };\nconst client = new InferenceClient(options);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("inference client base URL");
	});

	it("rejects direct fetches to inference routes", () => {
		const result = runGuard(
			'const endpoint = "https://example.test/v1/completions";\nawait fetch(endpoint);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("direct inference fetch");
	});

	it("rejects aliased fetches to inference routes", () => {
		const result = runGuard(
			'const request = fetch;\nconst endpoint = "https://example.test/v1/completions";\nawait request(endpoint);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("direct inference fetch");
	});

	it("rejects wrapped fetches to inference routes", () => {
		const result = runGuard(
			'const request = (url: string) => fetch(url);\nconst endpoint = "https://example.test/v1/completions";\nawait request(endpoint);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("direct inference fetch");
	});

	it("rejects global fetch aliases to inference routes", () => {
		const result = runGuard(
			'const request = globalThis.fetch;\nconst endpoint = "https://example.test/v1/completions";\nawait request(endpoint);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("direct inference fetch");
	});

	it("rejects global fetch wrappers to inference routes", () => {
		const result = runGuard(
			'const request = (url: string) => globalThis.fetch(url);\nconst endpoint = "https://example.test/v1/completions";\nawait request(endpoint);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("direct inference fetch");
	});

	it("rejects concat route construction", () => {
		const result = runGuard('const endpoint = origin.concat("/v1/completions");\n');

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("route concatenation");
	});

	it("rejects segmented route construction", () => {
		const result = runGuard(
			'const endpoint = [origin, "extract", "v1", "chat", "completions"].join("/");\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("route concatenation");
	});

	it("rejects aliased client base URL options", () => {
		const result = runGuard(
			'const base = { baseURL };\nconst options = base;\nnew InferenceClient(options);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("inference client base URL");
	});

	it("rejects spread client base URL options", () => {
		const result = runGuard(
			'const base = { baseURL };\nconst options = { ...base };\nnew InferenceClient(options);\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("inference client base URL");
	});

	it("rejects quoted client base URL options", () => {
		const result = runGuard(
			'new InferenceClient({ "baseURL": "https://example.test/v1" });\n',
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("inference client base URL");
	});

	it("allows standard module-relative URL construction", () => {
		const result = runGuard('const asset = new URL("./asset.json", import.meta.url);\n');

		expect(result.status, String(result.stderr)).toBe(0);
	});

	it("accepts the current mem-claw source tree", () => {
		const result = spawnSync("bash", [GUARD, ...SOURCE_ROOTS], { encoding: "utf8" });

		expect(result.status, String(result.stderr)).toBe(0);
	});
});
