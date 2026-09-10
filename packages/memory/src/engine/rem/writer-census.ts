import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

export interface RemDiscoveredWriter {
	writer: string;
}

export function discoverRemWritersFromCallGraph(input: {
	entryPoints: readonly string[];
}): { writers: RemDiscoveredWriter[] } {
	const sources = readImportClosure(input.entryPoints);
	const executorSource = [...sources.values()].find((source) =>
		/^(?:async\s+)?function applyWriterOperation\s*\(/mu.test(source),
	);
	if (executorSource === undefined) {
		throw new Error("REM production mutation executor is not reachable from the entry points");
	}
	const start = executorSource.search(/^(?:async\s+)?function applyWriterOperation\s*\(/mu);
	const end = executorSource.indexOf("\n}\n\nfunction ", start);
	if (end < 0) throw new Error("REM production mutation executor boundary is incomplete");
	const writers = new Set<string>();
	for (const match of executorSource.slice(start, end + 2).matchAll(/case\s+"([A-Za-z]+)"\s*:/g)) {
		const writer = match[1];
		if (writer !== undefined) writers.add(writer);
	}
	return { writers: [...writers].map((writer) => ({ writer })) };
}

function readImportClosure(entryPoints: readonly string[]): Map<string, string> {
	const pending = entryPoints.map((entryPoint) => resolve(entryPoint));
	const sources = new Map<string, string>();
	while (pending.length > 0) {
		const path = pending.shift();
		if (path === undefined || sources.has(path)) continue;
		if (!existsSync(path)) throw new Error(`REM call-graph entry does not exist: ${path}`);
		const source = readFileSync(path, "utf8");
		sources.set(path, source);
		for (const specifier of readModuleSpecifiers(source)) {
			const resolved = resolveSourceImport(path, specifier);
			if (resolved !== undefined && !sources.has(resolved)) pending.push(resolved);
		}
	}
	return sources;
}

function readModuleSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
		if (match[2] !== undefined) specifiers.push(match[2]);
	}
	return specifiers;
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
	let candidate: string;
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		candidate = resolve(dirname(importer), specifier);
	} else if (specifier.startsWith("@/")) {
		const marker = "/packages/sno-station-mem/src/";
		const markerIndex = importer.indexOf(marker);
		if (markerIndex < 0) return undefined;
		candidate = resolve(importer.slice(0, markerIndex + marker.length), specifier.slice(2));
	} else {
		return undefined;
	}
	const candidates = extname(candidate).length > 0
		? [candidate, candidate.replace(/\.js$/, ".ts")]
		: [`${candidate}.ts`, resolve(candidate, "index.ts")];
	return candidates.find((path) => existsSync(path));
}
