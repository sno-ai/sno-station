export async function withinDeadline<T>(run: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const error = new Error("timeout");
					error.name = "TimeoutError";
					reject(error);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
