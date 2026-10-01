export class AsyncMutex {
	private current: Promise<void> = Promise.resolve();

	async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
		const previous = this.current;
		let release: () => void = () => undefined;
		this.current = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
