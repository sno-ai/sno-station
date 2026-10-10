declare module "fs-native-extensions" {
	/** Takes the lock without waiting; false when another open file holds it. */
	export function tryLock(fd: number, options?: { shared?: boolean }): boolean;
	export function unlock(fd: number): void;
}
