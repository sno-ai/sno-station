import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { runCase, remote, profile } from "./run-parity-01-explicit-remember-e2e.mjs";

// 70-consent-off.e2e.test.ts: Observe consent off must not disable local memory.
// The source journey asserts a nonempty teach reply and a stored nonce; it has no recall turn.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runCase(async ({ turn, waitRows }) => {
		const consentOffNonce = randomUUID();
		// Match setObserveConsent: an external consent response is advisory.
		// Read the profile identity and the observe address (settings.json, as sno-observe does)
		// remotely so the machine secret stays on its host.
		const consent = JSON.parse(remote(`node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const identity = JSON.parse(readFileSync("${profile}/identity.json", "utf8"));
const settings = JSON.parse(readFileSync("${profile}/settings.json", "utf8"));
const url = (settings.telemetry?.observe?.baseUrl ?? "https://www.sno.ai").replace(/\\/$/, "") + "/api/v1/consent";
const response = await fetch(url, {
	method: "POST",
	headers: {
		Authorization: "Bearer " + identity.machine_secret,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		lane: "memory",
		level: "off",
		machine_uuid: identity.machine_uuid,
		reason: "agent_e2e_off",
	}),
	signal: AbortSignal.timeout(30_000),
});
const text = await response.text();
let body;
try { body = JSON.parse(text); } catch { body = null; }
console.log(JSON.stringify({ url, statusCode: response.status, body, text }));
JS`, 40_000));
		if (consent.statusCode < 200 || consent.statusCode >= 300 ||
			consent.body?.level !== "off" || !Number.isInteger(consent.body?.written) ||
			consent.body.written < 0) {
			console.warn(`Sno consent write advisory: ${consent.url} HTTP ${consent.statusCode}: ${consent.text.slice(0, 300)}`);
		}

		const marker = `Project ConsentGuard ${consentOffNonce} uses release marker ${consentOffNonce} and owner Priya Shah.`;
		const response = turn(`Please remember this project handoff detail for future sessions: ${marker}`);
		assert.ok(response.length > 0);
		const stored = await waitRows(
			rows => rows.some(row => row.text.includes(consentOffNonce)),
			"local memory row written while Observe consent is off",
			Number(process.env.SNO_AGENT_E2E_MEMORY_TIMEOUT_MS ?? 60_000),
		);
		const rows = stored.filter(row => row.text.includes(consentOffNonce));
		const localOffMemory = { count: rows.length, rows };
		console.log(JSON.stringify({ artifact: "memory-evidence-consent-off.json", ...localOffMemory }));
		assert.ok(localOffMemory.count > 0);
	});
}
