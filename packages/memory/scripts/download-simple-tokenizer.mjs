#!/usr/bin/env node
/**
 * Download + verify the wangfenjin/simple SQLite tokenizer binaries pinned at
 * VERSION below. Idempotent: skips any platform whose `libsimple.{so,dylib}`
 * + `dict/` already exists under `sqlite-extensions/<platform>/`.
 *
 * Why: simple-tokenizer is the FTS5 tokenizer behind CJK word-level recall.
 * Upstream releases ship prebuilt binaries we vendor.
 *
 * Runtime: written in plain JS (.mjs) so the script runs under Node install
 * hooks without `tsx` or runtime-specific APIs.
 *
 * SHA-256 hashes are pinned in source. To bump: update VERSION + ASSETS hashes
 * in the same PR after recomputing from the upstream release.
 *
 * Run manually:
 *   node scripts/download-simple-tokenizer.mjs                # host platform
 *   node scripts/download-simple-tokenizer.mjs --force      # re-download
 *   node scripts/download-simple-tokenizer.mjs --platform linux-x64
 *   node scripts/download-simple-tokenizer.mjs --all-platforms
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "v0.7.1";

const ASSETS = [
	{
		platform: "linux-x64",
		assetName: "libsimple-linux-ubuntu-22.04.zip",
		binaryName: "libsimple.so",
		sha256: "0c9a7a578fc50ef5480e69e1e1880535ae68d75e1c1580f6bf106073087642a5",
	},
	{
		platform: "linux-arm64",
		assetName: "libsimple-linux-ubuntu-24.04-arm.zip",
		binaryName: "libsimple.so",
		sha256: "d2d6589f0fc144099d48105cb3d97c9939ef24c87b63b3f2b749a10a6922fa48",
	},
	{
		platform: "darwin-arm64",
		assetName: "libsimple-osx-arm64.zip",
		binaryName: "libsimple.dylib",
		sha256: "b699f0fca1e7d1f8776d067708ecf4d0bcc2d765e4b643862e129058583b885f",
	},
	{
		platform: "darwin-x64",
		assetName: "libsimple-osx-x64.zip",
		binaryName: "libsimple.dylib",
		sha256: "d6f7e9fc9dac3c2bcfb5389618d41f2f0db6ea5a83dd8b9a363cf9b02fa20f95",
	},
];

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const TARGET_ROOT = join(PLUGIN_ROOT, "sqlite-extensions");
const RELEASE_BASE = `https://github.com/wangfenjin/simple/releases/download/${VERSION}`;

function parseArgs(argv) {
	const opts = { force: false, platforms: new Set(), allPlatforms: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--force") opts.force = true;
		else if (arg === "--all-platforms") opts.allPlatforms = true;
		else if (arg === "--platform") {
			const next = argv[i + 1];
			if (!next) throw new Error("--platform requires an argument");
			opts.platforms.add(next);
			i++;
		}
	}
	return opts;
}

function detectHostPlatform() {
	const key = `${process.platform}-${process.arch}`;
	switch (key) {
		case "linux-x64":
		case "linux-arm64":
		case "darwin-x64":
		case "darwin-arm64":
			return key;
		default:
			throw new Error(
				`unsupported host platform "${key}"; use --platform to choose one of: ` +
					ASSETS.map((a) => a.platform).join(", "),
			);
	}
}

function platformAlreadyInstalled(platform, binaryName) {
	const platformDir = join(TARGET_ROOT, platform);
	return (
		existsSync(join(platformDir, binaryName)) &&
		existsSync(join(platformDir, "dict"))
	);
}

async function fetchToBuffer(url) {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
	}
	const buf = await res.arrayBuffer();
	return Buffer.from(buf);
}

function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function unzipInto(zipPath, destDir) {
	// Defer to system unzip — present on every platform we ship to.
	execFileSync("unzip", ["-q", "-o", zipPath, "-d", destDir], {
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function installAsset(spec, opts) {
	if (
		!opts.force &&
		platformAlreadyInstalled(spec.platform, spec.binaryName)
	) {
		console.log(`  ${spec.platform}: already installed`);
		return;
	}
	const url = `${RELEASE_BASE}/${spec.assetName}`;
	console.log(`  ${spec.platform}: downloading ${spec.assetName}...`);
	const zipBytes = await fetchToBuffer(url);
	const actualHash = sha256Hex(zipBytes);
	if (actualHash !== spec.sha256) {
		throw new Error(
			`SHA-256 mismatch for ${spec.assetName}: expected ${spec.sha256}, got ${actualHash}`,
		);
	}
	const tmpZip = join(tmpdir(), `simple-tokenizer-${spec.platform}-${process.pid}.zip`);
	const tmpExtract = join(
		tmpdir(),
		`simple-tokenizer-${spec.platform}-${process.pid}.extract`,
	);
	writeFileSync(tmpZip, zipBytes);
	mkdirSync(tmpExtract, { recursive: true });
	try {
		unzipInto(tmpZip, tmpExtract);
		// Upstream zip wraps everything in a single top-level directory whose
		// name matches the asset stem. Lift its contents into our flattened
		// `<platform>/` layout.
		const stem = spec.assetName.replace(/\.zip$/, "");
		const innerRoot = join(tmpExtract, stem);
		if (!existsSync(innerRoot)) {
			throw new Error(`expected extracted directory not found: ${innerRoot}`);
		}
		const platformDir = join(TARGET_ROOT, spec.platform);
		mkdirSync(platformDir, { recursive: true });
		execFileSync("cp", ["-R", `${innerRoot}/.`, platformDir], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (!existsSync(join(platformDir, spec.binaryName))) {
			throw new Error(
				`post-install verification failed: ${join(platformDir, spec.binaryName)} missing`,
			);
		}
		console.log(`  ${spec.platform}: installed → ${platformDir}`);
	} finally {
		try {
			rmSync(tmpZip, { force: true });
			rmSync(tmpExtract, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const filtered =
		opts.platforms.size > 0
			? ASSETS.filter((a) => opts.platforms.has(a.platform))
			: opts.allPlatforms
				? ASSETS
				: ASSETS.filter((a) => a.platform === detectHostPlatform());
	if (filtered.length === 0) {
		throw new Error(
			`no matching platforms (asked for: ${[...opts.platforms].join(", ")}); ` +
				`available: ${ASSETS.map((a) => a.platform).join(", ")}`,
		);
	}
	mkdirSync(TARGET_ROOT, { recursive: true });
	const sentinel = join(TARGET_ROOT, ".version");
	const allInstalled = filtered.every((a) =>
		platformAlreadyInstalled(a.platform, a.binaryName),
	);
	if (
		!opts.force &&
		allInstalled &&
		existsSync(sentinel) &&
		readFileSync(sentinel, "utf8").trim() === VERSION
	) {
		console.log(
			`simple-tokenizer ${VERSION} already installed for selected platform(s).`,
		);
		return;
	}
	console.log(`simple-tokenizer: installing ${VERSION} → ${TARGET_ROOT}`);
	for (const spec of filtered) {
		await installAsset(spec, opts);
	}
	writeFileSync(sentinel, `${VERSION}\n`);
	console.log("simple-tokenizer: done.");
}

main().catch((err) => {
	console.error("simple-tokenizer install failed:", err);
	process.exit(1);
});
