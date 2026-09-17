import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import buildConfig from "../../../../packages/sno-station-mem/tsdown.config";

it("builds every internal module imported or re-exported by mem-claw", () => {
	const sourceRoot = resolve(import.meta.dirname, "../../../../apps/mem-claw/src");
	const specifiers = new Set<string>();
	const collect = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		if ("type" in node && "source" in node && (
			node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration" || node.type === "ImportExpression"
		)) {
			const source = node.source;
			if (source && typeof source === "object" && "value" in source &&
				typeof source.value === "string" &&
				source.value.startsWith("@snoai/sno-station-mem/internal/")) {
				specifiers.add(source.value);
			}
		}
		for (const value of Object.values(node)) collect(value);
	};
	for (const file of readdirSync(sourceRoot, { recursive: true })) {
		if (!file.endsWith(".ts")) continue;
		collect(parse(readFileSync(resolve(sourceRoot, file), "utf8"), {
			sourceType: "module", plugins: ["typescript"], createImportExpressions: true,
		}));
	}
	const configs = Array.isArray(buildConfig) ? buildConfig : [buildConfig];
	const entries = new Set(configs.flatMap((config) => Object.keys(config.entry ?? {})));
	expect(specifiers.size).toBe(35);
	for (const specifier of specifiers) {
		expect(entries.has(specifier.replace("@snoai/sno-station-mem/", "")),
			`Missing build entry for ${specifier}`).toBe(true);
	}
});
