# Tag Team user journeys

Run a single named journey from the Sno Station checkout. These tests launch real
Claude Code and Codex processes as the agents under test. They never invoke another
implementation orchestrator, modify product source, use live agent sessions, or push.

Requirements: current built Sno CLI, built Station packages, the skills source
checkout, tmux, Node, Python 3.11+, and existing logins for both installed agent CLIs.
`SNO_BINARY` defaults to the sibling `sno-cli-core/target/debug/sno`;
`SNO_SKILLS_SOURCE` defaults to the sibling `sno-station-skills-core` checkout.
The fixtures reuse `tests/apps/*/e2e-agent` and `tests/apps/reach/seats` conventions.
The tested packages are the source checkout's actual built packages, linked into a
private npm prefix. No fake `sno`, agent, mailbox, hook or recovery implementation
is supplied.

Codex agents reach the model through the local ccproxy at `http://localhost:8070/codex/v1`, the same path the owner's Codex uses.

```sh
python3 tests/e2e/tag-team/run.py pair --variant two-vendors
python3 tests/e2e/tag-team/run.py pair --variant claude-only
python3 tests/e2e/tag-team/run.py pair --variant codex-only

python3 tests/e2e/tag-team/run.py state --agent claude
python3 tests/e2e/tag-team/run.py state --agent codex
python3 tests/e2e/tag-team/run.py cursor-status

python3 tests/e2e/tag-team/run.py continuity --agent claude --variant resume
python3 tests/e2e/tag-team/run.py continuity --agent codex --variant resume
python3 tests/e2e/tag-team/run.py continuity --agent claude --variant compact
python3 tests/e2e/tag-team/run.py continuity --agent codex --variant compact

python3 tests/e2e/tag-team/run.py lesson --agent claude
python3 tests/e2e/tag-team/run.py lesson --agent codex

python3 tests/e2e/tag-team/run.py mailbox --agent claude --variant typing
python3 tests/e2e/tag-team/run.py mailbox --agent codex --variant typing
python3 tests/e2e/tag-team/run.py mailbox --agent claude --variant compact
python3 tests/e2e/tag-team/run.py mailbox --agent codex --variant compact
```

No `all` mode or automatic retry exists. Run each case once. After a test-code
repair, rerun only cases whose preparation or assertion failed. A passing case
is not rerun. Each invocation has a 295-second total deadline, including setup,
agent turns, observation and reporting. Each wait has a shorter explicit deadline.
For unknown timings, budget two to four minutes per case; inspect retained command
output before attributing a timeout to the product.

Every run prints a retained evidence directory containing `proof.json`, command
outputs, actual transcripts, terminal snapshots and provenance (host, agent
versions, selected Codex model and endpoint, package location, private sidecar).
Exit 0 means passed; 1 means failed; 2 means a required runtime/login is absent.
Credential copies are removed on exit. Only the private tmux server, private
Codex background processes and private profile's sidecar are stopped. Raw evidence stays outside the repository.

The candidate lesson is ordinary fixture data; acceptance and delivery use real
product commands and host hooks. Follow-up prompts never repeat its advice.
Continuity requires the agent itself to create its task brief, then a real
interruption/native recovery or actual `/compact`. The harness never supplies a
missing continuity instruction or calls a synthetic host hook.

Mailbox calls carry long content whose exact bytes are checked in the recipient's
real mailbox. An unfinished draft must survive notification. After typing or
compaction, the receiver gets only an ordinary inbox cue, without the payload or
expected result. It must read mail and produce the content-derived file and reply.

The status tests require an actual permission prompt, an unchanged filesystem
before approval, a matching JSON view, the installed status-line command, and the
full-screen view. After approval the command must write its file and the agent
must appear finished. The additional Cursor case checks actual Claude and Cursor interactive
status lines while both native agents wait for permission; Cursor removes HTTP proxy variables,
as the existing Cursor E2E helper does.

For optional Hermes/OpenClaw coverage, discover only hosts listed in
`~/.config/sno-release/test-hosts`. A reachable host without either CLI does not
prove those integrations work. Record unavailable hosts and installations in the
results; never use the owner's active remote sessions or restart a gateway.
