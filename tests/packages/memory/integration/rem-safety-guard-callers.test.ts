import { readdirSync } from "node:fs";
import path from "node:path";
import type { Node } from "typescript/unstable/ast";
import {
	isArrowFunction,
	isFunctionDeclaration,
	isFunctionExpression,
	isIdentifier,
	isImportSpecifier,
	isMethodDeclaration,
	isPropertyDeclaration,
	isVariableDeclaration,
	isExportSpecifier,
} from "typescript/unstable/ast/is";
import type { Symbol as TypeScriptSymbol } from "typescript/unstable/sync";
import { API, type Checker, type Project, SymbolFlags } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const guardedName = /^(assert|guard|require|refuse|forbid|deny|ensure|reject)/u;

interface GuardDefinition {
	key: string;
	declaration: Node;
	symbolId: number;
}

const zeroCallerAllowlist = new Map<string, string>([
	[
		"packages/memory/src/engine/rem/operational-config.ts:129:requireRemCoverageAccuracyFloor",
		"Frozen unwired guard retained by the REM obligations contract.",
	],
	[
		"packages/embedder/src/model-download.ts:325:ensureModelDownloaded",
		"Published package entry point invoked by external operators, not repository production code.",
	],
	[
		"packages/qe-lib/src/conformance.ts:27:assertQeCorpusReaderConformance",
		"Published conformance helper invoked by external corpus-reader implementations.",
	],
]);

describe("REM production safety guard reachability", () => {
	it("rem-safety-guards-have-production-callers", () => {
		const api = new API({ cwd: repoRoot });
		const snapshot = api.updateSnapshot({ openProjects: findProjectConfigs() });
		try {
			const projects = snapshot.getProjects();
			const definitions = collectGuardDefinitions(projects);
			const references = collectProductionSymbolReferences(projects);
			const uncalled = definitions
				.filter((definition) => !hasProductionCaller(definition, references))
				.filter((definition) => !zeroCallerAllowlist.has(definition.key));
			const definitionKeys = new Set(definitions.map((definition) => definition.key));
			const staleAllowlist = [...zeroCallerAllowlist.keys()].filter(
				(key) => !definitionKeys.has(key),
			);
			const unexplainedAllowlist = [...zeroCallerAllowlist.entries()]
				.filter(([, reason]) => reason.trim().length === 0)
				.map(([key]) => key);

			expect(staleAllowlist, "remove stale safety-guard allowlist entries").toEqual([]);
			expect(unexplainedAllowlist, "every safety-guard allowlist entry needs a reason").toEqual(
				[],
			);
			expect(
				uncalled.map((definition) => definition.key),
				"every named production safety guard needs a production caller or a maintained reason",
			).toEqual([]);
		} finally {
			snapshot.dispose();
			api.close();
		}
	});
});

function findProjectConfigs(): string[] {
	return ["apps", "packages"].flatMap((root) => findNamedFiles(path.join(repoRoot, root), "tsconfig.json"));
}

function findNamedFiles(directory: string, name: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (["dist", "node_modules"].includes(entry.name)) continue;
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...findNamedFiles(entryPath, name));
		} else if (entry.isFile() && entry.name === name) {
			files.push(entryPath);
		}
	}
	return files;
}

function collectGuardDefinitions(projects: readonly Project[]): GuardDefinition[] {
	const definitions = new Map<string, GuardDefinition>();
	const aliasResolutionCache = new Map<number, number>();
	for (const project of projects) {
		for (const fileName of project.program.getSourceFileNames()) {
			if (!isProductionSource(fileName)) continue;
			const sourceFile = project.program.getSourceFile(fileName);
			if (!sourceFile) continue;
			visit(sourceFile, (node) => {
				const callable = namedCallable(node);
				if (!callable || !guardedName.test(callable.name)) return;
				const symbol = project.checker.getSymbolAtLocation(callable.nameNode);
				if (!symbol) return;
				const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
				const key = `${path.relative(repoRoot, fileName)}:${line}:${callable.name}`;
				if (!definitions.has(key)) {
					definitions.set(key, {
						key,
						declaration: callable.declaration,
						symbolId: canonicalSymbolId(project.checker, symbol, aliasResolutionCache),
					});
				}
			});
		}
	}
	return [...definitions.values()];
}

function collectProductionSymbolReferences(projects: readonly Project[]): Map<number, Node[]> {
	const references = new Map<number, Node[]>();
	const aliasResolutionCache = new Map<number, number>();
	for (const project of projects) {
		for (const fileName of project.program.getSourceFileNames()) {
			if (!isProductionSource(fileName)) continue;
			const sourceFile = project.program.getSourceFile(fileName);
			if (!sourceFile) continue;
			const identifiers: Node[] = [];
			visit(sourceFile, (node) => {
				if (isIdentifier(node)) identifiers.push(node);
			});
			const symbols = project.checker.getSymbolAtLocation(identifiers);
			for (const [index, symbol] of symbols.entries()) {
				const identifier = identifiers[index];
				if (!symbol || !identifier) continue;
				const symbolId = canonicalSymbolId(project.checker, symbol, aliasResolutionCache);
				const nodes = references.get(symbolId) ?? [];
				nodes.push(identifier);
				references.set(symbolId, nodes);
			}
		}
	}
	return references;
}

function canonicalSymbolId(
	checker: Checker,
	symbol: TypeScriptSymbol,
	cache: Map<number, number>,
): number {
	const cached = cache.get(symbol.id);
	if (cached !== undefined) return cached;
	const canonical =
		(symbol.flags & SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
	cache.set(symbol.id, canonical.id);
	return canonical.id;
}

function hasProductionCaller(
	definition: GuardDefinition,
	references: ReadonlyMap<number, readonly Node[]>,
): boolean {
	return (references.get(definition.symbolId) ?? []).some(
		(node) =>
			!contains(definition.declaration, node) &&
			!isImportSpecifier(node.parent) &&
			!isExportSpecifier(node.parent),
	);
}

function namedCallable(
	node: Node,
): { name: string; nameNode: Node; declaration: Node } | undefined {
	if (
		(isFunctionDeclaration(node) || isMethodDeclaration(node)) &&
		node.body &&
		node.name &&
		isIdentifier(node.name)
	) {
		return { name: node.name.text, nameNode: node.name, declaration: node };
	}
	if (
		(isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
		isIdentifier(node.name) &&
		node.initializer &&
		(isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
	) {
		return { name: node.name.text, nameNode: node.name, declaration: node.initializer };
	}
	return undefined;
}

function isProductionSource(fileName: string): boolean {
	const relative = path.relative(repoRoot, fileName);
	return (
		(relative.startsWith("apps/") || relative.startsWith("packages/")) &&
		relative.includes("/src/") &&
		!/\.(?:test|spec)\.tsx?$/u.test(relative)
	);
}

function visit(node: Node, callback: (node: Node) => void): void {
	callback(node);
	node.forEachChild((child) => visit(child, callback));
}

function contains(container: Node, node: Node): boolean {
	return (
		container.getSourceFile() === node.getSourceFile() &&
		container.getStart() <= node.getStart() &&
		node.getEnd() <= container.getEnd()
	);
}
