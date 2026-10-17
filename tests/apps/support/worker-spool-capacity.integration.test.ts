import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { connect, type MemoryClient } from "@snoai/memory/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as claude from "../../../apps/mem-claude/src/worker";
import * as codex from "../../../apps/mem-codex/src/worker";
import * as cursor from "../../../apps/mem-cursor/src/worker";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";
import { LOCAL_EMBEDDING_CACHE_DIR_DEFAULT } from "../../../packages/embedder/src/constants.ts";

let root: string | undefined;
let client: MemoryClient | undefined;
afterEach(async () => {
	if (client) {
		try { process.kill(client.pid, "SIGTERM"); } catch { /* already stopped */ }
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try { process.kill(client.pid, 0); } catch { break; }
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		client = undefined;
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe.each([["claude", claude], ["codex", codex], ["cursor", cursor]] as const)(
	"%s pending spool capacity", (skin, worker) => {
		async function setup(count: number): Promise<string> {
			root = await mkdtemp(join(tmpdir(), "worker-spool-capacity-"));
			vi.stubEnv("SNO_PROFILE_DIR", root);
			const directory = join(root, `sno-mem-${skin}`, "spool");
			await mkdir(directory, { recursive: true });
			for (let index = count - 1; index >= 0; index--) {
				await writeFile(join(directory, `${String(index).padStart(16, "0")}-turn.json`), JSON.stringify({
					sessionId: "capacity-session", turnId: `turn-${index}`, project: root, childCwd: root,
					user: "The project release label is Indigo.", assistant: "Recorded.",
					at: index, attempts: 0, state: "pending",
				}));
			}
			await writeFile(join(directory, "worker-note.txt"), "Keep this non-record file.");
			return directory;
		}

		it("keeps the newest thousand pending records and logs one removal", async () => {
			const directory = await setup(1002);
			const logged = vi.spyOn(console, "log").mockImplementation(() => {});
			expect(await worker.hasActionableSpool()).toBe(true);
			const names = (await readdir(directory)).sort();
			expect(names).toHaveLength(1001);
			expect(names[0]).toBe("0000000000000002-turn.json");
			expect(names.at(-2)).toBe("0000000000001001-turn.json");
			expect(names.at(-1)).toBe("worker-note.txt");
			expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
				{ event: "spool-pruned", removed: 2, remaining: 1000, reason: "capacity" },
			]);
			expect(await worker.hasActionableSpool()).toBe(true);
			expect(logged.mock.calls).toHaveLength(1);
		});

		it("prunes before connecting even when the memory service is unavailable", async () => {
			const directory = await setup(1002);
			const logged = vi.spyOn(console, "log").mockImplementation(() => {});
			await expect(worker.runWorker({
				async connect() { throw new Error("memory service unavailable"); },
				async runChild() { throw new Error("must not start a model"); },
			})).rejects.toThrow("memory service unavailable");
			const names = (await readdir(directory)).sort();
			expect(names).toHaveLength(1001);
			expect(names[0]).toBe("0000000000000002-turn.json");
			expect(names.at(-2)).toBe("0000000000001001-turn.json");
			expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
				{ event: "spool-pruned", removed: 2, remaining: 1000, reason: "capacity" },
			]);
			expect((await readdir(join(directory, ".."))).includes("worker.lock")).toBe(false);
		});

		it("leaves a spool at capacity intact", async () => {
			const directory = await setup(1000);
			const logged = vi.spyOn(console, "log").mockImplementation(() => {});
			expect(await worker.hasActionableSpool()).toBe(true);
			const names = (await readdir(directory)).sort();
			expect(names).toHaveLength(1001);
			expect(names[0]).toBe("0000000000000000-turn.json");
			expect(names.at(-2)).toBe("0000000000000999-turn.json");
			expect(logged.mock.calls).toEqual([]);
		});

		it("prunes records arriving during a capture before processing the next turn", async () => {
			const directory = await setup(1);
			if (!root) throw new Error("missing profile");
			vi.stubEnv("HOME", join(root, "home"));
			writeSettingsFixture(root, { mode: "local-first", capture: { ambient: false }, rem: { tick: false },
				embedding: { cacheDir: LOCAL_EMBEDDING_CACHE_DIR_DEFAULT },
				rerank: { mode: "none" }, telemetry: { observe: { enabled: false }, memoryUsage: { enabled: false } } });
			const connected = await connect({ skinId: skin });
			if (connected.degraded) throw new Error(connected.error ?? connected.reason);
			client = connected;
			const clock = Date.now();
			const captured: string[] = [];
			const originalCapture = connected.capture.bind(connected);
			connected.capture = async (turn, scope) => {
				const result = await originalCapture(turn, scope);
				captured.push(turn.turnId);
				for (let index = 1; index <= 1001; index++) {
					await writeFile(join(directory, `${String(index).padStart(16, "0")}-turn.json`), JSON.stringify({
						sessionId: "capacity-session", turnId: `turn-${index}`, project: root, childCwd: root,
						user: "The project release label is Indigo.", assistant: "Recorded.",
						at: index, attempts: 0, state: "pending", retryAt: clock + 540_000,
					}));
				}
				return result;
			};
			const logged = vi.spyOn(console, "log").mockImplementation(() => {});
			expect(await worker.runWorker({
				async connect() { return connected; }, now: () => clock,
				async runChild() { throw new Error("disabled capture must not start a model"); },
				async sleep() {
					const names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
					expect(names).toHaveLength(1000);
					expect(names[0]).toBe("0000000000000002-turn.json");
					expect(names.at(-1)).toBe("0000000000001001-turn.json");
					// End the fixture after observing the next real scan; no need to capture a thousand turns.
					for (const name of names) await rm(join(directory, name));
				},
			})).toBe("drained");
			expect(captured).toEqual(["turn-0"]);
			expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))
				.filter(event => event.event === "spool-pruned")).toEqual([
				{ event: "spool-pruned", removed: 1, remaining: 1000, reason: "capacity" },
			]);
		}, 30_000);
	},
);
