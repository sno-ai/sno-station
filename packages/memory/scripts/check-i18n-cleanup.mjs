import { readFileSync } from "node:fs";

function sourceFor(path) {
	return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const checks = [
	{
		name: "query expansion uses Unicode-aware boundaries",
		path: "src/retrieval/query-expander.ts",
		assert: (source) =>
			source.includes("boundaryAwareRegex") && !source.includes("new RegExp(`\\\\b"),
	},
	{
		name: "governance Entry parser avoids ASCII-only word boundaries",
		path: "src/reflection/reflection-governance-parser.ts",
		assert: (source) => !source.includes("Entry\\\\b"),
	},
	{
		name: "coverage normalization uses shared Unicode compare helper",
		path: "src/extraction/insight-distill-candidate-parser.ts",
		assert: (source) => source.includes("normalizeForCompare(stripResponseControlSuffix(text))"),
	},
	{
		name: "embedding text chunker keeps CJK regexes Unicode-aware",
		path: "src/extraction/embedding-text-chunker.ts",
		assert: (source) =>
			/const SENTENCE_ENDING = .*\/u;/.test(source) && /const CJK_RE = .*\/u;/.test(source),
	},
	{
		name: "session compressor reads multilingual noise signals from resources",
		path: "src/extraction/session-text-compressor.ts",
		assert: (source) =>
			source.includes("ALL_RESOURCES") &&
			source.includes("CORRECTION_INDICATORS") &&
			source.includes("MEMORY_INTENT_PATTERNS"),
	},
	{
		name: "temporality classifier reads locale-owned temporal resources",
		path: "src/extraction/memory-temporality-classifier.ts",
		assert: (source) =>
			source.includes("RESOURCES_BY_LOCALE") && source.includes("day_after_tomorrow"),
	},
	{
		name: "locale resource contract includes i18n cleanup namespaces",
		path: "src/i18n/res/_types.ts",
		assert: (source) =>
			source.includes("ALL_NAMESPACES") &&
			source.includes("categoryRouting") &&
			source.includes("categoryRemap") &&
			source.includes("reflectionSliceClassifiers"),
	},
	{
		name: "locale resource helper populates required derived namespaces",
		path: "src/i18n/res/locale-resource-helpers.ts",
		assert: (source) =>
			source.includes("categoryRouting") &&
			source.includes("categoryRemap") &&
			source.includes("correctionSignals") &&
			source.includes("ackTokens") &&
			source.includes("memoryIntent") &&
			source.includes("reflectionSliceClassifiers"),
	},
];

const failures = [];

for (const check of checks) {
	const source = sourceFor(check.path);
	if (!check.assert(source)) failures.push(`${check.name} (${check.path})`);
}

if (failures.length > 0) {
	console.error("i18n cleanup guard failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exitCode = 1;
}
