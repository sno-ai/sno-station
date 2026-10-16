/** @file model-download.e2e.test.ts
 * @purpose The bundled embedding model arrives from the real Hugging Face hub, survives a killed download, loads and
 * embeds, starts again with the network gone, and an earlier release's cache upgrades without downloading again.
 * @boundary Real hub through the machine's proxy settings, real filesystem, real child process, real ONNX model.
 * Downloads about 600 MB; it runs only when named.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalEmbedProvider } from "../../../../packages/embedder/src/local-provider.ts";
import { embeddingModelSpec, ensureModelDownloaded } from "../../../../packages/embedder/src/model-download.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const spec = embeddingModelSpec("q8");
const weights = spec.files.find((file) => file.path.endsWith(".onnx"));
if (!weights) throw new Error("the pinned embedding spec lists no weights");
// Nothing listens on the discard port, so every request through it is refused.
const UNREACHABLE = "http://127.0.0.1:9";
// An earlier release's cache on this machine; the test copies it and never touches the original.
const EARLIER_CACHE = join(homedir(), ".cache/sno-station/models");

const work = mkdtempSync(join(tmpdir(), "sno-download-e2e-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const cacheDir = join(work, "fresh");
const revisionDir = join(cacheDir, spec.id, spec.revision);

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function expectPinnedFiles(dir: string): Promise<void> {
	for (const file of spec.files) {
		const path = join(dir, file.path);
		expect(statSync(path).size, file.path).toBe(file.size);
		expect(await sha256(path), file.path).toBe(file.sha256);
	}
	expect(existsSync(join(dir, ".complete"))).toBe(true);
}

/** Runs `body` with every request refused: the hub through a dead proxy, the mirror at a dead port. */
async function withoutNetwork<T>(body: () => Promise<T>): Promise<T> {
	const saved = { ...process.env };
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) process.env[key] = UNREACHABLE;
	for (const key of ["NO_PROXY", "no_proxy"]) delete process.env[key];
	try {
		return await body();
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

function sizeOf(path: string): number | undefined {
	return statSync(path, { throwIfNoEntry: false })?.size;
}

describe("bundled embedding model download, end to end", () => {
	it("downloads the pinned model, and a download killed halfway resumes where it stopped", async () => {
		const part = join(revisionDir, `${weights.path}.part`);
		const code = `const { ensureModelDownloaded } = await import(${JSON.stringify(join(repo, "packages/embedder/src/model-download.ts"))});
await ensureModelDownloaded({ cacheDir: ${JSON.stringify(cacheDir)} });`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: repo, stdio: "ignore" });
		const exited = new Promise<void>((done) => child.on("exit", () => done()));
		// Kill it the way a closed laptop or an OOM kill does, once a real share of the weights is on disk.
		while ((sizeOf(part) ?? 0) < 64 * 1024 * 1024) {
			if (child.exitCode !== null) throw new Error(`the first download exited with ${child.exitCode} before 64 MB arrived`);
			await new Promise((wait) => setTimeout(wait, 100));
		}
		child.kill("SIGKILL");
		await exited;
		const kept = sizeOf(part) ?? 0;
		expect(kept).toBeGreaterThanOrEqual(64 * 1024 * 1024);

		// Starting over would truncate the part file; sampling it shows whether it ever shrank below what was kept.
		let smallest = kept;
		const sampler = setInterval(() => { smallest = Math.min(smallest, sizeOf(part) ?? smallest); }, 20);
		try {
			await ensureModelDownloaded({ cacheDir });
		} finally {
			clearInterval(sampler);
		}
		expect(smallest).toBe(kept);
		expect(existsSync(part)).toBe(false);
		expect(existsSync(`${revisionDir}.lock`)).toBe(false);
		await expectPinnedFiles(revisionDir);
	}, 1_800_000);

	it("loads the downloaded model and ranks a related sentence above an unrelated one, in Chinese and English", async () => {
		LocalEmbedProvider.resetStaticState();
		const provider = new LocalEmbedProvider({ cacheDir, sessionOptions: { intraOpNumThreads: 4 } });
		try {
			const cosine = (a: number[] = [], b: number[] = []) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
			const [zhQuery, zhRelated, zhOther, enQuery, enRelated, enOther] = await provider.embedDocuments([
				"我家的狗今年几岁了？", "我养的那只柴犬今年三岁。", "明天上午要去银行办理贷款。",
				"How old is my dog?", "My shiba inu turned three this spring.", "The bank loan meeting is tomorrow morning.",
			]);
			expect(zhQuery).toHaveLength(1024);
			expect(cosine(zhQuery, zhRelated)).toBeGreaterThan(cosine(zhQuery, zhOther));
			expect(cosine(enQuery, enRelated)).toBeGreaterThan(cosine(enQuery, enOther));
		} finally {
			await provider.dispose();
		}
	}, 300_000);

	it("starts again with the network gone and embeds without downloading anything", async () => {
		// The network really is gone: an empty cache cannot be filled.
		await withoutNetwork(async () => {
			await expect(ensureModelDownloaded({ cacheDir: join(work, "empty"), mirror: `${UNREACHABLE}/` })).rejects.toThrow();
		});
		const vector = await withoutNetwork(async () => {
			await ensureModelDownloaded({ cacheDir, mirror: `${UNREACHABLE}/` });
			LocalEmbedProvider.resetStaticState();
			const provider = new LocalEmbedProvider({ cacheDir, mirror: `${UNREACHABLE}/`, sessionOptions: { intraOpNumThreads: 4 } });
			try {
				return await provider.embed("断网后还能用吗？");
			} finally {
				await provider.dispose();
			}
		});
		expect(vector).toHaveLength(1024);
	}, 300_000);

	it.skipIf(!existsSync(EARLIER_CACHE))("upgrades an earlier release's cache in place without downloading the weights again", async () => {
		const upgraded = join(work, "earlier");
		cpSync(EARLIER_CACHE, upgraded, { recursive: true });
		await withoutNetwork(() => ensureModelDownloaded({ cacheDir: upgraded, mirror: `${UNREACHABLE}/` }));
		expect(readdirSync(join(upgraded, spec.id))).toEqual([spec.revision]);
		expect(existsSync(join(upgraded, ".download-complete"))).toBe(false);
		await expectPinnedFiles(join(upgraded, spec.id, spec.revision));
	}, 600_000);
});
