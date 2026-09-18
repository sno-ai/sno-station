import { FIXED_PROTOCOL_VALUE_64 } from "../../model/signed-registry-constants";
/** @file canonical-memory-corpus.ts
 * @purpose Searches and reads the built-in SnoStationMem canonical memory Markdown corpus.
 * @boundary Only exposes root MEMORY.md and ordinary Markdown files under memory/ in one workspace.
 */

import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import {
	isAbsolute,
	relative as relativePath,
	resolve,
	sep,
	posix,
} from "node:path";
import type { SnoStationMemMemorySearchResult as MemorySearchResult } from "../../contract/provider-runtime-types";
import { clampInt } from "../shared/utils";
import { createLogger } from "@snoai/utils/logger";
const diagnosticLog = createLogger("sno-station-mem:canonical-memory-corpus");

const ROOT_MEMORY_FILE = "MEMORY.md";
const MEMORY_DIR = "memory";
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 2_000;

const DENIED_SEGMENTS = new Set([
	FIXED_PROTOCOL_VALUE_64,
	"config",
	"configs",
	"context",
	"contexts",
	"dream",
	"dreaming",
	"instruction",
	"instructions",
	"mapping",
	"mappings",
	"personality",
	"personalities",
	"raw",
	"secret",
	"secrets",
	"session",
	"sessions",
	"store",
	"stores",
	"telemetry",
	"trace",
	"traces",
	"audit",
	"audits",
	"vector",
	"vectors",
]);

export interface CanonicalMemoryFile {
	path: string;
	absolutePath: string;
	realPath: string;
	lineCount: number;
}

export interface CanonicalMemoryDiagnostics {
	io_failure_count: number;
	unavailable_file_count: number;
}

export interface CanonicalMemoryReadResult {
	text: string;
	path: string;
	startLine: number;
	endLine: number;
	truncated?: boolean;
	from?: number;
	lines?: number;
	nextFrom?: number;
}

interface ResolvedCanonicalPath {
	workspaceRoot: string;
	path: string;
	absolutePath: string;
	realPath: string;
}

function canonicalDeniedError(): Error {
	return new Error("Canonical memory file not found or not authorized");
}

function isInside(parent: string, child: string): boolean {
	const relative = relativePath(parent, child);
	return relative === "" || (!relative.startsWith("..") && !isAbsolute(relative));
}

function normalizeWorkspaceDir(workspaceDir: string): string {
	const trimmed = workspaceDir.trim();
	if (!trimmed) throw canonicalDeniedError();
	return resolve(trimmed);
}

function isDeniedSegment(segment: string): boolean {
	const lower = segment.toLowerCase();
	const markdownStem = lower.endsWith(".md") ? lower.slice(0, -".md".length) : lower;
	return (
		lower.startsWith(".") ||
		lower === "user.md" ||
		DENIED_SEGMENTS.has(lower) ||
		DENIED_SEGMENTS.has(markdownStem)
	);
}

export function normalizeCanonicalMemoryPath(relPath: string): string {
	if (!relPath || relPath.includes("\\") || isAbsolute(relPath)) {
		throw canonicalDeniedError();
	}
	if (relPath === ROOT_MEMORY_FILE) return relPath;
	const segments = relPath.split("/");
	if (
		segments[0] !== MEMORY_DIR ||
		segments.length < 2 ||
		!segments.at(-1)?.endsWith(".md") ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw canonicalDeniedError();
	}
	if (segments.some(isDeniedSegment)) throw canonicalDeniedError();
	return posix.join(...segments);
}

async function resolveCanonicalPath(
	workspaceDir: string,
	relPath: string,
): Promise<ResolvedCanonicalPath> {
	const workspaceRoot = await realpath(normalizeWorkspaceDir(workspaceDir));
	const normalized = normalizeCanonicalMemoryPath(relPath);
	const absolutePath = resolve(workspaceRoot, ...normalized.split("/"));
	if (!isInside(workspaceRoot, absolutePath)) throw canonicalDeniedError();
	const linkStat = await lstat(absolutePath).catch(() => {
		throw canonicalDeniedError();
	});
	if (!linkStat.isFile()) throw canonicalDeniedError();
	const realFilePath = await realpath(absolutePath).catch(() => {
		throw canonicalDeniedError();
	});
	if (!isInside(workspaceRoot, realFilePath)) throw canonicalDeniedError();
	const fileStat = await stat(realFilePath).catch(() => {
		throw canonicalDeniedError();
	});
	if (!fileStat.isFile()) throw canonicalDeniedError();
	return { workspaceRoot, path: normalized, absolutePath, realPath: realFilePath };
}

async function readCanonicalText(
	workspaceDir: string,
	relPath: string,
): Promise<{ resolved: ResolvedCanonicalPath; text: string; lines: string[] }> {
	const resolved = await resolveCanonicalPath(workspaceDir, relPath);
	const text = await readFile(resolved.realPath, "utf8");
	return { resolved, text, lines: text.split("\n") };
}

async function walkMemoryDir(
	workspaceRoot: string,
	currentDir: string,
	relDir: string,
	files: CanonicalMemoryFile[],
	diagnostics?: CanonicalMemoryDiagnostics,
): Promise<void> {
	const dirLinkStat = await lstat(currentDir).catch((error: unknown) => {
		const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	});
	if (!dirLinkStat?.isDirectory()) return;
	const realDir = await realpath(currentDir).catch((error: unknown) => {
		if (diagnostics) {
			diagnostics.unavailable_file_count += 1;
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) diagnostics.io_failure_count += 1;
		}
		return undefined;
	});
	if (!realDir || !isInside(workspaceRoot, realDir)) return;
	const entries = await readdir(currentDir, { withFileTypes: true }).catch((error: unknown) => {
		const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return [];
		throw error;
	});
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (isDeniedSegment(entry.name)) continue;
		const relPath = posix.join(relDir, entry.name);
		const absPath = resolve(workspaceRoot, ...relPath.split("/"));
		if (entry.isDirectory()) {
			await walkMemoryDir(workspaceRoot, absPath, relPath, files, diagnostics);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		const file = await loadCanonicalFileByPath(workspaceRoot, relPath).catch((error: unknown) => {
			if (diagnostics) {
				diagnostics.unavailable_file_count += 1;
				if (error instanceof Error && "code" in error && error.code !== "ENOENT") diagnostics.io_failure_count += 1;
			}
			return undefined;
		});
		if (file) files.push(file);
	}
}

async function loadCanonicalFileByPath(
	workspaceRoot: string,
	relPath: string,
): Promise<CanonicalMemoryFile> {
	const normalized = normalizeCanonicalMemoryPath(relPath);
	const absolutePath = resolve(workspaceRoot, ...normalized.split("/"));
	const linkStat = await lstat(absolutePath);
	if (!linkStat.isFile()) throw canonicalDeniedError();
	const realFilePath = await realpath(absolutePath);
	if (!isInside(workspaceRoot, realFilePath)) throw canonicalDeniedError();
	const fileStat = await stat(realFilePath);
	if (!fileStat.isFile()) throw canonicalDeniedError();
	const text = await readFile(realFilePath, "utf8");
	return {
		path: normalized,
		absolutePath,
		realPath: realFilePath,
		lineCount: Math.max(text.split("\n").length, 1),
	};
}

export async function listCanonicalMemoryFiles(workspaceDir: string, diagnostics: CanonicalMemoryDiagnostics = { io_failure_count: 0, unavailable_file_count: 0 }): Promise<CanonicalMemoryFile[]> {
	const workspaceRoot = await realpath(normalizeWorkspaceDir(workspaceDir));
	const files: CanonicalMemoryFile[] = [];
	const rootFile = await loadCanonicalFileByPath(workspaceRoot, ROOT_MEMORY_FILE).catch(
		(error: unknown) => {
			if (diagnostics) {
				diagnostics.unavailable_file_count += 1;
				if (error instanceof Error && "code" in error && error.code !== "ENOENT") diagnostics.io_failure_count += 1;
			}
			return undefined;
		},
	);
	if (rootFile) files.push(rootFile);
	await walkMemoryDir(workspaceRoot, resolve(workspaceRoot, MEMORY_DIR), MEMORY_DIR, files, diagnostics);
	if (diagnostics.io_failure_count > 0) diagnosticLog.warn("Canonical memory discovery degraded", {
		outcome: "partial", io_failure_count: diagnostics.io_failure_count,
		unavailable_file_count: diagnostics.unavailable_file_count, file_count: files.length },
		{ event_name: "memory.provider.canonical.discovery.degraded", file: "packages/sno-station-mem/src/engine/provider/canonical-memory-corpus.ts", function: "listCanonicalMemoryFiles", site_id: "memory.provider.canonical.discovery.degraded" });
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeSearchText(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

function queryTerms(query: string): string[] {
	const normalized = normalizeSearchText(query)
		.split(/[^\p{L}\p{M}\p{N}]+/u)
		.filter((term) => term.length > 1);
	return [...new Set(normalized)];
}

function scoreText(text: string, terms: string[]): number {
	const lower = normalizeSearchText(text);
	const matched = terms.filter((term) => lower.includes(term)).length;
	if (matched === 0) return 0;
	return matched / Math.max(terms.length, 1);
}

function bestSnippet(lines: string[], terms: string[]): { line: number; snippet: string } {
	let bestLine = 0;
	let bestScore = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const score = scoreText(lines[index] ?? "", terms);
		if (score > bestScore) {
			bestLine = index;
			bestScore = score;
		}
	}
	const snippet = (lines[bestLine] ?? "").trim() || lines.slice(0, 2).join(" ").trim();
	return { line: bestLine + 1, snippet };
}

export async function searchCanonicalMemoryFiles(params: {
	diagnostics?: CanonicalMemoryDiagnostics;
	workspaceDir: string;
	query: string;
	maxResults: number;
}): Promise<MemorySearchResult[]> {
	const terms = queryTerms(params.query);
	if (terms.length === 0) return [];
	const files = await listCanonicalMemoryFiles(params.workspaceDir, params.diagnostics);
	const results: MemorySearchResult[] = [];
	for (const file of files) {
		const text = await readFile(file.realPath, "utf8");
		const score = scoreText(text, terms);
		if (score <= 0) continue;
		const lines = text.split("\n");
		const { line, snippet } = bestSnippet(lines, terms);
		results.push({
			path: file.path,
			startLine: line,
			endLine: line,
			score,
			textScore: score,
			snippet,
			source: "memory",
			citation: `${file.path}:${line}`,
		});
	}
	return results
		.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
		.slice(0, clampInt(params.maxResults, 1, MAX_READ_LINES));
}

export async function readCanonicalMemoryFile(params: {
	workspaceDir: string;
	relPath: string;
	from?: number;
	lines?: number;
}): Promise<CanonicalMemoryReadResult> {
	const { resolved, lines: allLines } = await readCanonicalText(params.workspaceDir, params.relPath);
	const start = clampInt(params.from ?? 1, 1, Math.max(allLines.length, 1));
	const requested = clampInt(params.lines ?? DEFAULT_READ_LINES, 1, MAX_READ_LINES);
	const endExclusive = Math.min(start - 1 + requested, allLines.length);
	const truncated = endExclusive < allLines.length;
	return {
		text: allLines.slice(start - 1, endExclusive).join("\n"),
		path: resolved.path,
		startLine: start,
		endLine: Math.max(start, endExclusive),
		...(truncated ? { truncated, nextFrom: endExclusive + 1 } : {}),
		from: start,
		lines: requested,
	};
}

export function canonicalMemoryWorkspaceFingerprint(workspaceDir: string): string {
	return normalizeWorkspaceDir(workspaceDir).split(sep).join("/");
}
