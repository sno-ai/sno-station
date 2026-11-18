import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readAgentView } from "../../../packages/memory/config/agent-state.ts";

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

it("reads Hermes native callback observations through the shared TypeScript reader", async () => {
	const home = await mkdtemp(join(tmpdir(), "sno-state-hermes-"));
	homes.push(home);
	const written = spawnSync("python3", ["-c", `
import os, runpy, sys
suite = runpy.run_path("tests/apps/agent-state-view/codex-hermes-test.py")
test = suite["HermesObservationTest"]()
test.setUp()
try:
    os.environ["SNO_PROFILE_DIR"] = sys.argv[1]
    provider = test.module.SnoMemoryProvider()
    provider._session_id = "native/one"
    provider._primary = True
    provider.on_turn_start(1, "Inspect this")
    provider.on_session_end([{"role": "assistant", "content": "Proceed？"}])
finally:
    test.tearDown()
`, home], { encoding: "utf8", timeout: 10_000 });
	expect(written.error, written.stderr).toBeUndefined();
	expect(written.status, written.stderr).toBe(0);
	const reachRoot = join(home, "reach");
	await mkdir(reachRoot);
	const view = await readAgentView({ profileDir: home, reachRoot,
		reachProgram: join(process.cwd(), "apps/reach/lib/reach-agent-view") });
	expect(view.errors).toEqual([]);
	expect(view.agents).toHaveLength(1);
	expect(view.agents[0]).toMatchObject({
		harness: "hermes", sessionId: "native/one", doing: "idle at prompt",
		waitingForHuman: "yes", waitingReason: "asked a question", group: "Needs you", finalReply: "Proceed？",
	});
});
