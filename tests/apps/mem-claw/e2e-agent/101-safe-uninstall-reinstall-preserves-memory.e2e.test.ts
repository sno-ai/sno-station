import { describe, expect, test } from "vitest";
import {
	assertLiveAgentE2EEnabled,
	loadConfig,
	numberEnv,
} from "./helpers/config";
import {
	recallSafeUninstallFacts,
	teachSafeUninstallFacts,
} from "./helpers/safe-uninstall";
import {
	safeAuditPath,
	safeDbPath,
	safeManifestPath,
	vmDeployPlugin,
	vmFileExists,
	vmReadInstallManifest,
	vmReset,
	vmSnapshotSafeUninstallPaths,
	vmStopGateway,
	vmUninstallPlugin,
	vmWriteSafeUninstallSnapshot,
} from "./helpers/vm-ops";

assertLiveAgentE2EEnabled();

describe("safe uninstall S2 uninstall/reinstall", () => {
	const timeoutMs = numberEnv("SNO_SAFE_UNINSTALL_TEST_TIMEOUT_MS", 480_000);

	test(
		"preserves memory and installation identity across plugin uninstall/reinstall",
		async () => {
			const config = await loadConfig();
			if (process.env.SNO_SAFE_UNINSTALL_SKIP_RESET !== "1") {
				await vmReset(config, { purgeKeychain: true });
			}
			await vmDeployPlugin(config);

			const before = await vmReadInstallManifest(config);
			const facts = await teachSafeUninstallFacts(config, "s2-reinstall");
			const beforeUninstall = await vmSnapshotSafeUninstallPaths(config);

			await vmStopGateway(config);
			await vmUninstallPlugin(config);
			const afterUninstall = await vmSnapshotSafeUninstallPaths(config);
			await vmWriteSafeUninstallSnapshot(
				config,
				"s2-after-uninstall-paths.json",
			);
			expect(afterUninstall.extensionExists).toBe(false);
			expect(await vmFileExists(config, safeManifestPath)).toBe(true);
			expect(await vmFileExists(config, safeDbPath)).toBe(true);
			expect(await vmFileExists(config, safeAuditPath)).toBe(true);
			expect(afterUninstall.costExists).toBe(beforeUninstall.costExists);

			await vmDeployPlugin(config);
			const after = await vmReadInstallManifest(config);
			expect(after.installationId).toBe(before.installationId);
			await recallSafeUninstallFacts(config, "s2-reinstall", facts);
		},
		timeoutMs,
	);
});
