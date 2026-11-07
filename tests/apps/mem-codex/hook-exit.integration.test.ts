import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repo = resolve(import.meta.dirname, "../../..");

it.each(["user-prompt-submit", "post-tool-use"].flatMap(command => [
	{ command, stalled: true }, { command, stalled: false },
]))("$command finishes with stalled=$stalled", async ({ command, stalled }) => {
	const profile = mkdtempSync(join(tmpdir(), "codex-hook-exit-"));
	writeSettingsFixture(profile, stalled ? { recall: { prompt: { timeoutMs: 200 } } } : {});
	let received = false;
	let reply: ReturnType<typeof setTimeout> | undefined;
	const server = createServer((request, response) => {
		request.resume();
		if (request.url === "/healthz") response.end(JSON.stringify({ status: "ok" }));
		else if (request.url === "/v1/get-recall") response.end(JSON.stringify({
			degraded: false, recallId: "recalled", contextText: "The release decision was recalled.",
		}));
		else {
			received = true;
			// A healthy response may take longer than the old four-second deadline.
			if (!stalled) reply = setTimeout(() => response.end(JSON.stringify({ degraded: false, accepted: true })), 4_500);
		}
	});
	try {
		await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing listening port");
		mkdirSync(join(profile, "station"));
		writeFileSync(join(profile, "station", "sidecar.json"), JSON.stringify({
			pid: process.pid, port: address.port, token: "0".repeat(64),
		}));
		const result = await new Promise<{ code: number | string | null | undefined; output: string; error: string }>(done => {
			const child = execFile(process.execPath, [join(repo, "apps/mem-codex/dist/cli.js"), command], {
				timeout: stalled ? 2_000 : 8_000, env: { ...process.env, SNO_PROFILE_DIR: profile, SNO_CAPTURE_SCRIPTED: "1" },
			}, (error, output, stderr) => done({ code: error ? error.code : 0, output, error: stderr }));
			child.stdin?.end(JSON.stringify({ session_id: "timeout-regression", cwd: repo,
				turn_id: "turn", prompt: "Find the current release decision", tool_use_id: "read",
				tool_name: "Read", tool_input: {}, tool_response: "file contents" }));
		});
		expect(received, result.error).toBe(true);
		if (stalled) expect(result.error).toContain('"reason":"timeout"');
		else expect(result.error).not.toContain('"reason":"timeout"');
		expect(result.code, result.error).toBe(0);
		if (command === "user-prompt-submit") {
			expect(JSON.parse(result.output).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
			if (!stalled) expect(result.output).toContain("The release decision was recalled.");
		}
	} finally {
		clearTimeout(reply);
		server.closeAllConnections();
		await new Promise<void>(done => server.close(() => done()));
		rmSync(profile, { recursive: true, force: true });
	}
}, 10_000);
