import { describe, expect, test } from "vitest";
import {
	assertLiveAgentE2EEnabled,
	loadConfig,
	numberEnv,
} from "./helpers/config";
import { teachAndRecallSafeUninstallFacts } from "./helpers/safe-uninstall";
import {
	safeDbPath,
	safeManifestPath,
	vmDeployPlugin,
	vmFileExists,
	vmReadInstallManifest,
	vmReset,
	vmWriteSafeUninstallSnapshot,
} from "./helpers/vm-ops";

assertLiveAgentE2EEnabled();

describe("safe uninstall S1 fresh install baseline", () => {
	const timeoutMs = numberEnv("SNO_SAFE_UNINSTALL_TEST_TIMEOUT_MS", 420_000);

	test(
		"creates durable data outside the OpenClaw extension directory",
		async () => {
			const config = await loadConfig();
			await vmReset(config, { purgeKeychain: true });
			await vmDeployPlugin(config);

			await teachAndRecallSafeUninstallFacts(config, "s1-fresh-install");

			const manifest = await vmReadInstallManifest(config);
			expect(manifest.installationId.length).toBeGreaterThan(0);
			expect(await vmFileExists(config, safeManifestPath)).toBe(true);
			expect(await vmFileExists(config, safeDbPath)).toBe(true);
			await vmWriteSafeUninstallSnapshot(config, "s1-fresh-install-paths.json");
		},
		timeoutMs,
	);
});
