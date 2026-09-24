#!/usr/bin/env node
import { writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { detectProjectId, laneForEventType, normalizeGitRemote } from "../index.js";
import { sha256Hex } from "../internal/hash.js";
import { SnoObserveRuntime } from "../internal/runtime.js";
import { agentIdSchema, eventTypeSchema, parseEventInput, payloadSchemas } from "../internal/schemas.js";
import type { JsonObject, ParsedEvent } from "../internal/types.js";

function parseFlags(args: string[]): Record<string, string> {
	const flags: Record<string, string> = {};
	for (const arg of args) {
		const match = /^--([^=]+)=(.*)$/su.exec(arg);
		if (!match || match[1] === undefined || match[2] === undefined) {
			throw new Error(`expected --field=value: ${arg}`);
		}
		flags[match[1]] = match[2];
	}
	return flags;
}

function fieldValue(schema: unknown, value: string): string | number | boolean {
	while (schema instanceof z.ZodOptional || schema instanceof z.ZodPipe) {
		schema = schema instanceof z.ZodOptional ? schema.unwrap() : schema.in;
	}
	if (schema instanceof z.ZodNumber) return value.trim() === "" ? Number.NaN : Number(value);
	if (schema instanceof z.ZodBoolean && (value === "true" || value === "false")) {
		return value === "true";
	}
	return value;
}

function parseAppend(args: string[], flags: Record<string, string>): ParsedEvent {
	if (args[0] !== "append") throw new Error("expected: sno-observe append <event_type> --agent=<harness> --field=value");
	const eventType = eventTypeSchema.parse(args[1]);
	const schema = payloadSchemas[eventType];
	const { agent, project, project_id: projectId, ...fields } = flags;
	const payload: JsonObject = {};
	for (const [key, value] of Object.entries(fields)) {
		payload[key] = fieldValue(schema instanceof z.ZodObject ? schema.shape[key] : undefined, value);
	}
	const parsed = parseEventInput({
		event_type: eventType,
		lane: laneForEventType(eventType),
		agent_id: agent,
		payload,
	});
	if (projectId !== undefined && !/^p_[a-f0-9]{16}$/u.test(projectId)) {
		throw new Error("project_id: expected p_ followed by 16 lowercase hex characters");
	}
	if (project !== undefined && project.trim() === "") throw new Error("project: must not be empty");
	if (eventType === "agent.identify" || eventType === "rsi.run" || eventType === "skill.install" ||
		(eventType.startsWith("rsi.") && payload["level"] === "user")) return parsed;
	let resolvedProjectId = projectId;
	if (resolvedProjectId === undefined) {
		resolvedProjectId = project === undefined || isAbsolute(project)
			? detectProjectId(project ?? process.cwd())
			: `p_${sha256Hex(normalizeGitRemote(project)).slice(0, 16)}`;
	}
	parsed.scope = { project_id: resolvedProjectId };
	return parsed;
}

async function send(parsed: ParsedEvent): Promise<void> {
	const runtime = new SnoObserveRuntime();
	await runtime.emitParsed(parsed);
	await runtime.flush();
}

function errorLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ");
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	let parsed: ParsedEvent;
	try {
		parsed = parseAppend(args, parseFlags(args.slice(2)));
	} catch (error) {
		const line = errorLine(error);
		const agent = agentIdSchema.safeParse(args.find((arg) => arg.startsWith("--agent="))?.slice(8));
		const eventType = eventTypeSchema.safeParse(args[1]);
		const component = args[1]?.split(".")[0];
		if (agent.success && eventType.success &&
			(component === "reach" || component === "handoff" || component === "review" || component === "rsi")) {
			try {
				await send(parseEventInput({
					event_type: "error", lane: laneForEventType("error"), agent_id: agent.data,
					scope: { project_id: detectProjectId() },
					payload: {
						kind: `${component}:observe_append_failed`, message_hash: sha256Hex(line),
						recoverable: true, component, context: eventType.data,
					},
				}));
			} catch (sendError) {
				writeSync(2, `${errorLine(sendError)}\n`);
				return 1;
			}
		}
		writeSync(2, `${line}\n`);
		return 2;
	}
	try {
		await send(parsed);
		return 0;
	} catch (error) {
		writeSync(2, `${errorLine(error)}\n`);
		return 1;
	}
}

// A short-lived append flushes once; do not run the SDK's beforeExit drain.
process.exit(await main());
