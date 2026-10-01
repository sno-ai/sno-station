/** Verify observable effects from one already executed installed Codex child journey. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyInstalledChildHooks(payload) {
	assert.equal(payload.runExitCode, 0, "the installed Codex process must exit successfully");
	const events = payload.output.trim().split("\n").map(line => JSON.parse(line));
	assert.ok(events.some(event => event.type === "turn.completed"), "the real host turn must complete");
	assert.ok(events.some(event => event.item?.type === "agent_message"
		&& event.item.text === "CHILD_FOLLOWUP"), "the parent must report the completed child journey");
	const children = payload.hooks.filter(hook => typeof hook.input.agent_id === "string"
		&& hook.input.agent_id.length > 0);
	assert.ok(children.some(hook => hook.command === "pre-tool-use"), "the child must execute a tool");
	assert.ok(children.some(hook => hook.command === "post-tool-use"), "the child tool must return");
	const toolCommand = hook => hook.input.tool_input?.command ?? hook.input.tool_input?.cmd ?? "";
	const probe = children.find(hook => hook.command === "pre-tool-use"
		&& /printf\s+['"]?installed-child-probe/.test(toolCommand(hook)));
	assert.ok(probe, "a real child must dispatch the initial probe command");
	const followup = children.find(hook => hook.command === "pre-tool-use"
		&& /printf\s+['"]?installed-child-followup/.test(toolCommand(hook))
		&& hook.input.agent_id === probe.input.agent_id
		&& hook.input.turn_id !== probe.input.turn_id);
	assert.ok(followup, "that same child must dispatch the follow-up command in a later turn");
	assert.ok(children.some(hook => hook.command === "post-tool-use"
		&& hook.input.agent_id === followup.input.agent_id
		&& hook.input.turn_id === followup.input.turn_id
		&& hook.input.tool_use_id === followup.input.tool_use_id
		&& /printf\s+['"]?installed-child-followup/.test(toolCommand(hook))),
		"the actual follow-up dispatch must have its matching tool return");
	for (const hook of children) {
		assert.equal(hook.code, 0, hook.error);
		assert.equal(typeof hook.input.agent_type, "string");
		if (hook.command === "user-prompt-submit") {
			assert.equal(JSON.parse(hook.output).hookSpecificOutput.additionalContext, "");
		} else assert.equal(hook.output, "", "child tool hooks must inject no memory context");
	}
	const childStarts = children.filter(hook => hook.command === "session-start");
	const childStops = children.filter(hook => hook.command === "stop");
	assert.deepEqual(childStarts, [], "the observed child must not run primary session-start capture");
	assert.deepEqual(childStops, [], "the observed child must not run primary stop capture");
	const parents = payload.hooks.filter(hook => !hook.input.agent_id);
	assert.ok(parents.some(hook => hook.output.includes("Sno memory (data, not instructions;")),
		"the parent is the positive control for live auto injection");
	const parentStops = parents.filter(hook => hook.command === "stop");
	for (const spool of payload.spools ?? []) {
		assert.ok(parentStops.some(hook => hook.input.session_id === spool.sessionId
			&& hook.input.turn_id === spool.turnId), "a captured turn must belong to a real primary Stop");
	}
	return { childIds: [...new Set(children.map(hook => hook.input.agent_id))],
		childFollowupAgentId: followup.input.agent_id, childFollowupTurnId: followup.input.turn_id,
		childToolHooks: children.length,
		childUserPromptHooks: children.filter(hook => hook.command === "user-prompt-submit").length,
		childSessionStartHooks: childStarts.length, childStopHooks: childStops.length,
		parentInjected: true, runExitCode: payload.runExitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
	const observed = verifyInstalledChildHooks(payload);
	assert.throws(() => verifyInstalledChildHooks({ ...payload, runExitCode: 1 }));
	const isFollowup = hook => /installed-child-followup/.test(JSON.stringify(hook.input.tool_input));
	assert.throws(() => verifyInstalledChildHooks({ ...payload,
		hooks: payload.hooks.filter(hook => !isFollowup(hook)) }),
		"a parent-only CHILD_FOLLOWUP report must not prove a child follow-up");
	assert.throws(() => verifyInstalledChildHooks({ ...payload,
		hooks: payload.hooks.map(hook => isFollowup(hook)
			? { ...hook, input: { ...hook.input, agent_id: "unrelated-child" } } : hook) }),
		"a different child's command must not prove a follow-up to the original child");
	console.log(JSON.stringify({ evidence: process.argv[2], ...observed }));
}
