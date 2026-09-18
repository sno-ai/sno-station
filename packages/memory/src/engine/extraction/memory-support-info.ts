/** @file memory-support-info.ts
 * @purpose Parses and updates contextual support statistics for memories.
 * @boundary Support-info V2 vocabulary, parsing, and bounded updates only.
 */

export const SUPPORT_CONTEXT_VOCABULARY = [
	"general",
	"morning",
	"afternoon",
	"evening",
	"night",
	"weekday",
	"weekend",
	"work",
	"leisure",
	"summer",
	"winter",
	"travel",
] as const;

export type SupportContext = (typeof SUPPORT_CONTEXT_VOCABULARY)[number] | string;

export const MAX_SUPPORT_SLICES = 8;

export interface ContextualSupport {
	context: SupportContext;
	confirmations: number;
	contradictions: number;
	/** confirmations / (confirmations + contradictions) */
	strength: number;
	last_observed_at: number;
}

export interface SupportInfoV2 {
	/** Weighted average across all slices. */
	global_strength: number;
	/** Sum of all confirmations + contradictions. */
	total_observations: number;
	slices: ContextualSupport[];
}

/** Normalizes context at the boundary before insight metadata parsing uses it. */
export function normalizeContext(raw: string | undefined): SupportContext {
	if (!raw?.trim()) return "general";
	const lower = raw.trim().toLowerCase();

	if ((SUPPORT_CONTEXT_VOCABULARY as readonly string[]).includes(lower)) {
		return lower as SupportContext;
	}

	const aliases: Record<string, SupportContext> = {
		早上: "morning",
		上午: "morning",
		早晨: "morning",
		下午: "afternoon",
		傍晚: "evening",
		晚上: "evening",
		深夜: "night",
		夜晚: "night",
		凌晨: "night",
		工作日: "weekday",
		平时: "weekday",
		周末: "weekend",
		假日: "weekend",
		休息日: "weekend",
		工作: "work",
		上班: "work",
		办公: "work",
		休闲: "leisure",
		放松: "leisure",
		休息: "leisure",
		夏天: "summer",
		夏季: "summer",
		冬天: "winter",
		冬季: "winter",
		旅行: "travel",
		出差: "travel",
		旅游: "travel",
	};

	return aliases[lower] ?? lower;
}

/** Parses support info into the normalized shape used by insight metadata parsing. */
export function parseSupportInfo(raw: unknown): SupportInfoV2 {
	const defaultV2: SupportInfoV2 = {
		global_strength: 0.5,
		total_observations: 0,
		slices: [],
	};

	if (!raw || typeof raw !== "object") return defaultV2;
	const obj = raw as Record<string, unknown>;

	if (Array.isArray(obj.slices)) {
		return {
			global_strength: typeof obj.global_strength === "number" ? obj.global_strength : 0.5,
			total_observations: typeof obj.total_observations === "number" ? obj.total_observations : 0,
			slices: (obj.slices as Record<string, unknown>[])
				.filter((s) => s && typeof s.context === "string")
				.map((s) => ({
					context: String(s.context),
					confirmations:
						typeof s.confirmations === "number" && s.confirmations >= 0 ? s.confirmations : 0,
					contradictions:
						typeof s.contradictions === "number" && s.contradictions >= 0 ? s.contradictions : 0,
					strength:
						typeof s.strength === "number" && s.strength >= 0 && s.strength <= 1 ? s.strength : 0.5,
					last_observed_at:
						typeof s.last_observed_at === "number" ? s.last_observed_at : Date.now(),
				})),
		};
	}

	const conf = typeof obj.confirmations === "number" ? obj.confirmations : 0;
	const contra = typeof obj.contradictions === "number" ? obj.contradictions : 0;
	const total = conf + contra;
	if (total === 0) return defaultV2;

	return {
		global_strength: total > 0 ? conf / total : 0.5,
		total_observations: total,
		slices: [
			{
				context: "general",
				confirmations: conf,
				contradictions: contra,
				strength: total > 0 ? conf / total : 0.5,
				last_observed_at: Date.now(),
			},
		],
	};
}

/**
 * Implements update support stats as the local insight metadata parsing
 * operation. `at` is the observation event time (the session date when one is
 * known); it defaults to the wall clock only when no session anchor exists.
 */
export function updateSupportStats(
	existing: SupportInfoV2,
	contextLabel: string | undefined,
	event: "support" | "contradict",
	at: number = Date.now(),
): SupportInfoV2 {
	const ctx = normalizeContext(contextLabel);
	const base = {
		...existing,
		slices: [...existing.slices.map((s) => ({ ...s }))],
	};

	let slice = base.slices.find((s) => s.context === ctx);
	if (!slice) {
		slice = {
			context: ctx,
			confirmations: 0,
			contradictions: 0,
			strength: 0.5,
			last_observed_at: at,
		};
		base.slices.push(slice);
	}

	if (event === "support") slice.confirmations++;
	else slice.contradictions++;
	const sliceTotal = slice.confirmations + slice.contradictions;
	slice.strength = sliceTotal > 0 ? slice.confirmations / sliceTotal : 0.5;
	// Keep the latest event time. Sessions can be replayed or imported out of
	// chronological order, and an older `at` must not drag an existing slice's
	// observation time backward — the newest-N pruning below would then drop a
	// genuinely recent context as if it were stale.
	slice.last_observed_at = Math.max(slice.last_observed_at, at);

	let slices = base.slices;
	let droppedConf = 0;
	let droppedContra = 0;
	if (slices.length > MAX_SUPPORT_SLICES) {
		slices = slices.sort((a, b) => b.last_observed_at - a.last_observed_at);
		const dropped = slices.slice(MAX_SUPPORT_SLICES);
		for (const d of dropped) {
			droppedConf += d.confirmations;
			droppedContra += d.contradictions;
		}
		slices = slices.slice(0, MAX_SUPPORT_SLICES);
	}

	let totalConf = droppedConf;
	let totalContra = droppedContra;
	for (const s of slices) {
		totalConf += s.confirmations;
		totalContra += s.contradictions;
	}
	const totalObs = totalConf + totalContra;
	const global_strength = totalObs > 0 ? totalConf / totalObs : 0.5;

	return { global_strength, total_observations: totalObs, slices };
}
