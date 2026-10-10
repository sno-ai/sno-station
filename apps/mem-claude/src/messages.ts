export const MESSAGES = {
	usage: "Run through sno: sno memory <recall|get|remember|correct|import|doctor> --harness claude, or sno memory hook <event> --harness claude",
	dryRunPrefix: "would write",
	installComplete: "Sno memory for Claude Code installed",
	uninstallComplete: "Sno memory for Claude Code removed",
	settingsUnparsable: "settings.json parse error; settings preserved",
	importCaptureDisabled: "Automatic capture is off in settings.json (capture.ambient); imported notes will be skipped.",
	doctorUnavailable: "doctor: unavailable",
} as const;
