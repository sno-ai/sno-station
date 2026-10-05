export const MESSAGES = {
	usage: "Run through sno: sno memory <recall|get|remember|correct|import|doctor> --harness codex, or sno memory hook <event> --harness codex",
	dryRunPrefix: "would write",
	installComplete: "Sno memory for Codex installed",
	invalidHooksReplaced: "invalid hooks.json replaced during install",
	installImportDeferred: "Codex memory import deferred; installation is active",
	importCaptureDisabled: "Automatic capture is off in settings.json (capture.ambient); imported notes will be skipped.",
	doctorUnavailable: "doctor: unavailable",
} as const;
