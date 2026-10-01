import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pkgRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pkgRoot, "../..");

export default defineConfig({
	root: repoRoot,
	resolve: {
		alias: [{ find: /^@\//, replacement: `${resolve(pkgRoot, "src")}/` }],
	},
	test: {
		exclude: [...configDefaults.exclude, ".claude/**", "internal/**"],
		fileParallelism: false,
		hookTimeout: 120_000,
		maxWorkers: 1,
		testTimeout: 120_000,
	},
});
