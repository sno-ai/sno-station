/**
 * Each package README tells readers to `npm install @snoai/<name>@<version>`. A release that bumps
 * package.json and not that line sends them to an old version, so every pin must equal it.
 * Run: node --test tests/npm-publication/readme-install-pins.test.mjs
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";

const packages = resolve(import.meta.dirname, "../../packages");

for (const entry of readdirSync(packages, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const dir = join(packages, entry.name);
	const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	const pins = (readme.match(/@snoai\/[a-z-]+@[^\s`]+/g) ?? []).filter((pin) =>
		pin.startsWith(`${name}@`),
	);
	it(`packages/${entry.name}/README.md installs ${name}@${version}`, () => {
		assert.notEqual(pins.length, 0, "no install line names this package with a version");
		for (const pin of pins) assert.equal(pin, `${name}@${version}`);
	});
}
