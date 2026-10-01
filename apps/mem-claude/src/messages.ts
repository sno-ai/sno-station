export const MESSAGES = {
	usage: "Usage: sno-mem-claude <session-start|user-prompt-submit|stop|install|doctor|import|recall|get|remember|correct>",
	dryRunPrefix: "would write",
	installComplete: "sno-mem-claude install complete",
	settingsUnparsable: "settings.json parse error; settings preserved",
	importCaptureDisabled: "Automatic capture is off in settings.json (capture.ambient); imported notes will be skipped.",
	doctorUnavailable: "doctor: unavailable",
} as const;
