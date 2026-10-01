/**
 * Bundler runtime probe (PRD §9 line 793, §11 P0 gate).
 *
 * Catches the failure mode where the bundler's chunk-emission silently drops a
 * `() => import("./res/<loc>/index")` lazy entry (typo, hashed-chunk-name churn,
 * tsconfig path drift). Static greps over `dist/` filenames are unreliable
 * because tsdown emits hashed names; only an end-to-end runtime call verifies
 * the static-import map survives bundling.
 *
 * Why we bypass `t()`: the public API walks the PARENT chain when a chunk
 * fails to load (registry.ts `loadLocale`), so a missing `zh-Hant/index`
 * chunk would silently return the `zh` (or `en`) bag and the probe would
 * record success. We use `_loadLocaleStrictForTests` to invoke the raw
 * `RES[locale]` loader, then assert the loaded module has every namespace
 * as an own property. That combination catches both bug classes: missing
 * chunk (loader throws) AND empty bundle (own-key set incomplete).
 *
 * Originally specified for `bun build`; rewritten for Node 22+ since the
 * plugin ships to Node hosts. Build flags below MUST mirror the bundler
 * settings in `apps/mem-claw/tsdown.config.ts` (probe passes them via CLI
 * with `--no-config`, since the config's entry/clean/dts targets the real
 * plugin build). If the production config ever changes, update both.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PLUGIN_DIR = path.join(REPO_ROOT, "packages/memory");
const PROBE_DIR = path.join(PLUGIN_DIR, ".probe-tmp");
const PROBE_ENTRY = path.join(PROBE_DIR, "probe.ts");
const PROBE_OUT_DIR = path.join(PROBE_DIR, "dist");
const PROBE_OUT = path.join(PROBE_OUT_DIR, "probe.mjs");

// The probe script: bundled with the same tsdown flags as production, run as
// a fresh Node child. Asserts:
//   1. every RES[locale]() resolves without MODULE_NOT_FOUND
//   2. the loaded module has every namespace as an own property
//      (catches the "chunk shipped but empty" case)
//   3. eld.detect() shape contract — language/isReliable()/getScores().
//      Done here (not in unit test) because eld/medium only resolves from
//      inside the plugin's node_modules.
const PROBE_SOURCE = `import { eld } from "eld/medium";
import { SUPPORTED_LOCALES } from "../src/engine/i18n/locales";
import { _loadLocaleStrictForTests } from "../src/engine/i18n/registry";
import { ALL_NAMESPACES } from "../src/engine/i18n/res/_types";

const NS = ALL_NAMESPACES;

interface LocaleResult {
	locale: string;
	loaded: boolean;
	missingNamespaces: string[];
	error?: string;
}

interface ShapeResult {
	languageType: string;
	isReliableType: string;
	getScoresType: string;
	isReliableValue: boolean;
	scoresIsObject: boolean;
}

(async () => {
	const localeResults: LocaleResult[] = [];
	for (const locale of SUPPORTED_LOCALES) {
		try {
			const bag = await _loadLocaleStrictForTests(locale);
			const ownKeys = new Set(Object.keys(bag as object));
			const missing = NS.filter((ns) => !ownKeys.has(ns));
			localeResults.push({
				locale,
				loaded: true,
				missingNamespaces: missing,
			});
		} catch (err) {
			localeResults.push({
				locale,
				loaded: false,
				missingNamespaces: [...NS],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const shapeProbe = eld.detect(
		"Hello, my name is Alice and I live in San Francisco.",
	);
	const shape: ShapeResult = {
		languageType: typeof shapeProbe.language,
		isReliableType: typeof shapeProbe.isReliable,
		getScoresType: typeof shapeProbe.getScores,
		isReliableValue: shapeProbe.isReliable(),
		scoresIsObject: typeof shapeProbe.getScores() === "object",
	};

	process.stdout.write(JSON.stringify({ localeResults, shape }));
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
`;

function cleanProbeDir(): void {
	if (existsSync(PROBE_DIR)) {
		rmSync(PROBE_DIR, { recursive: true, force: true });
	}
}

interface LocaleResult {
	readonly locale: string;
	readonly loaded: boolean;
	readonly missingNamespaces: readonly string[];
	readonly error?: string;
}

interface ShapeResult {
	readonly languageType: string;
	readonly isReliableType: string;
	readonly getScoresType: string;
	readonly isReliableValue: boolean;
	readonly scoresIsObject: boolean;
}

interface ProbeOutput {
	readonly localeResults: readonly LocaleResult[];
	readonly shape: ShapeResult;
}

describe("i18n bundler runtime probe (Node) — every (locale × ns) loads from dist", () => {
	it(
		"tsdown-bundled probe resolves all supported locales × all namespaces and EldDetector shape",
		() => {
			let output: ProbeOutput | undefined;
			try {
				cleanProbeDir();
				mkdirSync(PROBE_DIR, { recursive: true });
				writeFileSync(PROBE_ENTRY, PROBE_SOURCE, "utf8");

				// Match production bundler settings from tsdown.config.ts;
				// --no-config keeps the config's entry/clean/dts out of the probe.
				const buildResult = spawnSync(
					"npx",
					[
						"--no-install",
						"tsdown",
						// rolldown rejects extension-less relative entries without "./"
						`./${path.relative(PLUGIN_DIR, PROBE_ENTRY)}`,
						"--no-config",
						"--out-dir",
						path.relative(PLUGIN_DIR, PROBE_OUT_DIR),
						"--format",
						"esm",
						"--target",
						"node22",
						"--platform",
						"node",
						"--logLevel",
						"silent",
					],
					{
						cwd: PLUGIN_DIR,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "pipe"],
					},
				);

				if (buildResult.status !== 0) {
					throw new Error(
						`tsdown build failed (exit ${buildResult.status}):\n${buildResult.stderr}\n${buildResult.stdout}`,
					);
				}
				expect(existsSync(PROBE_OUT), "probe bundle missing").toBe(true);

				const runOutput = execFileSync("node", [PROBE_OUT], {
					cwd: PLUGIN_DIR,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});

				output = JSON.parse(runOutput) as ProbeOutput;
			} finally {
				cleanProbeDir();
			}

			expect(output, "probe produced no output").toBeDefined();
			if (!output) return;

			// (1) Every locale chunk loads strictly (no PARENT fallback).
			expect(output.localeResults.length, "expected 9 locales").toBe(9);
			const loadFailures = output.localeResults.filter((r) => !r.loaded);
			if (loadFailures.length > 0) {
				throw new Error(
					`Locale chunk(s) failed to load from bundle:\n` +
						loadFailures
							.map((f) => `  ${f.locale}: ${f.error ?? "unknown"}`)
							.join("\n"),
				);
			}

			// (2) Each loaded module has every namespace as an own property.
			const namespaceGaps = output.localeResults.filter(
				(r) => r.missingNamespaces.length > 0,
			);
			if (namespaceGaps.length > 0) {
				throw new Error(
					`Locale module(s) missing namespace own-keys (chunk shipped but empty):\n` +
						namespaceGaps
							.map((g) => `  ${g.locale}: missing [${g.missingNamespaces.join(", ")}]`)
							.join("\n"),
				);
			}

			// (3) EldDetector shape contract (PRD §9 line 777).
			expect(output.shape.languageType).toBe("string");
			expect(output.shape.isReliableType).toBe("function");
			expect(output.shape.getScoresType).toBe("function");
			expect(output.shape.isReliableValue).toBe(true);
			expect(output.shape.scoresIsObject).toBe(true);
		},
		120_000,
	);
});
