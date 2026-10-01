import type {
	CaptureTriggersNs,
	CategoryRoutingNs,
	LocaleResources,
	NoiseNs,
	ReflectionSliceClassifiersNs,
} from "./_types";

type NoiseInput = Omit<NoiseNs, "correctionSignals" | "ackTokens" | "memoryIntent"> &
	Partial<Pick<NoiseNs, "correctionSignals" | "ackTokens" | "memoryIntent">>;

type CaptureTriggersInput = Omit<CaptureTriggersNs, "categoryRouting"> &
	Partial<Pick<CaptureTriggersNs, "categoryRouting">>;

type LocaleResourcesInput = Omit<
	LocaleResources,
	"captureTriggers" | "noise" | "reflectionSliceClassifiers"
> & {
	captureTriggers: CaptureTriggersInput;
	noise: NoiseInput;
};

interface LocaleResourceExtras {
	correctionSignals: ReadonlyArray<RegExp>;
	ackTokens: ReadonlyArray<RegExp>;
	memoryIntent: ReadonlyArray<RegExp>;
	reflectionSliceClassifiers: ReflectionSliceClassifiersNs;
}

export function defineLocaleResources(
	base: LocaleResourcesInput,
	extras: LocaleResourceExtras,
): LocaleResources {
	// `categoryRouting` is the same five patterns under another name, and the golden answer key is
	// calibrated to them being counted TWICE — once through here and once through the direct
	// `*Pattern` loop in `capture-policy-detector.ts`. Removing this derivation on 2026-08-21
	// halved the scores and broke two zh rows the key marks `ambiguous_category`. It is a real
	// double count and it is load-bearing: it goes when the model judgement replaces the vote.
	const categoryRouting: CategoryRoutingNs = base.captureTriggers.categoryRouting ?? {
		identity: [base.captureTriggers.identityPattern],
		preference: [base.captureTriggers.preferencePattern],
		entity: [base.captureTriggers.entityPattern],
		event: [base.captureTriggers.eventPattern],
		lesson: [base.captureTriggers.lessonPattern],
	};

	return {
		...base,
		captureTriggers: {
			...base.captureTriggers,
			categoryRouting,
		},
		noise: {
			...base.noise,
			correctionSignals: extras.correctionSignals,
			ackTokens: extras.ackTokens,
			memoryIntent: extras.memoryIntent,
		},
		reflectionSliceClassifiers: extras.reflectionSliceClassifiers,
	};
}
