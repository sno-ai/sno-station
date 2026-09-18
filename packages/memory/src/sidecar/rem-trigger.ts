/** @file rem-trigger.ts
 * @purpose Evaluates daily and candidate-growth REM triggers on the gateway maintenance tick.
 * @boundary Reads candidate scopes and durable trigger state, audits decisions, then calls the sidecar.
 */

import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { createLogger } from "@snoai/utils/logger";
import { withLogContext } from "@snoai/utils/log-context";
import { z } from "zod";
import {
	appendAuditEntryStrict,
	getAuditPath,
	type AuditStatus,
} from "../engine/operations/runtime-audit-log";
import {
	PLUGIN_ENTRY_KEY,
	readSnoStationMemConfig,
	resolveSnoStationMemConfigPath,
} from "../engine/bindings/embedder-config-files";
import {
	REM_CORRELATION_ID_HEADER,
	REM_RUN_PATH,
	REM_SIDECAR_HOST,
	REM_SIDECAR_TOKEN_HEADER,
	getRemDiscoveryPath,
} from "./config";
import { enumerateRemCandidateScopes } from "./rem-batch-executor";
import {
	ensureRemTriggerScope,
	loadRemTriggerState,
	type RemTriggerScopeState,
	type RemTriggerStateDocument,
	writeRemTriggerStateAtomic as persistTriggerState,
} from "./rem-trigger-state";
import type { SqliteDatabaseLike } from "../store/sqlite-runtime";
import { pluginConfigSchema } from "../engine/shared/types";

export const REM_DAILY_SCHEDULE_HOUR = 3;
export const REM_VOLUME_THRESHOLD = 100;
export const REM_TRIGGER_ATTEMPT_LIMIT = 3;
export const REM_TRIGGER_DISPATCH_TIMEOUT_MS = 10_000;

const REM_COMPLETION_AUDIT_TAIL_BYTES = 16 * 1024 * 1024;
const log = createLogger("sno-station-mem:rem-trigger");

type RemAutomaticTrigger = "daily" | "volume";
export type RemAutomaticOperation = "rem-replace" | "rem-update";

export interface RemAutomaticTriggerInput {
	database: SqliteDatabaseLike;
	stateDir: string;
	auditStateDir?: string;
	requestedOperations: RemAutomaticOperation[];
	now?: Date;
	tickEnabled?: boolean;
	volumeThreshold?: number;
	discoveryPath?: string;
	dispatchTimeoutMs?: number;
	resolveScheduleZone?: () => string;
}

export interface RemAutomaticTriggerReport {
	evaluations: number;
	dispatches: number;
}

const discoverySchema = z
	.object({
		pid: z.number().int().positive(),
		port: z.number().int().min(1).max(65_535),
		token: z.string().min(1),
	})
	.strict();

const idleEvaluations = new Map<string, number>();
const registeredTicks = new Map<string, boolean | undefined>();

export function setRegisteredRemTick(skinId: string, tick: boolean | undefined): void {
	registeredTicks.set(skinId, tick);
}

export function clearRegisteredRemTicks(): void {
	registeredTicks.clear();
}

export function readRemAutomaticOperations(
	configPath: string = resolveSnoStationMemConfigPath(),
): { requestedOperations: RemAutomaticOperation[]; tickEnabled: boolean } {
	let config: ReturnType<typeof pluginConfigSchema.parse>;
	try {
		const hostConfig = readSnoStationMemConfig(configPath);
		config = pluginConfigSchema.parse(hostConfig.plugins?.entries?.[PLUGIN_ENTRY_KEY]?.config ?? {});
	} catch (error) {
		log.error("REM configuration unavailable; using installed defaults", { cause: errorMessage(error) }, { event_name: "memory.rem.trigger.configuration.unavailable", file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts", function: "evaluateRemAutomaticTriggers", site_id: "memory.rem.trigger.configuration.unavailable" });
		config = pluginConfigSchema.parse({});
	}
	const ticks = [...registeredTicks.values()];
	const registeredTick = ticks.includes(false) ? false : ticks.find(tick => tick !== undefined);
	return { requestedOperations: config.remOperations, tickEnabled: registeredTick ?? config.remEnhanced.trigger?.tick ?? true };
}

export async function evaluateRemAutomaticTriggers(
	input: RemAutomaticTriggerInput,
): Promise<RemAutomaticTriggerReport> {
	const now = input.now ?? new Date();
	if (!Number.isInteger(input.volumeThreshold ?? REM_VOLUME_THRESHOLD) || (input.volumeThreshold ?? REM_VOLUME_THRESHOLD) < 1) throw new Error("REM volume threshold must be a positive integer");
	const auditStateDir = input.auditStateDir ?? input.stateDir;
	if (Number.isNaN(now.getTime())) throw new Error("REM trigger evaluation time is invalid");
	if (input.requestedOperations.length === 0) {
		await recordDecision(auditStateDir, undefined, "skipped", {
			row: "automatic-trigger-skipped",
			reason: "product-mode-disabled",
		});
		return { evaluations: 0, dispatches: 0 };
	}
	let scopes: ReturnType<typeof enumerateRemCandidateScopes>;
	try {
		scopes = enumerateRemCandidateScopes(input.database);
	} catch (error) {
		await recordDecision(auditStateDir, undefined, "error", {
			row: "enumeration-failed",
			cause: errorMessage(error),
		});
		return { evaluations: 1, dispatches: 0 };
	}
	if (scopes.length === 0) {
		await recordDecision(auditStateDir, undefined, "ok", { row: "no-scopes" });
		return { evaluations: 1, dispatches: 0 };
	}

	let state: RemTriggerStateDocument;
	let lostState = false;
	try {
		state = await loadRemTriggerState(input.stateDir);
	} catch (error) {
		for (const { scope, candidateCount } of scopes) {
			const consecutiveIdle = (idleEvaluations.get(scope) ?? 0) + 1;
			idleEvaluations.set(scope, consecutiveIdle);
			await recordDecision(auditStateDir, scope, "error", {
				row: "state-unreadable",
				candidate_count: candidateCount,
				cause: errorMessage(error),
				consecutive_idle: consecutiveIdle,
			});
		}
		log.error("REM trigger state unavailable; continuing with due work", { cause: errorMessage(error) }, { event_name: "memory.rem.trigger.state.unavailable", file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts", function: "evaluateRemAutomaticTriggers", site_id: "memory.rem.trigger.state.unavailable" });
		state = { version: 1, scopes: {} };
		lostState = true;
	}

	state = await applyCompletedBaselines(auditStateDir, input.stateDir, state);
	let dispatches = 0;
	for (const { scope, candidateCount } of scopes) {
		try {
			const ensured = ensureRemTriggerScope(state, {
				scope,
				now: lostState ? previousDay(now) : now,
				candidateCount,
				resolveScheduleZone: input.resolveScheduleZone,
			});
			state = ensured.state;
			if (ensured.initialized) await writeRemTriggerStateAtomic(input.stateDir, state);
			const scopeResult = await evaluateScope(
				input,
				auditStateDir,
				state,
				scope,
				candidateCount,
				now,
			);
			state = scopeResult.state;
			dispatches += scopeResult.dispatched ? 1 : 0;
		} catch (error) {
			log.error("REM automatic scope evaluation failed", { scope, error }, {
				event_name: "sno_station_mem.rem-trigger.rem.automatic.scope.evaluation.failed",
				file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts",
				function: "evaluateRemAutomaticTriggers",
				site_id: "rem-trigger.evaluateRemAutomaticTriggers.1d59077a5c",
			});
			try {
				await recordDecision(auditStateDir, scope, "error", {
					row: "scope-evaluation-failed",
					cause: errorMessage(error),
				});
			} catch (auditError) {
				log.warn("REM automatic scope failure audit failed", { scope, error: auditError }, {
					event_name: "sno_station_mem.rem-trigger.rem.automatic.scope.failure.audit.failed",
					file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts",
					function: "evaluateRemAutomaticTriggers",
					site_id: "rem-trigger.evaluateRemAutomaticTriggers.ebe1cdd204",
				});
			}
			try {
				state = await loadRemTriggerState(input.stateDir);
			} catch (stateError) {
				log.warn("REM automatic trigger state reload failed", { scope, error: stateError }, {
					event_name: "sno_station_mem.rem-trigger.rem.automatic.trigger.state.reload.failed",
					file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts",
					function: "evaluateRemAutomaticTriggers",
					site_id: "rem-trigger.evaluateRemAutomaticTriggers.46669e66ff",
				});
				break;
			}
		}
	}
	return { evaluations: scopes.length, dispatches };
}

function previousDay(now: Date): Date {
	const day = new Date(now);
	day.setUTCDate(day.getUTCDate() - 1);
	return day;
}

async function writeRemTriggerStateAtomic(stateDir: string, state: RemTriggerStateDocument): Promise<void> {
	try { await persistTriggerState(stateDir, state); }
	catch (error) { log.error("REM trigger state write failed; continuing dispatch", { cause: errorMessage(error) }, { event_name: "memory.rem.trigger.state.write.failed", file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts", function: "evaluateRemAutomaticTriggers", site_id: "memory.rem.trigger.state.write.failed" }); }
}

async function evaluateScope(
	input: RemAutomaticTriggerInput,
	auditStateDir: string,
	state: RemTriggerStateDocument,
	scope: string,
	candidateCount: number,
	now: Date,
): Promise<{ state: RemTriggerStateDocument; dispatched: boolean }> {
	const scopeState = requiredScopeState(state, scope);
	const zone = scopeState.schedule_zone;
	// At most one automatic pass per local day, whichever trigger comes first (owner ruling
	// 2026-09-16). `last_volume_pass_date` is the local day whose pass is used up: a completed
	// volume pass sets it, and so does a completed daily pass (applyCompletedBaselines). A used-up
	// day closes the volume trigger and moves the daily pass to the next day's schedule.
	const nextDue = nextDailyDue(scopeState);
	const localDate = localDateAt(now, zone);
	const growth = candidateCount - scopeState.last_covered_count;
	// A pass the other trigger dispatched today and has not seen complete already holds today's slot.
	// Only today's identities count, so a completion that never arrives blocks for a day at most.
	const scheduledDue = computeRemDailyDue(scopeState.last_pass_at, zone);
	const pendingVolumeToday = scopeState.attempts.identity === remAutomaticCorrelationId("volume", scope, localDate);
	const pendingDailyToday = localDateAt(scheduledDue, zone) === localDate
		&& scopeState.attempts.identity === remAutomaticCorrelationId("daily", scope, scheduledDue.toISOString());
	const dailyDue = now.getTime() >= nextDue.getTime() && !pendingVolumeToday;
	const volumeDue = growth >= (input.volumeThreshold ?? REM_VOLUME_THRESHOLD)
		&& scopeState.last_volume_pass_date !== localDate
		&& !pendingDailyToday;
	if (!dailyDue && !volumeDue) {
		const consecutiveIdle = (idleEvaluations.get(scope) ?? 0) + 1;
		idleEvaluations.set(scope, consecutiveIdle);
		await recordDecision(auditStateDir, scope, "ok", {
			row: "waiting-for-schedule",
			next_due: nextDue.toISOString(),
			milliseconds_until_due: Math.max(0, nextDue.getTime() - now.getTime()),
			growth: growthDetails(candidateCount, scopeState.last_covered_count, input.volumeThreshold ?? REM_VOLUME_THRESHOLD),
			consecutive_idle: consecutiveIdle,
		});
		return { state, dispatched: false };
	}

	const trigger: RemAutomaticTrigger = dailyDue ? "daily" : "volume";
	if (input.tickEnabled === false) {
		const nextState = replaceScopeState(state, scope, {
			...scopeState,
			missed_window: {
				due_at: dailyDue ? nextDue.toISOString() : now.toISOString(),
				trigger,
				recorded_at: now.toISOString(),
			},
		});
		await writeRemTriggerStateAtomic(input.stateDir, nextState);
		return { state: nextState, dispatched: false };
	}
	const triggerKey = trigger === "daily" ? nextDue.toISOString() : localDate;
	const correlationId = remAutomaticCorrelationId(trigger, scope, triggerKey);
	const priorAttempts =
		scopeState.attempts.identity === correlationId ? scopeState.attempts.count : 0;
	await recordDecision(auditStateDir, scope, "ok", {
		row: "dispatch",
		trigger,
		next_due: nextDue.toISOString(),
		pass_at: now.toISOString(),
		local_date: localDate,
		growth: growthDetails(candidateCount, scopeState.last_covered_count, input.volumeThreshold ?? REM_VOLUME_THRESHOLD),
		correlation_id: correlationId,
		consecutive_idle: 0,
	});
	idleEvaluations.set(scope, 0);

	let nextState = replaceScopeState(state, scope, {
		...scopeState,
		attempts: {
			identity: correlationId,
			count: Math.min(priorAttempts + 1, REM_TRIGGER_ATTEMPT_LIMIT),
		},
	});
	await writeRemTriggerStateAtomic(input.stateDir, nextState);
	let cause: string | undefined;
	try {
		await dispatchRemWave(input, scope, correlationId);
	} catch (error) {
		cause = errorMessage(error);
	}
	if (cause === undefined) {
		nextState = replaceScopeState(nextState, scope, { ...requiredScopeState(nextState, scope), missed_window: null });
		await writeRemTriggerStateAtomic(input.stateDir, nextState);
		return { state: nextState, dispatched: true };
	}

	await appendAuditEntryStrict(auditStateDir, {
		event: "rem_failed",
		resultStatus: "error",
		scope,
		details: { outcome: "dispatch-failed", cause, correlation_id: correlationId, source: "gateway-trigger" },
	});
	return { state: nextState, dispatched: true };
}

async function dispatchRemWave(
	input: RemAutomaticTriggerInput,
	scope: string,
	correlationId: string,
): Promise<void> {
	const started = performance.now();
	const discovery = discoverySchema.parse(
		JSON.parse(await readFile(input.discoveryPath ?? getRemDiscoveryPath(), "utf8")) as unknown,
	);
	const response = await fetch(`http://${REM_SIDECAR_HOST}:${discovery.port}${REM_RUN_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[REM_SIDECAR_TOKEN_HEADER]: discovery.token,
			[REM_CORRELATION_ID_HEADER]: correlationId,
		},
		body: JSON.stringify({ types: input.requestedOperations, scope }),
		signal: AbortSignal.timeout(input.dispatchTimeoutMs ?? REM_TRIGGER_DISPATCH_TIMEOUT_MS),
	});
	if (response.status !== 202) throw new Error(`REM sidecar returned HTTP ${response.status}`);
	const body = z
		.object({ job_id: z.string().min(1), waveId: z.string().min(1) })
		.passthrough()
		.parse((await response.json()) as unknown);
	if (body.job_id !== body.waveId) throw new Error("REM sidecar confirmation identities disagree");
	withLogContext({ operation_id: body.job_id, job_id: body.job_id, session_reference: scope, external_reference: correlationId }, () => {
		log.info("REM dispatch accepted", { outcome: "success", job_id: body.job_id, status: response.status, duration_ms: performance.now() - started }, {
			event_name: "sidecar.trigger.dispatch.accepted",
			file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts",
			function: "dispatchRemWave",
			site_id: "sidecar.trigger.dispatch.accepted",
		});
	});
}

async function applyCompletedBaselines(
	auditStateDir: string,
	triggerStateDir: string,
	state: RemTriggerStateDocument,
): Promise<RemTriggerStateDocument> {
	let content: string;
	try {
		content = await readAuditTail(getAuditPath(auditStateDir));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return state;
		log.warn("REM completion audit could not be read", { error, outcome: "skipped", reason_code: "audit_read_failed" }, {
			event_name: "sidecar.trigger.audit_read.failed",
			file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts",
			function: "applyCompletedBaselines",
			site_id: "sidecar.trigger.audit_read.failed",
		});
		return state;
	}
	const dispatched = new Map<
		string,
		{ scope: string; trigger?: RemAutomaticTrigger; passAt?: string; localDate?: string }
	>();
	let nextState = state;
	let malformedCount = 0;
	for (const line of content.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			const details = asRecord(entry["details"]);
			const correlationId = details?.["correlation_id"];
			const scope = entry["scope"];
			if (
				entry["event"] === "rem_trigger_evaluated" &&
				details?.["row"] === "dispatch" &&
				typeof correlationId === "string" &&
				typeof scope === "string"
			) {
				const trigger = details["trigger"];
				const passAt = details["pass_at"];
				const localDate = details["local_date"];
				dispatched.set(correlationId, {
					scope,
					...(trigger === "daily" || trigger === "volume" ? { trigger } : {}),
					...(typeof passAt === "string" ? { passAt } : {}),
					...(typeof localDate === "string" ? { localDate } : {}),
				});
				continue;
			}
			if (entry["event"] !== "rem_completed" || typeof correlationId !== "string") continue;
			const dispatch = dispatched.get(correlationId);
			if (
				dispatch === undefined ||
				state.scopes[dispatch.scope] === undefined ||
				entry["scope"] !== dispatch.scope
			) {
				continue;
			}
			const currentScopeState = requiredScopeState(nextState, dispatch.scope);
			let completedScopeState: RemTriggerScopeState = {
				...currentScopeState,
				...(dispatch.trigger === "daily" && isValidInstant(dispatch.passAt)
					? { last_pass_at: dispatch.passAt }
					: {}),
				// A completed daily pass uses up its local day too, so the volume trigger stays closed.
				...(dispatch.trigger === "daily" && isLocalDate(dispatch.localDate)
					? { last_volume_pass_date: dispatch.localDate }
					: {}),
				...(dispatch.trigger === "volume" && isLocalDate(dispatch.localDate)
					? { last_volume_pass_date: dispatch.localDate }
					: {}),
				...(currentScopeState.attempts.identity === correlationId
					? { attempts: { identity: null, count: 0 } }
					: {}),
			};
			const measured = asRecord(asRecord(details?.["stats"])?.["measured"]);
			const rowsConsidered = measured?.["rows_considered"];
			if (
				measured?.["pair_cap_binding"] === false &&
				Number.isInteger(rowsConsidered) &&
				Number(rowsConsidered) >= 0
			) {
				completedScopeState = {
					...completedScopeState,
					last_covered_count: Number(rowsConsidered),
				};
			}
			if (JSON.stringify(completedScopeState) === JSON.stringify(currentScopeState)) continue;
			nextState = replaceScopeState(nextState, dispatch.scope, completedScopeState);
		} catch {
			// A malformed completion cannot move the baseline or hide later valid evidence.
			malformedCount += 1;
		}
	}
	if (malformedCount > 0) {
		log.warn("Malformed REM audit records skipped", { malformed_count: malformedCount, outcome: "partial" }, {
			event_name: "sidecar.trigger.audit_records.skipped",
			file: "packages/sno-station-mem/src/sidecar/rem-trigger.ts",
			function: "applyCompletedBaselines",
			site_id: "sidecar.trigger.audit_records.skipped",
		});
	}
	if (nextState !== state) await writeRemTriggerStateAtomic(triggerStateDir, nextState);
	return nextState;
}

async function readAuditTail(auditPath: string): Promise<string> {
	const handle = await open(auditPath, "r");
	try {
		const size = (await handle.stat()).size;
		const bytesToRead = Math.min(size, REM_COMPLETION_AUDIT_TAIL_BYTES);
		if (bytesToRead === 0) return "";
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, size - bytesToRead);
		let content = buffer.subarray(0, bytesRead).toString("utf8");
		if (size > bytesToRead) {
			const firstLineEnd = content.indexOf("\n");
			content = firstLineEnd === -1 ? "" : content.slice(firstLineEnd + 1);
		}
		return content;
	} finally {
		await handle.close();
	}
}

export function remAutomaticCorrelationId(
	trigger: RemAutomaticTrigger,
	scope: string,
	triggerKey: string,
): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(["rem-automatic-v1", trigger, scope, triggerKey]))
		.digest("hex");
	return `rem-auto-${trigger}-${digest}`;
}

/** The daily due time, pushed to the schedule after the last used-up local day. */
function nextDailyDue(scopeState: RemTriggerScopeState): Date {
	const scheduled = computeRemDailyDue(scopeState.last_pass_at, scopeState.schedule_zone);
	const volumeDate = scopeState.last_volume_pass_date;
	if (volumeDate === null) return scheduled;
	const parsed = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(volumeDate);
	// The state schema only admits YYYY-MM-DD here; anything else leaves the daily schedule alone.
	if (parsed === null) return scheduled;
	const following = addCalendarDays({ year: Number(parsed[1]), month: Number(parsed[2]), day: Number(parsed[3]) }, 1);
	const afterVolume = zonedInstant(scopeState.schedule_zone, following.year, following.month, following.day);
	return afterVolume.getTime() > scheduled.getTime() ? afterVolume : scheduled;
}

export function computeRemDailyDue(lastPassAt: string, scheduleZone: string): Date {
	const lastPass = new Date(lastPassAt);
	if (Number.isNaN(lastPass.getTime())) throw new Error("REM last pass time is invalid");
	const localDate = localDateParts(lastPass, scheduleZone);
	let due = zonedInstant(scheduleZone, localDate.year, localDate.month, localDate.day);
	if (due.getTime() <= lastPass.getTime()) {
		const nextDate = addCalendarDays(localDate, 1);
		due = zonedInstant(scheduleZone, nextDate.year, nextDate.month, nextDate.day);
	}
	return due;
}

function zonedInstant(zone: string, year: number, month: number, day: number): Date {
	const target = Date.UTC(year, month - 1, day, REM_DAILY_SCHEDULE_HOUR, 0, 0, 0);
	let instant = target;
	let firstExistingAfter: { instant: number; represented: number } | undefined;
	for (let iteration = 0; iteration < 5; iteration++) {
		const parts = zonedDateTimeParts(new Date(instant), zone);
		const represented = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
		);
		const adjustment = target - represented;
		if (adjustment === 0) return new Date(instant);
		if (represented > target && represented < (firstExistingAfter?.represented ?? Number.POSITIVE_INFINITY)) {
			firstExistingAfter = { instant, represented };
		}
		instant += adjustment;
	}
	if (firstExistingAfter !== undefined) return new Date(firstExistingAfter.instant);
	throw new Error(`REM scheduled instant cannot be resolved in zone ${zone}`);
}

function localDateAt(instant: Date, zone: string): string {
	const parts = localDateParts(instant, zone);
	return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function localDateParts(instant: Date, zone: string): { year: number; month: number; day: number } {
	const parts = zonedDateTimeParts(instant, zone);
	return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedDateTimeParts(
	instant: Date,
	zone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
	const values: Record<string, number> = {};
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	for (const part of formatter.formatToParts(instant)) {
		if (part.type !== "literal") values[part.type] = Number(part.value);
	}
	const year = values["year"];
	const month = values["month"];
	const day = values["day"];
	const hour = values["hour"];
	const minute = values["minute"];
	const second = values["second"];
	if ([year, month, day, hour, minute, second].some((value) => value === undefined)) {
		throw new Error(`REM schedule zone ${zone} did not produce complete date parts`);
	}
	return {
		year: Number(year),
		month: Number(month),
		day: Number(day),
		hour: Number(hour),
		minute: Number(minute),
		second: Number(second),
	};
}

function addCalendarDays(
	date: { year: number; month: number; day: number },
	days: number,
): { year: number; month: number; day: number } {
	const instant = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return {
		year: instant.getUTCFullYear(),
		month: instant.getUTCMonth() + 1,
		day: instant.getUTCDate(),
	};
}

function growthDetails(candidateCount: number, coveredCount: number, threshold: number): Record<string, number> {
	const growth = candidateCount - coveredCount;
	return {
		candidate_count: candidateCount,
		last_covered_count: coveredCount,
		delta: growth,
		threshold,
		remaining: Math.max(0, threshold - growth),
	};
}

async function recordDecision(
	stateDir: string,
	scope: string | undefined,
	resultStatus: AuditStatus,
	details: Record<string, unknown>,
): Promise<void> {
	await appendAuditEntryStrict(stateDir, {
		event: "rem_trigger_evaluated",
		resultStatus,
		...(scope === undefined ? {} : { scope }),
		details,
	});
}

function requiredScopeState(
	state: RemTriggerStateDocument,
	scope: string,
): RemTriggerScopeState {
	const scopeState = state.scopes[scope];
	if (scopeState === undefined) throw new Error(`REM trigger state missing scope ${scope}`);
	return scopeState;
}

function replaceScopeState(
	state: RemTriggerStateDocument,
	scope: string,
	scopeState: RemTriggerScopeState,
): RemTriggerStateDocument {
	return { version: 1, scopes: { ...state.scopes, [scope]: scopeState } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isValidInstant(value: string | undefined): value is string {
	return value !== undefined && !Number.isNaN(new Date(value).getTime());
}

function isLocalDate(value: string | undefined): value is string {
	return value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
