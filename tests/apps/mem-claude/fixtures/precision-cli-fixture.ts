/** Run the real agent CLI against a loopback service, recording its wire operations. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture";

const repository = resolve(import.meta.dirname, "../../../..");

export async function createPrecisionCliFixture(app: "claude" | "codex" | "cursor") {
	const root = await mkdtemp(join(tmpdir(), `mem-${app}-precision-cli-`));
	const profile = join(root, "profile");
	const home = join(root, "home");
	await mkdir(home);
	await writeFile(join(home, "settings.json"), "{}");
	writeSettingsFixture(profile, { mode: "local-first", rem: { tick: false } });
	const mutations: unknown[] = [];
	const inspections: unknown[] = [];
	const server = createServer(async (request, response) => {
		let text = "";
		for await (const chunk of request) text += chunk;
		response.setHeader("content-type", "application/json");
		if (request.url === "/healthz") {
			response.end(JSON.stringify({ status: "ok" }));
		} else if (request.url === "/v1/mutate") {
			const body = JSON.parse(text) as { op: unknown };
			mutations.push(body.op);
			response.end(JSON.stringify({ degraded: false, result: { isError: false,
				content: [{ type: "text", text: "restored-rule" }], details: { id: "restored-rule" } } }));
		} else if (request.url === "/v1/inspect") {
			const body = JSON.parse(text) as { op: unknown };
			inspections.push(body.op);
			response.end(JSON.stringify({ degraded: false, result: { op: "precision",
				nights: [
					{ jobId: "night-2026-11-15", scope: "project", checked: 12, replaced: 2, merged: 1, corrected: 3, removed: 1, undecided: 2, failures: [] },
					{ jobId: "night-2026-11-15", scope: "shared", checked: 8, replaced: 1, merged: 0, corrected: 2, removed: 1, undecided: 1, failures: [] },
					{ jobId: "night-2026-11-14", scope: "project", checked: 7, replaced: 1, merged: 2, corrected: 0, removed: 1, undecided: 1, failures: [] },
					{ jobId: "night-2026-11-14", scope: "shared", checked: 5, replaced: 0, merged: 1, corrected: 1, removed: 1, undecided: 0, failures: [] },
					{ jobId: "night-2026-11-13", scope: "project", checked: 6, replaced: 2, merged: 0, corrected: 1, removed: 0, undecided: 1, failures: [] },
					{ jobId: "night-2026-11-13", scope: "shared", checked: 4, replaced: 0, merged: 0, corrected: 1, removed: 1, undecided: 1, failures: [] },
				],
				pending: { project: ["pending-project"], shared: ["pending-shared"] },
				notFit: { project: 2, shared: 3 },
				contradictions: [{ id: "conflicting-rule", filePath: "/workspace/release/CLAUDE.md" }],
				lines: [
					"project 2026-11-15: checked 12, replaced 2, merged 1, corrected 3, removed 1, undecided 2",
					"shared 2026-11-15: checked 8, replaced 1, merged 0, corrected 2, removed 1, undecided 1",
					"project 2026-11-14: checked 7, replaced 1, merged 2, corrected 0, removed 1, undecided 1",
					"shared 2026-11-14: checked 5, replaced 0, merged 1, corrected 1, removed 1, undecided 0",
					"project 2026-11-13: checked 6, replaced 2, merged 0, corrected 1, removed 0, undecided 1",
					"shared 2026-11-13: checked 4, replaced 0, merged 0, corrected 1, removed 1, undecided 1",
				],
			} }));
		} else {
			response.writeHead(404);
			response.end(JSON.stringify({ reason: "engine-failed", error: "unexpected fixture request" }));
		}
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing fixture service port");
	await mkdir(join(profile, "station"));
	await writeFile(join(profile, "station", "sidecar.json"), JSON.stringify({
		pid: process.pid, port: address.port, token: "0".repeat(64),
	}));
	return {
		home, mutations, inspections,
		run(args: string[]) {
			return new Promise<{ code: string | number | null | undefined; stdout: string; stderr: string }>(done => {
				execFile(process.execPath, ["--import", "tsx", `apps/mem-${app}/src/cli.ts`, ...args], {
					cwd: repository, encoding: "utf8", timeout: 20_000,
					env: { ...process.env, SNO_PROFILE_DIR: profile, HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home },
				}, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr }));
			});
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>(done => server.close(() => done()));
			await rm(root, { recursive: true, force: true });
		},
	};
}
