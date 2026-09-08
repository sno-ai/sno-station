import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createCuid2,
	isCuid2,
} from "../../../../packages/common-core/src/id-utils.ts";
import {
	openEncryptedDb,
	runIntegrityCheck,
} from "../../../../packages/sno-station-core-crypto/src/db.ts";
import { WrongKeyError } from "../../../../packages/sno-station-core-crypto/src/errors.ts";
import { liveKeychain } from "../../../../packages/sno-station-core-crypto/src/keychain.ts";
import type { Dek } from "../../../../packages/sno-station-core-crypto/src/types.ts";
import {
	unwrapDek,
	type WrappedDek,
} from "../../../../packages/sno-station-core-crypto/src/wrap.ts";
import { makeTestEnv, type TestEnv } from "../_helpers.ts";

// Frozen before upgrading: regenerating this with new libraries loses the old-file proof.
const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/dependency-upgrade/old-state.json", import.meta.url),
		"utf8",
	),
) as {
	dekHex: string;
	passphrase: string;
	wrapped: WrappedDek;
	rows: Array<{ id: string; text: string; blobHex: string; json: string }>;
	files: Record<"plain" | "encrypted", { base64: string; sha256: string }>;
};

let env: TestEnv;
beforeEach(() => {
	env = makeTestEnv("dependency-upgrade", { provisionKey: false });
});
afterEach(() => {
	env.cleanup();
});

describe("persisted state from dependencies before the upgrade", () => {
	it("reads a missing native keychain entry and preserves the saved test key", () => {
		expect(liveKeychain.get()).toBeNull();
		try {
			liveKeychain.set(fixture.dekHex);
			expect(liveKeychain.get()).toBe(fixture.dekHex);
			liveKeychain.delete();
			expect(liveKeychain.get()).toBeNull();
			expect(() => liveKeychain.delete()).not.toThrow();
		} finally {
			liveKeychain.delete();
		}
	});

	it.each(["plain", "encrypted"] as const)(
		"reads, updates, and reopens the old %s database",
		async (kind) => {
			const bytes = Buffer.from(fixture.files[kind].base64, "base64");
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				fixture.files[kind].sha256,
			);
			const path = join(env.snoStationCoreConfigDir, `${kind}.db`);
			writeFileSync(path, bytes);
			const dek = await unwrapDek(
				fixture.wrapped,
				Buffer.from(fixture.passphrase),
			);
			expect(dek.toString("hex")).toBe(fixture.dekHex);
			const open = () =>
				kind === "plain"
					? new Database(path)
					: openEncryptedDb(path, dek as Dek);
			const expected = fixture.rows.map((row) => ({
				id: row.id,
				text: row.text,
				payload: Buffer.from(row.blobHex, "hex"),
				metadata: row.json,
			}));
			const firstRow = expected[0];
			const secondRow = expected[1];
			if (!firstRow || !secondRow || expected.length !== 2) {
				throw new Error(
					"Old-state fixture must contain exactly two saved records",
				);
			}
			const added = {
				id: createCuid2(),
				text: "Saved after upgrade",
				payload: Buffer.from([0, 255]),
				metadata: '{"updated":true}',
			};
			let db = open();
			try {
				expect(
					db.prepare("SELECT * FROM saved_records ORDER BY rowid").all(),
				).toEqual(expected);
				for (const row of expected) expect(isCuid2(row.id)).toBe(true);
				expect(isCuid2(added.id)).toBe(true);
				db.transaction(() => {
					db.prepare("UPDATE saved_records SET text = ? WHERE id = ?").run(
						"Updated old record",
						firstRow.id,
					);
					db.prepare(
						"INSERT INTO saved_records VALUES (@id, @text, @payload, @metadata)",
					).run(added);
				})();
				expect(() =>
					db.transaction(() => {
						db.prepare("DELETE FROM saved_records").run();
						throw new Error("rollback probe");
					})(),
				).toThrow("rollback probe");
			} finally {
				db.close();
			}
			db = open();
			try {
				expect(
					db.prepare("SELECT * FROM saved_records ORDER BY rowid").all(),
				).toEqual([
					{ ...firstRow, text: "Updated old record" },
					secondRow,
					added,
				]);
				expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
				if (kind === "encrypted")
					runIntegrityCheck(db as ReturnType<typeof openEncryptedDb>);
			} finally {
				db.close();
				dek.fill(0);
			}
			if (kind === "encrypted") {
				expect(
					readFileSync(path).includes(Buffer.from("Updated old record")),
				).toBe(false);
				const before = readFileSync(path);
				expect(() =>
					openEncryptedDb(path, Buffer.alloc(32, 0xff) as Dek),
				).toThrow(WrongKeyError);
				expect(readFileSync(path)).toEqual(before);
			}
		},
	);

	it("rejects an incorrect old password and an altered old authentication tag", async () => {
		await expect(
			unwrapDek(fixture.wrapped, Buffer.from("incorrect fixture password")),
		).rejects.toThrow(WrongKeyError);
		const tag = Buffer.from(fixture.wrapped.tag, "hex");
		const firstByte = tag[0];
		if (firstByte === undefined) {
			throw new Error("Old-state fixture must contain an authentication tag");
		}
		tag[0] = firstByte ^ 1;
		await expect(
			unwrapDek(
				{ ...fixture.wrapped, tag: tag.toString("hex") },
				Buffer.from(fixture.passphrase),
			),
		).rejects.toThrow(WrongKeyError);
		expect(isCuid2("invalid old identifier!")).toBe(false);
	});
});
