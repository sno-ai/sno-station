import { isLowercaseCanonicalUUIDv7 } from "../../../../../packages/common-core/src/index.ts";
import { redactIdentity, writeArtifact, writeJsonArtifact } from "./artifacts";
import { readObserveActivity } from "./observe-api";
import {
	collectRunEventSummaries,
	findIncompleteActivityEvidence,
} from "./observe-evidence";
import { readRemoteSnoIdentity } from "./remote-evidence";
import {
	type AgentRunState,
	type EventCriteria,
	type EventSummary,
	type ExpectedEventType,
	expectedEventTypes,
	NonRetryableEvidenceError,
	type TestConfig,
} from "./types";
import { sleep, waitForEvidence } from "./wait";

export async function readObserveSummaries(
	config: TestConfig,
	state: AgentRunState,
	options: {
		artifactName: string;
		sessionUuids?: Set<string>;
	},
): Promise<EventSummary[]> {
	const identity = await readObserveIdentity(config);
	const criteria: EventCriteria = {
		machineUuid: identity.machine_uuid,
		sdkUserCuid: identity.user_cuid,
		sessionUuids: options.sessionUuids,
	};
	const activity = await readObserveActivity(
		config,
		identity.machine_secret,
		state.startedAt,
	);
	await writeJsonArtifact(
		config,
		`${options.artifactName}-settled-activity.json`,
		activity.body,
	);
	const summaries = collectRunEventSummaries(activity.body, criteria);
	await writeJsonArtifact(
		config,
		`${options.artifactName}-settled-events.json`,
		summaries,
	);
	return summaries;
}

export async function waitForObserveSummaries(
	config: TestConfig,
	state: AgentRunState,
	options: {
		artifactName: string;
		label: string;
		matches: (summaries: EventSummary[]) => boolean;
		sessionUuids?: Set<string>;
	},
): Promise<EventSummary[]> {
	const identity = await readObserveIdentity(config);
	const criteria: EventCriteria = {
		machineUuid: identity.machine_uuid,
		sdkUserCuid: identity.user_cuid,
		sessionUuids: options.sessionUuids,
	};
	const eventTypes = new Set(expectedEventTypes);
	const deadline = Date.now() + config.observeTimeoutMs;
	let latestActivity: unknown;
	let latestSummaries: EventSummary[] = [];
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			const activity = await readObserveActivity(
				config,
				identity.machine_secret,
				state.startedAt,
			);
			latestActivity = activity.body;
			latestSummaries = collectRunEventSummaries(activity.body, criteria);
			if (options.matches(latestSummaries)) {
				await writeObserveSuccessArtifacts(
					config,
					options.artifactName,
					activity.body,
					latestSummaries,
				);
				return latestSummaries;
			}
			await failFastOnIncompleteActivity(
				config,
				options.artifactName,
				options.label,
				activity.body,
				criteria,
				eventTypes,
			);
			await writeObserveLatestArtifacts(
				config,
				options.artifactName,
				activity.body,
				latestSummaries,
			);
		} catch (error) {
			if (error instanceof NonRetryableEvidenceError) {
				await writeArtifact(
					config,
					`${options.artifactName}-failure.txt`,
					error.message,
				);
				throw error;
			}
			lastError = error;
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await sleep(Math.min(config.observePollMs, remainingMs));
	}

	if (latestActivity !== undefined) {
		await writeObserveLatestArtifacts(
			config,
			options.artifactName,
			latestActivity,
			latestSummaries,
		);
	}
	throw new Error(
		`Timed out waiting for ${options.label}${
			lastError instanceof Error ? `; last error: ${lastError.message}` : ""
		}`,
	);
}

export async function expectNoObserveEventForWindow(
	config: TestConfig,
	state: AgentRunState,
	options: {
		artifactName: string;
		eventType: ExpectedEventType;
		label: string;
		matchesLeak?: (summary: EventSummary) => boolean;
		sessionUuid?: string;
		sessionUuids?: Set<string>;
		timeoutMs?: number;
	},
): Promise<EventSummary[]> {
	const identity = await readObserveIdentity(config);
	const criteria: EventCriteria = {
		machineUuid: identity.machine_uuid,
		sdkUserCuid: identity.user_cuid,
		sessionUuids: options.sessionUuids,
	};
	const deadline = Date.now() + (options.timeoutMs ?? config.observeTimeoutMs);
	let latestActivity: unknown;
	let latestSummaries: EventSummary[] = [];

	while (true) {
		const activity = await readObserveActivity(
			config,
			identity.machine_secret,
			state.startedAt,
		);
		latestActivity = activity.body;
		latestSummaries = collectRunEventSummaries(activity.body, criteria);
		await failFastOnIncompleteActivity(
			config,
			options.artifactName,
			options.label,
			activity.body,
			criteria,
			new Set([options.eventType]),
		);
		const leakSummaries = options.matchesLeak
			? latestSummaries.filter(options.matchesLeak)
			: latestSummaries.filter(
					(summary) =>
						summary.scopeSessionUuid === options.sessionUuid &&
						summary.eventType === options.eventType,
				);
		if (leakSummaries.length > 0) {
			await writeJsonArtifact(
				config,
				`${options.artifactName}-leak-events.json`,
				latestSummaries,
			);
			throw new Error(
				`${options.label} emitted ${leakSummaries.length} ${options.eventType} event(s)`,
			);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await sleep(Math.min(config.observePollMs, remainingMs));
	}

	await writeJsonArtifact(
		config,
		`${options.artifactName}-negative-activity.json`,
		latestActivity,
	);
	await writeJsonArtifact(
		config,
		`${options.artifactName}-negative-events.json`,
		latestSummaries,
	);
	return latestSummaries;
}

async function readObserveIdentity(config: TestConfig) {
	const identity = await waitForEvidence(
		() => readRemoteSnoIdentity(config),
		(candidate) =>
			isLowercaseCanonicalUUIDv7(candidate.machine_uuid) &&
			typeof candidate.machine_secret === "string" &&
			candidate.machine_secret.length > 20,
		{
			label: "Sno Observe identity",
			pollMs: 2_000,
			timeoutMs: 60_000,
		},
	);
	await writeJsonArtifact(
		config,
		"sno-identity.json",
		redactIdentity(identity),
	);
	return identity;
}

async function writeObserveSuccessArtifacts(
	config: TestConfig,
	artifactName: string,
	activityBody: unknown,
	summaries: EventSummary[],
): Promise<void> {
	await writeJsonArtifact(
		config,
		`${artifactName}-activity.json`,
		activityBody,
	);
	await writeJsonArtifact(config, `${artifactName}-events.json`, summaries);
}

async function writeObserveLatestArtifacts(
	config: TestConfig,
	artifactName: string,
	activityBody: unknown,
	summaries: EventSummary[],
): Promise<void> {
	await writeJsonArtifact(
		config,
		`${artifactName}-latest-activity.json`,
		activityBody,
	);
	await writeJsonArtifact(config, `${artifactName}-latest-events.json`, summaries);
}

async function failFastOnIncompleteActivity(
	config: TestConfig,
	artifactName: string,
	label: string,
	activityBody: unknown,
	criteria: EventCriteria,
	eventTypes: ReadonlySet<ExpectedEventType>,
): Promise<void> {
	const incomplete = findIncompleteActivityEvidence(
		activityBody,
		criteria,
		eventTypes,
	);
	if (!incomplete) {
		return;
	}
	await writeJsonArtifact(
		config,
		`${artifactName}-incomplete-activity.json`,
		activityBody,
	);
	await writeJsonArtifact(
		config,
		`${artifactName}-incomplete-events.json`,
		incomplete,
	);
	throw new NonRetryableEvidenceError(
		`${label} cannot be verified: Sno activity returned target event rows without scope/payload envelope`,
	);
}
