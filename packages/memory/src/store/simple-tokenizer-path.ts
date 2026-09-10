/** @file simple-tokenizer-path.ts
 * @purpose Resolve the bundled `simple-tokenizer` SQLite extension binary +
 *          jieba dictionary path for the current platform.
 * @boundary Path resolution only; loading happens in `connection.ts`.
 *
 * Layout produced by `scripts/download-simple-tokenizer.ts`:
 *
 *   <plugin>/sqlite-extensions/<platform>/libsimple.{so,dylib}
 *   <plugin>/sqlite-extensions/<platform>/dict/...
 *
 * `<platform>` is one of: `linux-x64`, `linux-arm64`, `darwin-arm64`,
 * `darwin-x64`. Other platforms throw a typed error so deploys fail fast
 * instead of silently falling back to the unicode61 tokenizer.
 *
 * Both source-tree (`src/storage/simple-tokenizer-path.ts`) and bundled
 * (`lib/index.js`) call sites must resolve correctly. The bundled output lives
 * at `<plugin>/lib/index.js`, so the candidates list probes both
 * relative locations — same pattern as `MIGRATIONS_DIR` in `connection.ts`.
 */

import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const PLATFORM_KEY = `${platform()}-${arch()}` as const;

const PLATFORM_BINARY: Record<string, "libsimple.so" | "libsimple.dylib"> = {
	"linux-x64": "libsimple.so",
	"linux-arm64": "libsimple.so",
	"darwin-arm64": "libsimple.dylib",
	"darwin-x64": "libsimple.dylib",
};

export interface SimpleTokenizerPaths {
	readonly platform: string;
	readonly extensionPath: string;
	readonly dictPath: string;
}

/**
 * Resolve the on-disk paths the loader should pass to
 * `db.loadExtension(...)` and `SELECT jieba_dict(...)`. Returns an absolute
 * path under the plugin's `sqlite-extensions/<platform>/` directory.
 *
 * Throws if the platform is unsupported or the binary directory is missing
 * (postinstall didn't run, rsync excluded the directory, etc.). The error
 * names what to install/fetch so a fresh dev box doesn't need archaeology.
 */
export function resolveSimpleTokenizerPath(): SimpleTokenizerPaths {
	const binary = PLATFORM_BINARY[PLATFORM_KEY];
	if (!binary) {
		throw new Error(
			`simple-tokenizer: unsupported platform "${PLATFORM_KEY}". ` +
				`Supported: ${Object.keys(PLATFORM_BINARY).join(", ")}. ` +
				"Build from upstream wangfenjin/simple if you need another target.",
		);
	}
	const candidates = [
		join(HERE, "..", "..", "sqlite-extensions", PLATFORM_KEY),
		join(HERE, "..", "sqlite-extensions", PLATFORM_KEY),
		join(HERE, "..", "..", "..", "sqlite-extensions", PLATFORM_KEY),
	];
	for (const root of candidates) {
		const extensionPath = resolve(root, binary);
		const dictPath = resolve(root, "dict");
		if (existsSync(extensionPath) && existsSync(dictPath)) {
			return { platform: PLATFORM_KEY, extensionPath, dictPath };
		}
	}
	throw new Error(
		`simple-tokenizer binary missing for ${PLATFORM_KEY}. ` +
			`Looked under: ${candidates.join(", ")}. ` +
			"Run `node scripts/download-simple-tokenizer.mjs` from the plugin " +
			"directory, or rsync the `sqlite-extensions/` folder onto this host.",
	);
}
