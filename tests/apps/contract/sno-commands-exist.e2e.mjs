// Every `sno ...` command that Station docs and user-facing hints name must exist in the real sno binary.
// A stand-in binary would pass after the real one renamed a command, so this runs the real one.
// Usage: SNO_BINARY=/abs/path/to/sno node tests/apps/contract/sno-commands-exist.e2e.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const binary = process.env.SNO_BINARY;
if (!binary || !isAbsolute(binary)) throw new Error("SNO_BINARY must be the absolute path of the real sno binary");
const root = new URL("../../../", import.meta.url).pathname;

// Installed by Station, or handed straight to another program: the binary alone cannot answer for them.
const outsideTree = new Set(["away-brief", "catch-report", "deliver-proof", "handoff-checkpoint", "heartbeat", "medic", "reach",
	"rem-reflect", "rotate-agent-resume", "subscription-quota-check", "report-time", "memory", "observe"]);
// Names the CLI retired. A leaf command with a free argument would accept them as that argument, so ask for them by name.
const retired = [/\bsno account machine\b/, /\bsno skills (?:get|list)\b/, /\bsno station telemetry\b/, /\bsno station audit verify\b/, /\bsno products answer\b/];

function files(dir, accept) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...files(path, accept));
		else if (accept(path)) out.push(path);
	}
	return out;
}
const sources = [
	join(root, "README.md"),
	...files(join(root, "docs"), p => p.endsWith(".md") && !p.includes("/docs/readme/") && !p.includes("/locale/")),
	...["apps", "packages"].flatMap(dir => files(join(root, dir), p => (p.endsWith("README.md") || (p.includes("/src/") && p.endsWith(".ts")) && !p.endsWith(".generated.ts")))),
];

const helps = new Map();
function help(words) {
	const key = words.join(" ");
	if (!helps.has(key)) {
		const run = spawnSync(binary, [...words, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
		const usage = /^Usage: (.*)$/m.exec(run.stdout)?.[1];
		const named = usage?.split(/\s+/).slice(1).filter(word => !/^[[<-]/.test(word)) ?? [];
		helps.set(key, usage && named.join(" ") === key ? { usage, text: run.stdout } : undefined);
	}
	return helps.get(key);
}

const problems = [];
let checked = 0;
for (const file of sources) {
	const text = readFileSync(file, "utf8");
	const where = file.slice(root.length);
	for (const retiredForm of retired) if (retiredForm.test(text)) problems.push(`${where}: names a retired command (${retiredForm.source})`);
	for (const match of text.matchAll(/`sno ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)/g)) {
		const words = match[1].split(" ");
		if (outsideTree.has(words[0])) continue;
		let path = [];
		while (path.length < words.length && help([...path, words[path.length]])) path.push(words[path.length]);
		const rest = words.slice(path.length);
		const usage = path.length ? help(path).usage : "";
		const isGroup = /[[<]COMMAND[\]>]/.test(usage);
		if (path.length === 0 || (rest.length > 0 && (isGroup || !/[[<][A-Z_]+[\]>]/.test(usage.replace(/[[<]OPTIONS[\]>]/, ""))))) problems.push(`${where}: \`sno ${match[1]}\` is not a command of this binary`);
		checked += 1;
	}
}
if (checked === 0) throw new Error("no command was found to check");
if (problems.length > 0) {
	console.error(`sno command contract failed:\n- ${[...new Set(problems)].join("\n- ")}`);
	process.exit(1);
}
console.log(`sno command contract ok: ${checked} command mentions in ${sources.length} files against ${spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()}`);
