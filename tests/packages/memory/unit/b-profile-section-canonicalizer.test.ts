import { describe, expect, it } from "vitest";
import { canonicalizeProfileSectionName } from "../../../../packages/sno-station-mem/src/engine/extraction/b-profile-section-canonicalizer";

const SEPARATOR_PAIRS = [
	["reading-interests", "reading_interests"],
	["movie-genres", "movie_genres"],
	["film-directors", "film_directors"],
	["ai-ethics", "ai_ethics"],
	["work-style", "work_style"],
	["travel-climate", "travel_climate"],
	["movie-actors", "movie_actors"],
	["renewable-energy", "renewable_energy"],
] as const;

const DOMAIN_PAIRS = [
	["interests.reading", "preferences.reading"],
	["goals.fitness", "preferences.fitness"],
	["interests.science", "preferences.science"],
	["interests.history", "preferences.history"],
	["work.productivity", "preferences.productivity"],
	["goals.travel", "preferences.travel"],
	["interests.movies", "preferences.movies"],
	["work.career", "preferences.career"],
	["goals.learning", "preferences.learning"],
	["interests.renewable_energy", "preferences.renewable_energy"],
] as const;

const OPEN_TOPICS = [
	"preferences.coffee_budget",
	"preferences.dinner_budget",
	"preferences.lunch_budget",
	"preferences.grocery_budget",
	"preferences.quantum_computing",
	"preferences.coffee_habit",
] as const;

describe("canonicalizeProfileSectionName", () => {
	it.each(SEPARATOR_PAIRS)("converges measured separator twins %s and %s", (left, right) => {
		expect(canonicalizeProfileSectionName(left)).toBe(canonicalizeProfileSectionName(right));
	});

	it.each(DOMAIN_PAIRS)("pins measured domain twins %s and %s", (left, right) => {
		expect(canonicalizeProfileSectionName(left)).toBe(right);
		expect(canonicalizeProfileSectionName(right)).toBe(right);
	});

	it.each(OPEN_TOPICS)("preserves the specific open topic %s", (topic) => {
		expect(canonicalizeProfileSectionName(topic)).toBe(topic);
	});

	it("normalizes NFKC, mixed case, and separator runs deterministically", () => {
		expect(canonicalizeProfileSectionName("  ＩＮＴＥＲＥＳＴＳ．Movie -  Genres__ ")).toBe(
			"preferences.movie_genres",
		);
	});

	it.each(["", " \t ", "---___", ".", ".topic", "topic.", "topic..detail"])(
		"accepts unusable input as the reserved general key",
		(input) => {
			expect(canonicalizeProfileSectionName(input)).toBe("preferences.general");
		},
	);

	it("is idempotent across measured and open keys", () => {
		const corpus = [...SEPARATOR_PAIRS.flat(), ...DOMAIN_PAIRS.flat(), ...OPEN_TOPICS];
		for (const key of corpus) {
			const once = canonicalizeProfileSectionName(key);
			expect(canonicalizeProfileSectionName(once)).toBe(once);
		}
	});
});
