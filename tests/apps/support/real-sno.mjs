// The real `sno` binary for end-to-end runs. It is built in the Sno CLI repo (`cargo build`);
// its absolute path comes from SNO_BINARY. Nothing here stands in for `sno`.
import { accessSync, constants, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export function realSno() {
	const path = process.env.SNO_BINARY;
	if (!path || !isAbsolute(path)) {
		throw new Error("SNO_BINARY must be the absolute path of a built sno binary (cargo build in the Sno CLI repo)");
	}
	accessSync(path, constants.X_OK);
	return path;
}

// A global npm prefix whose `npm root -g` holds the given packages, which is where `sno` looks for
// them. `packages` maps a package name to the directory that holds it (the repository or a pack).
export function globalPrefixWith(packages) {
	const prefix = mkdtempSync(join(tmpdir(), "sno-global-"));
	const root = join(prefix, "lib", "node_modules");
	for (const [name, directory] of Object.entries(packages)) {
		const link = join(root, name);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(directory, link);
	}
	return prefix;
}
