// Dashboard Logger E2E — verifies the /custom/v1/log → ClickHouse → API path
//
// Gate: HELICONE_DASHBOARD_E2E=1 plus HELICONE_API_KEY and CF_ACCESS_CLIENT_ID_HELICONE.
// Without the gate, the suite is skipped.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const CUSTOM_LOG_ENDPOINT = "https://helicone.sno.ai/custom/v1/log";
const REQUEST_API_BASE = "https://helicone.snoai.com/v1/request";
const PROPAGATION_MS = 12_000;

function loadConfig() {
	const apiKey = process.env.HELICONE_API_KEY ?? "";
	const cfId = process.env.CF_ACCESS_CLIENT_ID_HELICONE ?? "";
	const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET_HELICONE ?? "";
	const enabled = process.env.HELICONE_DASHBOARD_E2E === "1";
	return { apiKey, cfId, cfSecret, enabled };
}

function skipIfNotEnabled(t) {
	const config = loadConfig();
	if (!config.enabled) {
		t.skip("HELICONE_DASHBOARD_E2E not set; skipping dashboard-logger E2E");
		return null;
	}
	if (!config.apiKey || !config.cfId || !config.cfSecret) {
		t.skip("Missing HELICONE_API_KEY or CF_ACCESS_CLIENT_* env vars");
		return null;
	}
	return config;
}

const EVENT_TYPES = [
	{ eventType: "session.start", lane: "memory" },
	{ eventType: "prompt.submit", lane: "memory" },
	{ eventType: "tool.call", lane: "memory" },
	{ eventType: "memory.write", lane: "memory" },
	{ eventType: "memory.read", lane: "memory" },
	{ eventType: "llm.call", lane: "llm" },
	{ eventType: "cost.summary", lane: "memory" },
	{ eventType: "memory.snapshot", lane: "memory" },
	{ eventType: "session.end", lane: "memory" },
	{ eventType: "error", lane: "memory" },
];

async function postCustomLog(config, eventId, eventType, lane, sessionUuid) {
	const nowIso = new Date().toISOString();
	const headers = {
		"Content-Type": "application/json",
		"Authorization": `Bearer ${config.apiKey}`,
		"Helicone-Request-Id": eventId,
		"Helicone-Property-EventType": eventType,
		"Helicone-Property-Lane": lane,
		"Helicone-Property-AgentId": "sno-mem-claw",
		"Helicone-Session-Id": sessionUuid,
		"CF-Access-Client-Id": config.cfId,
		"CF-Access-Client-Secret": config.cfSecret,
	};
	const body = JSON.stringify({
		providerRequest: {
			url: "custom/data",
			json: {
				_type: "data",
				name: `sno:${eventType}`,
				event_id: eventId,
				event_type: eventType,
				lane,
				agent_id: "sno-mem-claw",
				payload_bytes: Math.floor(Math.random() * 5000) + 100,
			},
			meta: {},
		},
		providerResponse: {
			json: {
				_type: "data",
				name: `sno:${eventType}`,
				status: "accepted",
				receipt_id: eventId,
			},
			status: 200,
			headers: {},
		},
		timing: {
			startTime: nowIso,
			endTime: nowIso,
		},
	});
	const res = await fetch(CUSTOM_LOG_ENDPOINT, { method: "POST", headers, body });
	return res.status;
}

async function fetchDashboardRequest(config, requestId) {
	const res = await fetch(`${REQUEST_API_BASE}/${requestId}`, {
		headers: { Authorization: `Bearer ${config.apiKey}` },
	});
	if (!res.ok) return null;
	const data = await res.json();
	return data?.data ?? null;
}

describe("dashboard-logger E2E — Helicone custom log path", () => {
	it("persists all 10 event types with correct properties and session grouping", async (t) => {
		const config = skipIfNotEnabled(t);
		if (!config) return;

		const sessionUuid = randomUUID();
		const events = EVENT_TYPES.map((spec) => ({
			...spec,
			eventId: randomUUID(),
		}));

		for (const event of events) {
			const status = await postCustomLog(
				config,
				event.eventId,
				event.eventType,
				event.lane,
				sessionUuid,
			);
			assert.equal(status, 200, `POST for ${event.eventType} should return 200`);
		}

		await delay(PROPAGATION_MS);

		for (const event of events) {
			const row = await fetchDashboardRequest(config, event.eventId);
			assert.ok(row, `${event.eventType} should exist in ClickHouse (id: ${event.eventId})`);
			assert.equal(row.request_id, event.eventId);
			assert.equal(row.provider, "CUSTOM");
			assert.equal(row.response_status, 200);

			const props = row.properties ?? {};
			assert.equal(props.eventtype, event.eventType, `${event.eventType}: eventtype property`);
			assert.equal(props.lane, event.lane, `${event.eventType}: lane property`);
			assert.equal(props.agentid, "sno-mem-claw", `${event.eventType}: agentid property`);
			assert.equal(
				props["Helicone-Session-Id"],
				sessionUuid,
				`${event.eventType}: session grouping`,
			);

			const bodyName = row.request_body?.name;
			assert.equal(bodyName, `sno:${event.eventType}`, `${event.eventType}: request body name`);
		}
	});

	it("does not persist transport credential material", async (t) => {
		const config = skipIfNotEnabled(t);
		if (!config) return;

		const eventId = randomUUID();
		const status = await postCustomLog(config, eventId, "session.start", "memory", randomUUID());
		assert.equal(status, 200);

		await delay(PROPAGATION_MS);

		const row = await fetchDashboardRequest(config, eventId);
		assert.ok(row, "credential-check event should exist");

		const serialized = JSON.stringify(row).toLowerCase();
		const secrets = [config.apiKey, config.cfId, config.cfSecret].filter(Boolean);
		for (const secret of secrets) {
			assert.ok(
				!serialized.includes(secret.toLowerCase()),
				`Response must not contain credential material: ${secret.slice(0, 10)}...`,
			);
		}
		assert.ok(!serialized.includes("cf-access-client-id"), "No CF Access ID key in stored data");
		assert.ok(!serialized.includes("cf-access-client-secret"), "No CF Access Secret key in stored data");
	});

	it("rejects requests with missing API key", async (t) => {
		const config = skipIfNotEnabled(t);
		if (!config) return;

		const res = await fetch(CUSTOM_LOG_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"CF-Access-Client-Id": config.cfId,
				"CF-Access-Client-Secret": config.cfSecret,
			},
			body: JSON.stringify({
				providerRequest: { url: "custom/data", json: { _type: "data" }, meta: {} },
				providerResponse: { json: {}, status: 200, headers: {} },
				timing: { startTime: new Date().toISOString(), endTime: new Date().toISOString() },
			}),
		});
		assert.ok(res.status >= 400, `Missing API key should return 4xx, got ${res.status}`);
	});
});
