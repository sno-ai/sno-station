import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { observeAgentEvent, readAgentView, recordAgentHandoff } from "../../../packages/memory/config/agent-state.ts";

it.each(["worker.source@localhost", "worker.recover@localhost"])("retains the original work owner until release by %s and transfers only that item", async caller => {
	const home = await mkdtemp(join(tmpdir(), "sno-view-handoff-"));
	const previous = { profile: process.env.SNO_PROFILE_DIR, address: process.env.SNO_REACH_ADDR };
	const root = join(home, "reach");
	const source = "worker.source@localhost";
	const target = "worker.target@localhost";
	const options = { profileDir: home, reachRoot: root, reachProgram: resolve("apps/reach/lib/reach-agent-view") };
	process.env.SNO_PROFILE_DIR = home;
	try {
		for (const [address, session] of [[source, "source-session"], [target, "target-session"]]) {
			await mkdir(join(root, address, "new"), { recursive: true });
			await writeFile(join(root, address, "seat.json"), JSON.stringify({ runtime: "claude" }));
			process.env.SNO_REACH_ADDR = address;
			await observeAgentEvent("claude", "user-prompt-submit", { session_id: session, prompt: "Continue requested work" });
		}
		const card = (id: string, from: string, to: string, work: string, body: string) =>
			`From: Sender <${from}>\nTo: Receiver <${to}>\nDelivered-To: ${to}\nDate: Tue, 03 Nov 2026 00:00:00 +0000\nSubject: [DECISION] Work\nMessage-ID: <${id}@localhost>\nX-Type: decision\nX-Work: ${work}\n\n${body}\n`;
		await writeFile(join(root, source, "new", "original"), card("original", "lead.owner@localhost", source, "transfer-work", "Do the work"));
		await writeFile(join(root, source, "new", "unrelated"), card("unrelated", "lead.owner@localhost", source, "other-work", "Unrelated"));
		await writeFile(join(root, target, "new", "transfer"), card("transfer", caller, target, "transfer-work", "Continue original card <original@localhost>; remain paused until release."));
		let view = await readAgentView(options);
		expect(view.work).toHaveLength(2);
		expect(view.work.find(item => item.work === "transfer-work")).toMatchObject({ owner: source, handoff_to: target });
		expect(view.agents.find(row => row.reachAddress === source)?.subgroup).toBe("handing over");
		await expect(recordAgentHandoff(caller, target, "No original card was named", options)).rejects.toThrow("unique linked work card");
		await expect(recordAgentHandoff(caller, target, "Release <unrelated@localhost>", options)).rejects.toThrow("unique linked work card");
		expect((await readAgentView(options)).work.find(item => item.work === "transfer-work")?.owner).toBe(source);
		await recordAgentHandoff(caller, target, "Release original work card <transfer@localhost>. HANDOFF_RELEASED observed", options);
		view = await readAgentView(options);
		expect(view.work).toHaveLength(2);
		expect(view.work.find(item => item.work === "transfer-work")).toMatchObject({ owner: target, message_id: "<original@localhost>", state: "queued" });
		expect(view.work.find(item => item.work === "other-work")?.owner).toBe(source);
		expect(view.agents.find(row => row.reachAddress === target)?.work).toHaveLength(1);
		expect(view.agents.find(row => row.reachAddress === source)).toMatchObject({ group: "Working" });
		await rm(join(root, source, "new", "unrelated"));
		expect((await readAgentView(options)).agents.find(row => row.reachAddress === source)).toMatchObject({ group: "Finished", subgroup: "handed over" });
		process.env.SNO_REACH_ADDR = source;
		await observeAgentEvent("claude", "user-prompt-submit", { session_id: "source-session", prompt: "Start a new task" });
		expect((await readAgentView(options)).agents.find(row => row.reachAddress === source)).toMatchObject({ group: "Working" });
		await writeFile(join(root, target, "new", "second-transfer"), card("second-transfer", caller, target, "transfer-work", "Another transfer of <original@localhost>"));
		const ambiguous = await readAgentView(options);
		expect(ambiguous.work).toHaveLength(1);
		expect(ambiguous.work[0]?.owner).toBe("unknown");
		expect(ambiguous.errors.some(error => error.operation === "associate Reach handoff")).toBe(true);
	} finally {
		if (previous.profile === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previous.profile;
		if (previous.address === undefined) delete process.env.SNO_REACH_ADDR; else process.env.SNO_REACH_ADDR = previous.address;
		await rm(home, { recursive: true, force: true });
	}
});

it("records a release on the receiver's most recent primary session when /clear and a subagent left others on its address", async () => {
	const home = await mkdtemp(join(tmpdir(), "sno-view-handoff-sessions-"));
	const previous = { profile: process.env.SNO_PROFILE_DIR, address: process.env.SNO_REACH_ADDR };
	const root = join(home, "reach");
	const source = "worker.source@localhost";
	const target = "worker.target@localhost";
	const options = { profileDir: home, reachRoot: root, reachProgram: resolve("apps/reach/lib/reach-agent-view") };
	process.env.SNO_PROFILE_DIR = home;
	try {
		for (const address of [source, target]) await mkdir(join(root, address, "new"), { recursive: true });
		process.env.SNO_REACH_ADDR = source;
		await observeAgentEvent("claude", "user-prompt-submit", { session_id: "source-session", prompt: "Hand the work over" });
		process.env.SNO_REACH_ADDR = target;
		await observeAgentEvent("claude", "user-prompt-submit", { session_id: "before-clear", prompt: "Earlier work" });
		await new Promise(done => setTimeout(done, 20));
		await observeAgentEvent("claude", "user-prompt-submit", { session_id: "after-clear", prompt: "Continue the transferred work" });
		await observeAgentEvent("claude", "pre-tool-use", { session_id: "after-clear", agent_id: "child", tool_name: "Read" });
		const card = (id: string, from: string, to: string, body: string) =>
			`From: Sender <${from}>\nTo: Receiver <${to}>\nDelivered-To: ${to}\nDate: Tue, 03 Nov 2026 00:00:00 +0000\nSubject: [DECISION] Work\nMessage-ID: <${id}@localhost>\nX-Type: decision\nX-Work: transfer-work\n\n${body}\n`;
		await writeFile(join(root, source, "new", "original"), card("original", "lead.owner@localhost", source, "Do the work"));
		await writeFile(join(root, target, "new", "transfer"), card("transfer", source, target, "Continue original card <original@localhost>."));
		await recordAgentHandoff(source, target, "Release original work card <transfer@localhost>", options);
		const released = async (session: string) => (await readFile(join(home, "station/agents", `claude--${session}.jsonl`), "utf8")).includes("handoff-released");
		expect(await released("after-clear")).toBe(true);
		expect(await released("before-clear")).toBe(false);
		expect(await released("child")).toBe(false);
		expect((await readAgentView(options)).work.find(item => item.work === "transfer-work")).toMatchObject({ owner: target });
	} finally {
		if (previous.profile === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previous.profile;
		if (previous.address === undefined) delete process.env.SNO_REACH_ADDR; else process.env.SNO_REACH_ADDR = previous.address;
		await rm(home, { recursive: true, force: true });
	}
});
