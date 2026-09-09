import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Validate and prepare the storage directory for the SQLite database file.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved parent directory path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath: string): string {
	const dirPath = dirname(dbPath);
	let resolvedDir = dirPath;

	// Resolve symlinks before creating or permission-checking the directory.
	try {
		const stats = lstatSync(dirPath);
		// Guard guard condition here so the remaining persistence path works with normalized inputs.
		if (stats.isSymbolicLink()) {
			// Isolate the database setup operation that can fail because of runtime I/O or input shape.
			try {
				// This persistence step establishes state that later reads and cleanup paths depend on.
				resolvedDir = realpathSync(dirPath);
			} catch (err: unknown) {
				const e = err as NodeJS.ErrnoException;
				// Surface this invalid database setup state as an explicit typed failure.
				throw new Error(
					`dbPath parent "${dirPath}" is a symlink whose target does not exist.\n` +
						`  Fix: Create the target directory, or update the symlink to a valid path.\n` +
						`  Details: ${e.code ?? ""} ${e.message}`,
				);
			}
		}
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		// Guard e.code here so the remaining persistence path works with normalized inputs.
		if (e.code === "ENOENT") {
			// Missing directories are created below.
		} else if (
			typeof e.message === "string" &&
			e.message.includes("symlink whose target does not exist")
		) {
			// Surface this invalid database setup state as an explicit typed failure.
			throw err;
		}
		// Continue with the original path for non-critical lstat failures.
	}

	// Create the storage directory before opening SQLite.
	if (!existsSync(resolvedDir)) {
		// Isolate the database setup operation that can fail because of runtime I/O or input shape.
		try {
			mkdirSync(resolvedDir, { recursive: true });
		} catch (err: unknown) {
			const e = err as NodeJS.ErrnoException;
			// Surface this invalid database setup state as an explicit typed failure.
			throw new Error(
				`Failed to create dbPath directory "${resolvedDir}".\n` +
					`  Fix: Ensure the parent directory "${dirname(resolvedDir)}" exists and is writable,\n` +
					`       or create it manually: mkdir -p "${resolvedDir}"\n` +
					`  Details: ${e.code ?? ""} ${e.message}`,
			);
		}
	}

	// Fail early if SQLite will be unable to create or update files.
	try {
		accessSync(resolvedDir, constants.W_OK);
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		// Surface this invalid database setup state as an explicit typed failure.
		throw new Error(
			`dbPath directory "${resolvedDir}" is not writable.\n` +
				`  Fix: Check permissions with: ls -la "${dirname(resolvedDir)}"\n` +
				`       Or grant write access: chmod u+w "${resolvedDir}"\n` +
				`  Details: ${e.code ?? ""} ${e.message}`,
		);
	}

	// Centralize the persistence fallback value at the boundary of this helper.
	return resolvedDir;
}
