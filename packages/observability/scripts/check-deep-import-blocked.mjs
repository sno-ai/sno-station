#!/usr/bin/env node
// Static guard per tasks.md §30.2: deep imports MUST NOT resolve from outside
// the package. The exports map in package.json restricts external consumers to
// the public entry only. We probe several internal specifiers across both ESM
// and CJS conditions and assert the exact ERR_PACKAGE_PATH_NOT_EXPORTED error
// (a bare ERR_MODULE_NOT_FOUND would mask a missing-symlink false success).
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN_SPECIFIERS = [
	"@snoai/sno-observe/internal/canonical-hash",
	"@snoai/sno-observe/internal/buffer-store",
	"@snoai/sno-observe/internal/runtime",
	"@snoai/sno-observe/internal/redact",
	"@snoai/sno-observe/internal/identity",
	"@snoai/sno-observe/dist/internal/canonical-hash.js",
	"@snoai/sno-observe/src/internal/canonical-hash",
];

const dir = mkdtempSync(join(tmpdir(), "sno-observe-deep-import-"));
try {
	mkdirSync(join(dir, "node_modules", "@snoai"), { recursive: true });
	const linkPath = join(dir, "node_modules", "@snoai", "sno-observe");
	// Use junction on Windows where symlinks need elevated privileges; "dir"
	// elsewhere. fs.symlinkSync handles cross-platform; "junction" is silently
	// downgraded on POSIX.
	const symlinkType = process.platform === "win32" ? "junction" : "dir";
	symlinkSync(pkgRoot, linkPath, symlinkType);

	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "deep-import-test", type: "module", private: true }, null, 2),
	);

	let failed = false;
	for (const specifier of FORBIDDEN_SPECIFIERS) {
		// ESM probe.
		if (!probeBlocked(dir, specifier, "esm")) {
			failed = true;
		}
		// CJS probe — guards against future regressions adding a `"require"`
		// condition to the exports map.
		if (!probeBlocked(dir, specifier, "cjs")) {
			failed = true;
		}
	}
	if (failed) {
		process.exit(1);
	}
	console.log("OK: deep import blocked by exports map (ESM + CJS, multiple specifiers)");
} finally {
	rmSync(dir, { recursive: true, force: true });
}

function probeBlocked(dir, specifier, mode) {
	const probeFile = mode === "esm" ? "probe.mjs" : "probe.cjs";
	const body =
		mode === "esm" ? `import "${specifier}";\n` : `require("${specifier}");\n`;
	writeFileSync(join(dir, probeFile), body);
	const result = spawnSync(process.execPath, [probeFile], {
		cwd: dir,
		encoding: "utf8",
	});
	if (result.status === 0) {
		console.error(
			`FAIL [${mode}] deep import resolved: ${specifier} — exports map does not block it`,
		);
		console.error(result.stdout);
		return false;
	}
	if (!/ERR_PACKAGE_PATH_NOT_EXPORTED/u.test(result.stderr)) {
		console.error(
			`FAIL [${mode}] unexpected error for ${specifier} — expected ERR_PACKAGE_PATH_NOT_EXPORTED`,
		);
		console.error(result.stderr);
		return false;
	}
	return true;
}
