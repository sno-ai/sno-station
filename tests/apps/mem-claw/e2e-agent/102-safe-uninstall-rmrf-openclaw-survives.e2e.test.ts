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
	vmDeployPlugin,
	vmReadInstallManifest,
	vmRemoveOpenClawRuntimeState,
	vmReset,
	vmWriteSafeUninstallSnapshot,
} from "./helpers/vm-ops";

assertLiveAgentE2EEnabled();

describe("safe uninstall S3 OpenClaw runtime removal", () => {
	const timeoutMs = numberEnv("SNO_SAFE_UNINSTALL_TEST_TIMEOUT_MS", 480_000);

	test(
		"survives removing the OpenClaw runtime/plugin state because memory is under ~/.snoai",
		async () => {
			const config = await loadConfig();
			await vmReset(config, { purgeKeychain: true });
			await vmDeployPlugin(config);

			const before = await vmReadInstallManifest(config);
			const facts = await teachSafeUninstallFacts(config, "s3-rmrf-openclaw");

			await vmRemoveOpenClawRuntimeState(config);
			await vmDeployPlugin(config);
			const after = await vmReadInstallManifest(config);
			expect(after.installationId).toBe(before.installationId);
			await vmWriteSafeUninstallSnapshot(
				config,
				"s3-after-openclaw-removal-paths.json",
			);
			await recallSafeUninstallFacts(config, "s3-rmrf-openclaw", facts);
		},
		timeoutMs,
	);
});
