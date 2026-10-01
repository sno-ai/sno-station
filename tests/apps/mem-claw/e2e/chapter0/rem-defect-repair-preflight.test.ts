import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	createTestDb,
	createTestEmbedder,
	type TestDb,
} from "../../helpers/test-db.ts";

let database: TestDb;
let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	database = createTestDb();
});

afterEach(() => {
	database.cleanup();
});

describe("REM defect repair Chapter 0 local dependencies", () => {
	it("opens a real encrypted SQLite persona store", () => {
		const header = readFileSync(database.dbPath).subarray(0, 16).toString("utf8");
		expect(header).not.toBe("SQLite format 3\u0000");
		expect(database.runtime.db.prepare("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
	});

	it("loads the real local ONNX embedder and returns one finite vector", async () => {
		const vector = await embedder.embed(
			"The academic researcher moved the weekly laboratory review from Tuesday to Thursday.",
		);
		expect(vector).toHaveLength(1024);
		expect(vector.every(Number.isFinite)).toBe(true);
	});
});
