const TRANSCRIPT_ROLES = ["system", "user", "assistant"] as const;
const ROLE_ESCAPE = "\u200B";

function startsWithRoleLabel(line: string): boolean {
	return TRANSCRIPT_ROLES.some((role) => line.startsWith(`${role}:`));
}

/** Escapes continuation lines that would otherwise be parsed as new message headers. */
export function escapeTranscriptRoleContinuations(content: string): string {
	return content
		.split("\n")
		.map((line, index) => {
			if (index === 0) return line;
			if (line.startsWith(ROLE_ESCAPE) || startsWithRoleLabel(line)) {
				return `${ROLE_ESCAPE}${line}`;
			}
			return line;
		})
		.join("\n");
}

/** Reverses one builder-owned escape while preserving marker-prefixed user content. */
export function unescapeTranscriptRoleContinuation(line: string): string {
	if (line.startsWith(`${ROLE_ESCAPE}${ROLE_ESCAPE}`)) return line.slice(1);
	const escaped = line.slice(ROLE_ESCAPE.length);
	return line.startsWith(ROLE_ESCAPE) && startsWithRoleLabel(escaped) ? escaped : line;
}
