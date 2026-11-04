import { expect, it } from "vitest";
import { type AgentRow, type AgentView, renderAgentScreen, screenAgents } from "../../../packages/memory/config/agent-state.ts";

const row = (index: number, group: AgentRow["group"], description: string): AgentRow => ({
	harness: index % 2 ? "codex" : "claude", sessionId: `session-${index}`, reachAddress: "unknown", cwd: `/home/dev/code/project-${index}`,
	description, doing: group === "Working" ? "working" : "idle at prompt", process: "present", resumable: "live",
	waitingForHuman: group === "Needs you" ? "yes" : "no", waitingReason: group === "Needs you" ? "permission to approve" : "unknown",
	group, subgroup: group === "Working" ? "working" : "unknown", lastEvent: { at: "2026-11-04T05:00:00Z", event: "stop", source: "file" },
	ageSeconds: index * 61, resultId: "unknown", humanSeen: "unknown", finalReply: "unknown",
	work: [{ message_id: "<card@host>", work: "w" }], delivery: "unknown", resumeEvidence: "unknown", missingReasons: [],
});

it("fits 80x24 with every Needs you row and the selected row visible, one line per agent", () => {
	const agents = [
		...[0, 1, 2].map(index => row(index, "Needs you", "修复登录跳转循环并补一个测试，然后把结果发给负责审查的助手")),
		...Array.from({ length: 27 }, (_, index) => row(index + 3, index < 10 ? "Working" : "Finished", `🚀 Ship task number ${index + 3} ✅ ${"🚀".repeat(40)}`)),
	];
	const view: AgentView = { observedAt: "2026-11-04T05:10:00Z", agents, work: [], quota: [], errors: [] };
	const width = (line: string): number => [...line].reduce((sum, char) => sum + (/[一-鿿＀-｠]/u.test(char) ? 2 : 1), 0);
	for (const selected of [0, 15, 29]) {
		const lines = renderAgentScreen(view, selected, { columns: 80, rows: 24 }).split("\n");
		expect(lines.length).toBeLessThanOrEqual(24);
		for (const line of lines) expect(width(line), line).toBeLessThanOrEqual(80);
		expect(lines.filter(line => line.includes("approve a permission"))).toHaveLength(3);
		expect(lines.find(line => line.startsWith(">"))).toContain(`project-${selected}`);
		expect(lines.join("\n")).not.toMatch(/[{}]/);
	}
});

it("keeps the selected row visible when Needs you alone fills the list, and shows an opened result whole", () => {
	const agents = [...Array.from({ length: 18 }, (_, index) => row(index, "Needs you", `Approve step ${index}`)), row(18, "Working", "Last task")];
	const view: AgentView = { observedAt: "2026-11-04T05:10:00Z", agents, work: [], quota: [], errors: [] };
	for (const selected of [17, 18]) {
		const lines = renderAgentScreen(view, selected, { columns: 80, rows: 24 }).split("\n");
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(lines.find(line => line.startsWith(">"))).toContain(`project-${selected}`);
	}
	const reply = `Result: ${"word ".repeat(40)}end-of-reply`;
	const lines = renderAgentScreen(view, 0, { columns: 40, rows: 24 }, reply).split("\n");
	expect(lines.length).toBeLessThanOrEqual(24);
	expect(lines.join(" ")).toContain("end-of-reply");
});

it("lists finished and unknown sessions from the last day only and says how many older ones are hidden", () => {
	const aged = (index: number, group: AgentRow["group"], ageSeconds: number | "unknown"): AgentRow => ({ ...row(index, group, `Task ${index}`), ageSeconds });
	const agents = [aged(0, "Needs you", 200_000), aged(1, "Working", 100_000), aged(2, "Finished", 3600), aged(3, "Finished", 90_000),
		aged(4, "unknown", 86_000), aged(5, "unknown", 400_000), aged(6, "unknown", "unknown")];
	const { view, hidden } = screenAgents({ observedAt: "2026-11-04T05:10:00Z", agents, work: [], quota: [], errors: [] });
	expect(view.agents.map(item => item.sessionId)).toEqual(["session-0", "session-1", "session-2", "session-4", "session-6"]);
	expect(hidden).toBe(2);
	const screen = renderAgentScreen(view, 0, { columns: 40, rows: 24 }, "", hidden);
	for (const line of screen.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
	expect(renderAgentScreen(view, 0, { columns: 80, rows: 24 }, "", hidden)).toContain("2 older finished or unknown sessions hidden");
});
