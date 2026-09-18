/** @file observable-embedding-provider-client.ts
 * @purpose Emits best-effort observe metadata around embedding calls.
 * @boundary Preserves Embedder behavior; observability failures never affect embedding.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Embedder, type EmbeddingConfig } from "../extraction/embedding-provider-client";
import type { PluginObservability } from "./adapter";
import { bestEffort } from "./best-effort";

type SessionUuidProvider = () => string | undefined;

export class ObservableEmbedder extends Embedder {
	private readonly observationScope = new AsyncLocalStorage<boolean>();

	constructor(
		config: EmbeddingConfig,
		stateDir: string,
		private readonly observability: PluginObservability,
		private readonly sessionUuidProvider: SessionUuidProvider,
	) {
		super(config, stateDir);
	}

	override async embed(text: string): Promise<Float32Array> {
		return this.observeEmbedding(() => super.embed(text));
	}

	protected override async embedDirect(text: string): Promise<Float32Array> {
		return this.observeEmbedding(() => super.embedDirect(text));
	}

	override async embedMany(values: string[]): Promise<Float32Array[]> {
		return this.observeEmbedding(() => super.embedMany(values));
	}

	override async embedChunks(texts: string[]): Promise<Float32Array[]> {
		return this.observeEmbedding(() => super.embedChunks(texts));
	}

	private async observeEmbedding<T>(operation: () => Promise<T>): Promise<T> {
		if (this.observationScope.getStore()) return operation();
		return this.observationScope.run(true, async () => {
			try {
				return await operation();
			} catch (error) {
				await bestEffort("embedding error", () =>
					this.observability.emitError("embedder_throw", error, this.sessionUuidProvider()),
				);
				throw error;
			}
		});
	}
}
