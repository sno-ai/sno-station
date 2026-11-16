import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const packages = resolve(import.meta.dirname, "../../packages");

for (const directory of readdirSync(packages, { withFileTypes: true })) {
	if (!directory.isDirectory()) continue;

	test(`${directory.name} README pins match package.json`, () => {
		const path = join(packages, directory.name);
		const { name, version } = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		const readme = readFileSync(join(path, "README.md"), "utf8");
		const pins = [...readme.matchAll(/(@snoai\/[\w.-]+)@([\w.+-]+)/g)]
			.filter(match => match[1] === name);

		assert.ok(pins.length > 0, `${name} README must contain a version pin`);
		for (const pin of pins) {
			assert.equal(pin[2], version, `${pin[0]} must match package.json version ${version}`);
		}
	});
}
