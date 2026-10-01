/**
 * The facet a row carries — whether it is the current value or one that has been superseded.
 *
 * There is deliberately NO function here that reads the user's question and picks one. Whether a
 * question needs a retired value is a question of meaning, and this repo's law is that keyword
 * rules filter while models score. `resolveRemFacetPolicy` used to answer it from three regexes:
 * measured 2026-08-19, that sent 372 of 540 real benchmark questions down the current-only path,
 * and 6 of 8 plausible "what did I used to..." probes had their history hidden because only the
 * literal phrase "used to" was listed. The option survives on `SearchOptions` for a caller that
 * knows what it wants; nothing derives it from query text.
 */
export type RemFacetPolicy = "current-only" | "include-history";
