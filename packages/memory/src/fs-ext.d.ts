declare module "fs-ext" {
	interface FileLocking {
		flockSync(fd: number, flags: "shnb" | "exnb" | "un"): void;
	}
	const locking: FileLocking;
	export default locking;
}
