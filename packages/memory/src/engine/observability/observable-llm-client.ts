/** @file observable-llm-client.ts
 * @purpose Emits best-effort observe metadata around plugin LLM calls.
 * @boundary Wraps the public LlmClient interface only.
 */

import { Mutex } from "async-mutex";
import type { JsonObject } from "@snoai/sno-observe";
import type { LlmClient, LlmClientConfig, MemoryLlmRequest } from "../../model/llm-client";
import { resolveLlmRoute } from "../../model/llm-mode-routing";
import { observeBackgroundCooldownKey, type PluginObservability } from "./adapter";
import { countTextTokens } from "./token-counter";

type SessionUuidProvider = () => string | undefined;

export class ObservableLlmClient implements LlmClient {
	// Serializes observeCall's inner-call + usage-read critical section. Reordering
	// alone (resolve config first, read getLastUsage() on the next line) still leaves
	// a microtask hop between the inner call's promise resolving and this wrapper's
	// continuation resuming — another overlapping completeJson's continuation can run
	// in that hop and overwrite the inner client's shared lastUsage first. The inner
	// client has no atomic {result, usage} return, so only serializing the section
	// that depends on the shared state closes the race. host review 2026-07-12.
	private readonly usageMutex = new Mutex();

	constructor(
		private readonly inner: LlmClient,
		private readonly config: Pick<LlmClientConfig, "preset" | "routing">,
		private readonly observability: PluginObservability,
		private readonly sessionUuidProvider: SessionUuidProvider,
	) {}

	async completeJson<T>(request: MemoryLlmRequest): Promise<T | null> {
		return this.observeCall(request, () => this.inner.completeJson<T>(request));
	}

	async completeText(request: MemoryLlmRequest): Promise<string | null> {
		return this.observeCall(request, () => this.inner.completeText(request));
	}

	private async observeCall<T>(
		request: MemoryLlmRequest,
		call: () => Promise<T | null>,
	): Promise<T | null> {
		if (this.config.routing) {
			const route = resolveLlmRoute({
				slot: request.adapterSlot,
				callLabel: request.callLabel,
				config: this.config.routing,
			});
			if ("off" in route || route.transport === "agent-host-seam") {
				return this.usageMutex.runExclusive(call);
			}
		}
		// Resolve config before the call so no await sits between the call
		// resolving and the synchronous getLastUsage() read: the inner client
		// stores usage in shared per-client state, and an await here would let an
		// overlapping completeJson overwrite it and misattribute token cost.
		const resolved = await this.inner.getResolvedConfig().catch(async (error: unknown) => {
			await this.observability.emitError(
				"llm_client_resolve_config",
				error,
				this.sessionUuidProvider(),
			);
			return null;
		});
		const started = Date.now();
		try {
			// Hold the mutex from the inner call through the getLastUsage() read so no
			// overlapping observeCall can resume in between and overwrite the inner
			// client's shared usage state before this call reads its own.
			const { result, providerUsage } = await this.usageMutex.runExclusive(async () => {
				const callResult = await call();
				return { result: callResult, providerUsage: this.inner.getLastUsage() };
			});
			if (!resolved) return result;
			const sessionUuid = this.sessionUuidProvider();
			const hasProviderUsage =
				providerUsage !== null && providerUsage.inputTokens + providerUsage.outputTokens > 0;
			const promptCount = hasProviderUsage
				? providerUsage.inputTokens
				: countTextTokens(request.prompt, resolved.model).count;
			const completionCount = hasProviderUsage
				? providerUsage.outputTokens
				: countTextTokens(result === null ? "" : JSON.stringify(result), resolved.model).count;
			this.observability.trackBestEffort(
				"llm.call",
				async () => {
					await this.observability.emit({
						eventType: "llm.call",
						sessionUuid,
						payload: {
							model: `${resolved.provider}:${resolved.model}`,
							prompt_tokens: promptCount,
							completion_tokens: completionCount,
							latency_ms: Date.now() - started,
							cache_read_tokens: 0,
							cache_write_tokens: 0,
							token_source: "plugin_internal_paid",
						} satisfies JsonObject,
					});
				},
				{ cooldownKey: observeBackgroundCooldownKey("llm.call", sessionUuid) },
			);
			return result;
		} catch (error) {
			await this.observability.emitError("llm_client_throw", error, this.sessionUuidProvider());
			throw error;
		}
	}

	getResolvedConfig(): ReturnType<LlmClient["getResolvedConfig"]> {
		return this.inner.getResolvedConfig();
	}

	getLastError(): string | null {
		return this.inner.getLastError();
	}

	getLastUsage(): ReturnType<LlmClient["getLastUsage"]> {
		return this.inner.getLastUsage();
	}
}
