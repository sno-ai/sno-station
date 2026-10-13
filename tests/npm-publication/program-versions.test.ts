/**
 * A program archive is named after its VERSION, so a program changed since the last release tag must have a new VERSION.
 * scripts/program-versions.sh names the ones that do not; this runs it against a real throwaway repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../../scripts/program-versions.sh");
const programs = ["reach", "heartbeat", "report-time", "subscription-quota-check"];
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const stale = () => execFileSync("bash", [script], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
const write = (path: string, text: string) => { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), text); };
const commit = (message: string) => { git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", message); };

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "program-versions-"));
	git("init", "-q");
	for (const program of programs) { write(`apps/${program}/VERSION`, "1.0\n"); write(`apps/${program}/bin/${program}`, "echo one\n"); }
	write("apps/requirements-contract.json", "{}\n");
	commit("first release");
	git("tag", "v1.0.0");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

it("names nothing when no program changed since the last release tag", () => {
	write("notes.txt", "unrelated\n");
	commit("unrelated change after the release");
	expect(stale()).toEqual([]);
});

it("names every program when HEAD is the first release and there is no earlier tag", () => {
	expect(stale()).toEqual(programs);
});

it("names a program whose source changed while its VERSION did not", () => {
	write("apps/heartbeat/bin/heartbeat", "echo two\n");
	write("apps/reach/README.md", "docs only\n");
	commit("change heartbeat, document reach");
	expect(stale()).toEqual(["heartbeat"]);
});

it("compares against the previous release when the tag of the release being built is already on HEAD", () => {
	write("apps/heartbeat/bin/heartbeat", "echo two\n");
	commit("change heartbeat");
	git("tag", "v1.1.0");
	expect(stale()).toEqual(["heartbeat"]);
});

it("does not name a program whose VERSION went up with the change", () => {
	write("apps/heartbeat/bin/heartbeat", "echo two\n");
	write("apps/heartbeat/VERSION", "1.1\n");
	commit("change heartbeat and raise its VERSION");
	expect(stale()).toEqual([]);
});

it("names every program when the shared contract changed", () => {
	write("apps/requirements-contract.json", '{"a":1}\n');
	commit("change the contract");
	expect(stale()).toEqual(programs);
});
