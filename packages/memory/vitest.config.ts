import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "../..");

export default defineConfig({
	root: repoRoot,
	resolve: {
		alias: [
			{ find: /^@\/config$/, replacement: resolve(appRoot, "config/index.ts") },
			{ find: /^@\//, replacement: `${resolve(appRoot, "src")}/` },
			{
				find: /^better-sqlite3$/,
				replacement: resolve(repoRoot, "node_modules/better-sqlite3/lib/index.js"),
			},
			{
				find: /^sqlite-vec$/,
				replacement: resolve(repoRoot, "node_modules/sqlite-vec/index.mjs"),
			},
		],
	},
	test: {
		env: {
			NODE_ENV: "test",
			SNO_STATION_MEM_NODE_ENV: "test",
			SNO_OBSERVE_ENABLED: "false",
			SNO_STATION_MEM_SNO_OBSERVE_ENABLED: "false",
		},
		exclude: [
			...configDefaults.exclude,
			".claude/**",
			"internal/repo-reference/**",
		],
		fileParallelism: false,
		hookTimeout: 120_000,
		maxWorkers: 1,
		setupFiles: [resolve(repoRoot, "tests/apps/mem-claw/helpers/runtime-service-cleanup.ts")],
		testTimeout: 120_000,
	},
});
