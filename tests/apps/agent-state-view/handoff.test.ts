import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { observeAgentEvent, readAgentView, recordAgentHandoff } from "../../../packages/memory/config/agent-state.ts";

it("retains the original work owner until the matching release and transfers only that item", async () => {
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
		await writeFile(join(root, target, "new", "transfer"), card("transfer", source, target, "transfer-work", "Continue original card <original@localhost>; remain paused until release."));
		let view = await readAgentView(options);
		expect(view.work).toHaveLength(2);
		expect(view.work.find(item => item.work === "transfer-work")).toMatchObject({ owner: source, handoff_to: target });
		expect(view.agents.find(row => row.reachAddress === source)?.subgroup).toBe("handing over");
		await expect(recordAgentHandoff(source, target, "No original card was named", options)).rejects.toThrow("unique linked work card");
		await expect(recordAgentHandoff(source, target, "Release <unrelated@localhost>", options)).rejects.toThrow("unique linked work card");
		expect((await readAgentView(options)).work.find(item => item.work === "transfer-work")?.owner).toBe(source);
		await recordAgentHandoff(source, target, "Release original work card <transfer@localhost>. HANDOFF_RELEASED observed", options);
		view = await readAgentView(options);
		expect(view.work).toHaveLength(2);
		expect(view.work.find(item => item.work === "transfer-work")).toMatchObject({ owner: target, message_id: "<original@localhost>", state: "queued" });
		expect(view.work.find(item => item.work === "other-work")?.owner).toBe(source);
		expect(view.agents.find(row => row.reachAddress === target)?.work).toHaveLength(1);
		expect(view.agents.find(row => row.reachAddress === source)).toMatchObject({ group: "Working" });
		await rm(join(root, source, "new", "unrelated"));
		expect((await readAgentView(options)).agents.find(row => row.reachAddress === source)).toMatchObject({ group: "Finished", subgroup: "handed over" });
		await writeFile(join(root, target, "new", "second-transfer"), card("second-transfer", source, target, "transfer-work", "Another transfer of <original@localhost>"));
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
