import { createHash } from "node:crypto";
import { writeJsonArtifact } from "./artifacts";
import { requestJson } from "./http";
import { getStringField, isRecord } from "./json";
import type { AgentRunState, TestConfig } from "./types";

type RemoteSnoIdentity = {
	machine_secret: string;
	machine_uuid: string;
	user_cuid: string;
};

export async function assertObserveProductionSpine(
	config: TestConfig,
	state: AgentRunState,
	identity: RemoteSnoIdentity,
) {
	const apiBaseUrl = `${config.observeBaseUrl}/api`;
	await assertRegisterMachine(config, identity);
	return {
		firstObserveEventId: state.observeFirstEventId,
		observeApiBaseUrl: apiBaseUrl,
		observeMachineUuid: identity.machine_uuid,
		observeUserCuid: identity.user_cuid,
	};
}

async function assertRegisterMachine(
	config: TestConfig,
	identity: RemoteSnoIdentity,
) {
	const url = `${config.observeBaseUrl}/api/v1/identity/register-machine`;
	const body = {
		machine_secret_hash: createHash("sha256")
			.update(identity.machine_secret)
			.digest("hex"),
		machine_uuid: identity.machine_uuid,
		user_cuid: identity.user_cuid,
	};
	await writeJsonArtifact(config, "observe-register-machine-request.json", {
		body,
		headers: { "Content-Type": "application/json" },
		method: "POST",
		url,
	});
	const response = await requestJson(url, {
		body,
		headers: { "Content-Type": "application/json" },
		method: "POST",
		timeoutMs: 30_000,
	});
	await writeJsonArtifact(config, "observe-register-machine-response.json", {
		body: response.body,
		headers: response.headers,
		statusCode: response.statusCode,
		text: response.text,
	});
	if (
		response.statusCode !== 200 ||
		getStringField(response.body, "user_cuid") !== identity.user_cuid ||
		getStringField(response.body, "machine_uuid") !== identity.machine_uuid ||
		!isRecord(response.body) ||
		typeof response.body.claimed !== "boolean"
	) {
		// Advisory because external production web availability does not prove mem-claw behavior.
		const responseText = JSON.stringify(response.text.slice(0, 300));
		console.warn(
			`observe register-machine advisory: url=${url} status=${response.statusCode} response=${responseText}`,
		);
	}
}
