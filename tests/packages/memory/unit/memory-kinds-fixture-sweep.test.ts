import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixtureDir = resolve(
	fileURLToPath(new URL("../../../apps/mem-claw/fixtures", import.meta.url)),
);

const oldCategoryValues = new Set(["identity", "preference", "entity", "event"]);
const categoryFieldNames = new Set(["category", "kind", "memory_category"]);

function listJsonFixtures(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			return listJsonFixtures(entryPath);
		}
		return extname(entry.name) === ".json" ? [entryPath] : [];
	});
}

function collectOldCategoryHits(value: unknown, path: string, hits: string[]): void {
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			collectOldCategoryHits(entry, `${path}[${index}]`, hits);
		});
		return;
	}

	if (value === null || typeof value !== "object") {
		return;
	}

	for (const [key, entry] of Object.entries(value)) {
		if (
			categoryFieldNames.has(key) &&
			typeof entry === "string" &&
			oldCategoryValues.has(entry)
		) {
			hits.push(`${path}.${key} = ${entry}`);
		}
		collectOldCategoryHits(entry, `${path}.${key}`, hits);
	}
}

describe("memory kind fixture sweep", () => {
	it("distinguishes old category values from valid section addresses", () => {
		const hits: string[] = [];

		collectOldCategoryHits(
			{
				category: "identity",
				kind: "event",
				memory_category: "preference",
				section: "identity",
				section_name: "identity",
			},
			"$",
			hits,
		);

		expect(hits).toEqual([
			"$.category = identity",
			"$.kind = event",
			"$.memory_category = preference",
		]);
	});

	it("has no stored old category values in mem-claw fixture JSON", () => {
		const hits: string[] = [];

		for (const fixturePath of listJsonFixtures(fixtureDir)) {
			const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
			const fixtureHits: string[] = [];
			collectOldCategoryHits(parsed, "$", fixtureHits);

			for (const hit of fixtureHits) {
				hits.push(`${relative(fixtureDir, fixturePath)} ${hit}`);
			}
		}

		expect(hits).toEqual([]);
	});
});
