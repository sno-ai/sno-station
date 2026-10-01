import { createHash } from "node:crypto";

import { buildRemUpdateReferenceSet, type RemUpdateReferenceUnit } from "./update-rewrite.js";

export type RemCoverageAtom = Pick<
	RemUpdateReferenceUnit,
	"atomId" | "kind" | "sourceTextSha256" | "startByte" | "endByte" | "text"
>;

export type RemCoverageBuildResult =
	| { outcome: "accept"; atoms: RemCoverageAtom[] }
	| { outcome: "refuse"; reason: "empty_reference_set" | "unsegmentable_reference_set" };

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function buildRemCoverageAtoms(input: {
	source: string;
	format: "structured" | "prose" | "flattened-clauses";
}): RemCoverageBuildResult {
	if (input.source.trim().length === 0) return { outcome: "refuse", reason: "empty_reference_set" };
	if (input.format === "flattened-clauses") {
		return { outcome: "refuse", reason: "unsegmentable_reference_set" };
	}
	if (input.format === "prose") {
		const atoms = buildRemUpdateReferenceSet({ source: input.source, tier: "prose", locale: "en" });
		return atoms.length === 0
			? { outcome: "refuse", reason: "empty_reference_set" }
			: { outcome: "accept", atoms: atoms.map(selectCoverageFields) };
	}
	return buildStructuredAtoms(input.source);
}

export interface RemClauseCoverageGateResult {
	decision: "allow" | "refuse";
	reason: string | null;
	arms: Record<string, "pass" | "fail" | "owner-unset">;
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export async function validateRemClauseCoverageArtifacts(input: {
	accuracyFloor: number | null;
	measuredAccuracy: number | null;
	expectedGoldSetSha256: string;
	measuredGoldSetSha256: string;
	confidenceSatisfied: boolean;
	declarationSequence: number;
	firstScoredSequence: number;
	measurementPresent: boolean;
	artifactDigestMatches: boolean;
}): Promise<RemClauseCoverageGateResult> {
	const arms: RemClauseCoverageGateResult["arms"] = {
		goldSet: input.expectedGoldSetSha256 === input.measuredGoldSetSha256 ? "pass" : "fail",
		confidence: input.confidenceSatisfied ? "pass" : "fail",
		chronology: input.declarationSequence < input.firstScoredSequence ? "pass" : "fail",
		measurement: input.measurementPresent ? "pass" : "fail",
		artifactDigest: input.artifactDigestMatches ? "pass" : "fail",
		accuracyFloor:
			input.accuracyFloor === null
				? "owner-unset"
				: input.measuredAccuracy !== null && input.measuredAccuracy >= input.accuracyFloor
					? "pass"
					: "fail",
	};
	if (input.accuracyFloor === null) {
		return { decision: "refuse", reason: "coverage.accuracyFloor", arms };
	}
	if (input.measuredAccuracy === null) {
		return { decision: "refuse", reason: "coverage.measurementMissing", arms };
	}
	for (const [arm, status] of Object.entries(arms)) {
		if (status === "fail") return { decision: "refuse", reason: `coverage.${arm}`, arms };
	}
	return { decision: "allow", reason: null, arms };
}

function buildStructuredAtoms(source: string): RemCoverageBuildResult {
	let decoded: unknown;
	try {
		decoded = JSON.parse(source);
	} catch {
		return { outcome: "refuse", reason: "unsegmentable_reference_set" };
	}
	if (decoded === null || typeof decoded !== "object") {
		return { outcome: "refuse", reason: "unsegmentable_reference_set" };
	}
	const descriptors: Array<{ id: string; kind: RemCoverageAtom["kind"]; needle: string }> = [];
	collectStructuredLeaves(decoded, "", undefined, descriptors);
	let cursor = 0;
	const digest = createHash("sha256").update(source).digest("hex");
	const atoms = descriptors.flatMap<RemCoverageAtom>((descriptor) => {
		let start = source.indexOf(descriptor.needle, cursor);
		if (start < 0) start = source.indexOf(descriptor.needle);
		if (start < 0) return [];
		const end = start + descriptor.needle.length;
		cursor = end;
		return [{
			atomId: `atom:${descriptor.id}`,
			kind: descriptor.kind,
			sourceTextSha256: digest,
			startByte: Buffer.byteLength(source.slice(0, start)),
			endByte: Buffer.byteLength(source.slice(0, end)),
			text: source.slice(start, end),
		}];
	});
	return atoms.length === descriptors.length && atoms.length > 0
		? { outcome: "accept", atoms }
		: { outcome: "refuse", reason: "unsegmentable_reference_set" };
}

function collectStructuredLeaves(
	value: unknown,
	pointer: string,
	objectKey: string | undefined,
	output: Array<{ id: string; kind: RemCoverageAtom["kind"]; needle: string }>,
): void {
	if (Array.isArray(value)) {
		value.forEach((member, index) => {
			const memberPointer = `${pointer}/${index}`;
			if (member !== null && typeof member === "object") {
				collectStructuredLeaves(member, memberPointer, undefined, output);
			} else {
				output.push({ id: memberPointer, kind: "structured-member", needle: JSON.stringify(member) });
			}
		});
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, field] of Object.entries(value)) {
			collectStructuredLeaves(field, `${pointer}/${escapeJsonPointer(key)}`, key, output);
		}
		return;
	}
	if (objectKey !== undefined) {
		output.push({
			id: pointer,
			kind: "structured-field",
			needle: `${JSON.stringify(objectKey)}:${JSON.stringify(value)}`,
		});
	}
}

function selectCoverageFields(unit: RemUpdateReferenceUnit): RemCoverageAtom {
	return {
		atomId: unit.atomId,
		kind: unit.kind,
		sourceTextSha256: unit.sourceTextSha256,
		startByte: unit.startByte,
		endByte: unit.endByte,
		text: unit.text,
	};
}

function escapeJsonPointer(value: string): string {
	return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
