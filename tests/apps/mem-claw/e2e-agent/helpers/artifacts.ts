import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serialize } from "./json";
import type { TestConfig } from "./types";

// Evidence is append-only: an existing file is never overwritten. The runner
// retries a failed phase once into the same run-scoped artifact directory, so a
// plain "wx" write made every retry die on EEXIST before the phase could run.
// The retry's evidence lands beside the first attempt's instead.
async function writeNewFile(
	directory: string,
	name: string,
	content: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const candidate = attempt === 0 ? name : `${name}.attempt-${attempt + 1}`;
		try {
			await writeFile(join(directory, candidate), content, { flag: "wx" });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
		}
	}
	throw new Error(`refusing to write ${name}: 100 attempts already recorded in ${directory}`);
}

export async function writeArtifact(
	config: Pick<TestConfig, "artifactDir">,
	name: string,
	content: string,
): Promise<void> {
	await mkdir(config.artifactDir, { recursive: true });
	await writeNewFile(config.artifactDir, name, content);
}

export async function writeJsonArtifact(
	config: Pick<TestConfig, "artifactDir">,
	name: string,
	value: unknown,
): Promise<void> {
	await writeArtifact(config, name, serialize(value));
}

export function redactIdentity(identity: {
	machine_secret: string;
	machine_uuid: string;
	user_cuid: string;
}) {
	return {
		machine_secret: `${identity.machine_secret.slice(0, 6)}...redacted`,
		machine_uuid: identity.machine_uuid,
		user_cuid: identity.user_cuid,
	};
}
