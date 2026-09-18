/** @file atomic-attribute-cardinality.ts
 * @purpose Reads atomic attribute cardinality and family rulings from the shipped dictionaries.
 * @boundary Mechanical config lookup only; no storage access or model judgment.
 */

import { z } from "zod";
import attributeDictionary from "../../config/attribute-dictionary.json" with { type: "json" };
import stateVocabulary from "../../config/state-vocabulary.json" with { type: "json" };

const attributeConfigSchema = z.object({
	slugs: z.array(
		z.object({
			slug: z.string(),
			family: z.string().optional(),
			cardinality: z.enum(["one", "many"]).optional(),
		}),
	),
});

const attributeRulings = [
	...attributeConfigSchema.parse(attributeDictionary).slugs,
	...attributeConfigSchema.parse(stateVocabulary).slugs,
];
const oneCardinalityAttributes = new Set(
	attributeRulings
		.filter((entry) => entry.cardinality === "one")
		.map((entry) => entry.slug),
);
const attributeFamilyBySlug = new Map(
	attributeRulings.map((entry) => [entry.slug, entry.family ?? entry.slug.split(".", 1)[0]]),
);
const knownAttributes = new Set(attributeRulings.map((entry) => entry.slug));

export function isOneCardinalityAttribute(attribute: string | null): boolean {
	return attribute !== null && oneCardinalityAttributes.has(attribute);
}

export function atomicAttributeFamily(attribute: string | null): string | undefined {
	return attribute === null ? undefined : attributeFamilyBySlug.get(attribute);
}

/** True when the slug exists in either dictionary, whatever subject kind it is allowed on. */
export function isKnownAtomicAttribute(attribute: string): boolean {
	return knownAttributes.has(attribute);
}
