export const MESSAGES = {
	usage: "Usage: sno-mem-codex <session-start|user-prompt-submit|stop|install|doctor|import|recall|get|remember|correct>",
	dryRunPrefix: "would write",
	installComplete: "sno-mem-codex install complete",
	invalidHooksReplaced: "invalid hooks.json replaced during install",
	installImportDeferred: "Codex memory import deferred; installation is active",
	importCaptureDisabled: "Automatic capture is off in settings.json (capture.ambient); imported notes will be skipped.",
	doctorUnavailable: "doctor: unavailable",
} as const;
