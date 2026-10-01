/** @file model-recorders.ts
 * @purpose Loopback stand-ins for the Sno GPU and the host model callback that record which model call
 * each request carried. No call id travels on the wire, so a call is told apart by a fixed line of its prompt.
 */

import { createServer } from "node:http";

/** A fixed line inside each prompt template, and the call id of the model-call table it belongs to. */
export const PROMPT_LINES: Array<[string, string]> = [
	["Task: REM source rewrite.", "REM5"],
	["Task: REM rewrite verification.", "REM6"],
	["Task: REM relation judgment.", "REM7"],
	["Task: REM retirement target judgment.", "REM8"],
	["Task: REM clause carry judgment.", "REM4"],
	["Classify whether every older-memory clause remains covered after replacement.", "REM3"],
	["Judge whether the newer memory replaces the older memory.", "REM2"],
	// The two conflict-verdict prompts: chat (host) and raw "Verdict:" completion (Sno GPU). REM1, P1 and
	// E10 all render them, so a caller outside REM reads the id by the entry it drove.
	["Adjudicate whether the newer memory replaces the older memory.", "REM1"],
	["Judge the relationship of the newer memory to the older memory.", "REM1"],
	["Judge one current-state profile update.", "P4"],
	["Separate lifecycle retirement from profile ownership cleanup.", "P2"],
	["Stored clause (retired): ", "P3"],
	["Write one current-state profile section after a separate judgment has already finished.", "P5"],
	["Retired position: ", "P6"],
];

export function callId(content: string): string {
	return PROMPT_LINES.find(([line]) => content.includes(line))?.[1] ?? content.split("\n")[0]?.slice(0, 80) ?? "";
}

/** One request as the recorder saw it; `raw` is a completions body (`prompt`), otherwise chat (`messages`). */
export type RecordedCall = { id: string; content: string; raw: boolean; answered: boolean };
export type RecorderReply = { status: number; body: unknown };
export type Recorder = { calls: string[]; received: RecordedCall[]; url: string };

/** A 200 reply shaped for the transport that asked: `choices[].text` for raw, `choices[].message` for chat. */
export function modelReply(text: string, raw: boolean): RecorderReply {
	return { status: 200, body: { id: "loopback", model: "loopback-model",
		choices: [raw ? { text, finish_reason: "stop" } : { message: { role: "assistant", content: text }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1 } } };
}

/** Starts one loopback endpoint; `reply` decides each answer and sees the calls recorded so far. */
export async function startRecorder(
	closers: Array<() => Promise<void>>,
	reply: (call: { id: string; content: string; raw: boolean }, recorder: Recorder) => RecorderReply,
): Promise<Recorder> {
	const recorder: Recorder = { calls: [], received: [], url: "" };
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		let body: { prompt?: unknown; messages?: Array<{ content?: unknown }> } = {};
		try { body = JSON.parse(raw); } catch { /* recorded as an empty prompt */ }
		const content = String(body.messages?.at(-1)?.content ?? body.prompt ?? "");
		const call = { id: callId(content), content, raw: body.prompt !== undefined };
		recorder.calls.push(call.id);
		const answer = reply(call, recorder);
		recorder.received.push({ ...call, answered: answer.status === 200 });
		response.writeHead(answer.status, { "content-type": "application/json" });
		response.end(JSON.stringify(answer.body));
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing recorder port");
	closers.push(async () => {
		server.closeAllConnections();
		await new Promise<void>(done => server.close(() => done()));
	});
	recorder.url = `http://127.0.0.1:${address.port}`;
	return recorder;
}
