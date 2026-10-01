import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type RemUpdateLocale } from "../../../../packages/memory/src/engine/rem/index.ts";

const source = "Lives in San Diego. Moved from San Francisco in 2024.";

/** The value-swap row every activation proof seeds. The span/relation fields this fixture
 * used to carry were deleted on 2026-08-21 with the offset machinery they described; the
 * three text fields below are all any consumer reads. */
export const SHARED_TOKEN_VALUE_SWAP_FIXTURE: {
	current: string;
	from: string;
	source: string;
	to: string;
} = {
	current: "Lives in San Diego.",
	from: "San Francisco",
	source,
	to: "San Diego",
};
