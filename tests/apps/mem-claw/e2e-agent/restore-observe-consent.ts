import { loadConfig } from "./helpers/config";
import { readObserveConsent, setObserveConsent } from "./helpers/observe-api";
import { readRemoteSnoIdentity } from "./helpers/remote-evidence";
import { readObserveOriginalConsentLevel } from "./helpers/state";

const config = await loadConfig();
let identity: Awaited<ReturnType<typeof readRemoteSnoIdentity>>;
try {
	identity = await readRemoteSnoIdentity(config);
} catch (error) {
	console.warn(
		`Agent 1:1 Sno identity is not available; skipping Observe consent restore: ${
			error instanceof Error ? error.message : String(error)
		}`,
	);
	process.exit(0);
}
const restoreLevel = await readObserveOriginalConsentLevel();

if (!restoreLevel) {
	console.warn(
		"Agent 1:1 original Observe consent was not captured; nothing to restore.",
	);
	process.exit(0);
}

await setObserveConsent(config, identity.machine_secret, {
	level: restoreLevel,
	machineUuid: identity.machine_uuid,
	reason: "agent_e2e_restore_original_consent",
});

const consent = await readObserveConsent(
	config,
	identity.machine_secret,
	identity.machine_uuid,
);
if (consent.level !== restoreLevel) {
	throw new Error(
		`Observe consent restore verified ${consent.level}, not ${restoreLevel}`,
	);
}
