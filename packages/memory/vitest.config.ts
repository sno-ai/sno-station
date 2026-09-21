import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "../..");

export default defineConfig({
	root: repoRoot,
	resolve: {
		alias: [
			{ find: /^@snoai\/sno-station-mem\/client$/, replacement: resolve(appRoot, "src/contract/client.ts") },
			{ find: /^@snoai\/sno-station-mem\/coding-skin$/, replacement: resolve(appRoot, "config/coding-skin.ts") },
			{ find: /^@snoai\/sno-station-mem\/internal\/config\//, replacement: `${resolve(appRoot, "config")}/` },
			{ find: /^@snoai\/sno-station-mem\/internal\//, replacement: `${resolve(appRoot, "src")}/` },
			{ find: /^@snoai\/sno-station-mem$/, replacement: resolve(appRoot, "src/index.ts") },
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
			...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith("SNO_MEM_TELEMETRY_HMAC_KEY") && value !== undefined).map(([key, value]) => [key.replace("SNO_MEM_TELEMETRY_HMAC_KEY", "SNO_STATION_MEM_TELEMETRY_HMAC_KEY"), value])),
			NODE_ENV: "test",
			SNO_STATION_MEM_NODE_ENV: "test",
			SNO_OBSERVE_ENABLED: "false",
			SNO_OBSERVE_ENABLED: "false",
		},
		exclude: [
			...configDefaults.exclude,
			".claude/**",
		],
		fileParallelism: false,
		hookTimeout: 120_000,
		maxWorkers: 1,
		setupFiles: [resolve(repoRoot, "tests/apps/mem-claw/helpers/runtime-service-cleanup.ts")],
		testTimeout: 120_000,
	},
});
