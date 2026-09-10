/** @file rem-guard-census-cli.ts
 * @purpose Blocks packaging when the live REM writer or safety-guard graph is incomplete.
 * @boundary Source-tree release check only; never runs in the installed sidecar.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
	discoverRemWritersFromCallGraph,
	validateRemGuardCensus,
} from "../engine/rem/index.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const appRoot = path.join(repoRoot, "packages/sno-station-mem");
const sourceEntry = path.join(appRoot, "src/sidecar/server.ts");
const writers = discoverRemWritersFromCallGraph({ entryPoints: [sourceEntry] });
if (writers.writers.length !== 7) {
	throw new Error(`REM release writer census found ${writers.writers.length}; expected 7`);
}

const guards = validateRemGuardCensus({
	manifestPath: path.join(appRoot, "config/rem/guard-manifest.json"),
	requiredGuardsPath: path.join(appRoot, "config/rem/required-guards.json"),
	sourceRoots: [path.join(appRoot, "src"), path.join(appRoot, "src/engine/rem")],
	productionRoots: [sourceEntry],
});
if (guards.decision === "refuse") {
	throw new Error(`REM release guard census refused: ${guards.reasonCode}`);
}

const buildConfiguration = readFileSync(path.join(appRoot, "tsdown.config.ts"), "utf8");
if (!buildConfiguration.includes('"sidecar/main": "src/sidecar/main.ts"')) {
	throw new Error("REM release package omits the built sidecar entry");
}

console.log(
	`REM_RELEASE_CENSUS_PASS discoverRemWritersFromCallGraph=${writers.writers.length} validateRemGuardCensus=${guards.decision} current=24 split=22+2`,
);
