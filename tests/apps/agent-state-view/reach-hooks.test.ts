import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sno-reach-hook-"));
	await mkdir(join(root, "reach"));
	await writeFile(join(root, "sno"), `#!/bin/sh
case "$2" in
	whoami) [ ! -e "$SNO_REACH_ROOT/no-seat" ] || exit 1
	        printf '%s\\n' 'coder.one@local';;
	pickup) [ "$SNO_REACH_ADDR" = 'coder.one@local' ] || exit 2
	        printf '%s\\n' 'Continue with this card.';;
	notify) case "$3" in
	          --dismiss-session) rm -f "$SNO_REACH_ROOT/approval.$4";;
	          --as) printf '%s\\n' "$*" > "$SNO_REACH_ROOT/approval.$8";;
	        esac;;
esac
`, { mode: 0o700 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(["claude", "codex"])("%s resolves and reuses the seat, picks up at stop, and sends and clears interactive approval", async harness => {
	const reach = join(root, "reach");
	const profile = join(root, "profile");
	const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, SNO_PROFILE_DIR: profile, SNO_REACH_ROOT: reach, SNO_REACH_ADDR: "" };
	const run = (event: string, input: Record<string, unknown> = {}, due = "") => {
		const result = spawnSync(process.execPath, [`apps/mem-${harness}/dist/cli.js`, event], {
			input: JSON.stringify({ session_id: "test-session", cwd: root, ...input }), env: { ...env, SNO_DUE_RUN: due }, encoding: "utf8", timeout: 5000,
		});
		expect(result.status, result.stderr).toBe(0);
		return result.stdout;
	};
	const receipt = join(reach, "approval.test-session");
	const approval = { tool_name: "Bash", tool_use_id: "toolu_original" };
	expect(run("permission-request", approval)).toBe("");
	await expect.poll(() => readFile(receipt, "utf8").catch(() => "")).toBe(
		`reach notify --as coder.one@local --type approval --session test-session --subject approval needed: Bash in ${root}\n`,
	);
	// A fresh process must still have the previous hook's resolved address.
	await writeFile(join(reach, "no-seat"), "");
	expect(run("stop")).toBe('{"decision":"block","reason":"Continue with this card."}\n');
	const records = (await readFile(join(profile, "station", "agents", `${harness}--test-session.jsonl`), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	expect(records.map(record => record.reachAddress)).toEqual(["coder.one@local", "coder.one@local"]);
	run("post-tool-use", { ...approval, tool_use_id: "toolu_other" });
	expect(await readFile(receipt, "utf8")).toContain("approval needed");
	run("post-tool-use", approval);
	await expect.poll(() => readFile(receipt, "utf8").catch(() => "")).toBe("");

	for (const event of ["interrupt", "approval-response"]) {
		run("permission-request", approval);
		await expect.poll(() => readFile(receipt, "utf8").catch(() => "")).toContain("approval needed");
		run(event);
		await expect.poll(() => readFile(receipt, "utf8").catch(() => "")).toBe("");
	}
	run("permission-request", approval, "1");
	run("permission-request", { tool_name: "AskUserQuestion" });
	expect(await readFile(receipt, "utf8").catch(() => "")).toBe("");
});
