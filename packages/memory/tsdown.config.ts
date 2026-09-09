import { defineConfig } from "tsdown";

const sharedConfig = {
	outDir: "dist",
	format: "esm" as const,
	target: "node22" as const,
	platform: "node" as const,
	// Root tsconfig sets sourceMap/declarationMap: true; without these
	// overrides tsdown inherits them and ships ~2.7 MB of maps in the package.
	sourcemap: false,
	outputOptions: { sourcemap: false },
	// Keep tsup-era filenames: package.json "main"/"exports" and
	// openclaw.plugin.json point at dist/**/*.js, not .mjs.
	outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
	dts: {
		// oxc: isolated-declarations generator — no dependency on the TypeScript
		// compiler API, so the TS7 native compiler can't break dts emit. Pinned
		// so TS7's presence doesn't auto-select the experimental tsgo generator.
		generator: "oxc",
		// eager: workspace deps are consumed as .ts source (exports -> ./src);
		// without it the dts generator skips files outside this app's program.
		eager: true,
		compilerOptions: { declarationMap: false },
	},
};

export default defineConfig([
	{
		...sharedConfig,
		entry: {
			"plugin/openclaw-plugin-runtime": "src/plugin/openclaw-plugin-runtime.ts",
			"self-upgrade/entry-shim": "src/self-upgrade/entry-shim.ts",
			memdump: "src/memdump.ts",
			"diagnostic-encoder": "src/observability/early-diagnostics.ts",
		},
		clean: true,
	},
	{
		...sharedConfig,
		entry: { "sidecar/main": "src/sidecar/main.ts" },
		clean: false,
		deps: {
			alwaysBundle: ["@snoai/embedder"],
		},
	},
]);
