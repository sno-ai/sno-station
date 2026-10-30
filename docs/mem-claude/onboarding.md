# Sno Memory for Claude Code — Onboarding

This walkthrough describes the public first-run experience for `@snoai/mem-claude`.

## Start setup

Requirements:

- Claude Code on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer
- `git` on your PATH (memory is scoped to the repository you work in)

Complete the [memory service setup](../memory-setup.md), then install the Claude Code integration:

```bash
curl -fsSL https://sno.ai/install | sh
```

The memory service setup writes `<profile root>/settings.json`; the install command configures Claude Code.
The profile root is `SNO_PROFILE_DIR` or `~/.sno`. Keep a private backup of the
settings file because it holds the only key for the encrypted store.

## Step 1: choose the memory mode

The first-release setup selects Local First in `<profile root>/settings.json`
(the profile root is `SNO_PROFILE_DIR` or `~/.sno`). If you change the mode manually,
keep the existing `store.path` and `store.encryptionKey`; replacing the key makes existing
memories unreadable. Keep a private backup of `settings.json`.

### Local First

Choose Local First for fully local memory behavior:

- deterministic, verbatim capture of your turns;
- deterministic profile and task handling;
- no model-written reflection summary;
- no LLM credentials.

The default embedder is local. It may download its model once on first use, then runs from the
local cache.

### Agent Native

Choose Agent Native to use your own Claude Code as the memory model.

The capture worker runs `claude -p` as a single-turn child with hooks disabled, no tools, no
settings, and no session persisted, on your existing Claude Code subscription. No API key is
collected and no key is stored. Every model-assisted memory decision goes through that child
process.

### REM Enhanced

REM is how your agents dream: overnight they strengthen their memory and settle what they learned. It runs at most once a day for each part of your memory: usually overnight, or earlier the same day once about 100 new memories have piled up. REM Enhanced lets Sno's own memory models help with the two hardest jobs: writing down what matters from a conversation, and deciding which of two memories that disagree is right. Your Claude Code does the rest, including filling in each memory's details and checking who it is about. It needs a Sno key in `snoGpu.apiKey` in `settings.json`.

**Your data stays yours.** In this mode the memory text for the Sno calls, and the lessons your agents learn, go to your own space in Sno's cloud. It works like your own cloud drive: everything in it is yours, and a Sno program processes it for you alone. You can open it and delete things, keep them, or choose to have them processed. Nothing is deleted automatically, and Sno does not give any of it to anyone.

## Step 2: accept or change the remaining defaults

The memory client uses these standard defaults:

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Scope | The current repository, plus a `global` scope readable everywhere |
| Embedder | Local |
| Ambient capture | On (a session is captured once it has been quiet for 30 minutes or has ended) |
| Auto-recall | On (session start and every prompt) |
| Session handling | Local system session memory |
| Management tools | Off |
| Cloud observability | Off |

Mode-specific defaults are:

| What it does | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Writing down what matters | Saved word for word | Your Claude Code | Sno's memory model writes it down; your Claude Code fills in the details and checks who it is about |
| Knowing what task you are on | Simple keyword matching | Your Claude Code | Your Claude Code |
| Updating what it knows about you | Fixed rules | Your Claude Code | Your Claude Code |
| Spotting finished tasks | Word matching | Your Claude Code | Your Claude Code |
| Settling memories that disagree | Keep both | Your Claude Code | Sno's memory model |
| Ranking what to recall | On your machine | On your machine | On your machine |
| Summing up the day | No model reflection; local session memory remains | Same | Same |
| Turning "tomorrow" into a date | No model call | Your Claude Code | Your Claude Code |

No memory-writing call is disabled in Agent Native or REM Enhanced. A Sno model call that is refused, for example because your weekly allowance is used up, is answered by your own agent's model; if that also fails, that request uses the Local First behavior.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

REM also tidies your memory on a schedule, in two ways:

- It rewrites "I used to... then I changed..." stories into one clean, current memory, and keeps the history.
- It settles memories that contradict each other. The one that lost is retired, and you can bring it back.

Both run by default. To run only one, change `rem.operations` in `settings.json`. To turn REM's schedule off, set `rem.tick` to `false`.

Mode selection governs memory writing and maintenance. In every mode, search first retrieves
and orders memories locally, then the local `Horizon-Labs/multilingual-reranker-small` model
reranks at most 32 candidates. Reranking never uses Sno GPU. Set `rerank.mode` to `none`
to keep the initial ranking without the model. If the model is loading, fails or times out,
search uses the initial ranking. Other memory-writing, REM and Self Learning destinations
remain mode-dependent.

## Step 3: complete setup and verify

`sno setup --harness claude` installs the hook groups, the permission rule and the skill and prints one row per step. If the memory settings cannot be read, keep the existing file and its backup for key recovery; follow the memory service setup only for a new profile.

The memory service starts on demand. The first hook or memory command after install
starts it and waits for it to be healthy.

Subagents and sessions outside a git repository inject and capture nothing. A session with
`sandbox.enabled: true` is unsupported: its memory commands cannot reach the local memory service, so
turn the sandbox off or expect a failure line.

Open a new Claude Code session inside a git repository, then run:

```bash
sno memory doctor --harness claude
```

The output has four lines:

```text
sidecar: healthy
hooks: SessionStart=present UserPromptSubmit=present Stop=present SessionEnd=present PreToolUse=present PostToolUse=present
permission rule: present
import receipts: "/absolute/path/to/repository"=present
```

The import receipt names the repository you just opened; its Claude Code memory notes were
imported on that first session start.

## Step 4: create the first useful memory

Start with information that will help every day:

- preferred language and tone;
- coding and review preferences;
- project rules;
- package-manager rules;
- preferred tools or commands;
- actions the agent should not repeat.

Store it explicitly from the repository root:

```bash
sno memory remember --harness claude "Prefer concise replies and tabs for indentation in this repository."
```

Then verify:

```bash
sno memory recall --harness claude "indentation"
```

Turns you complete inside a Claude Code session are captured on their own, all at once, after the session
has been quiet for 30 minutes or has ended; explicit commands are for facts you want stored right now.

Do not use temporary debug state, test output, or private infrastructure details as first memories.

## Non-interactive installs

`sno setup --harness claude` never prompts, so it is safe in scripts. `--json` prints one JSON value instead of rows:

```bash
sno setup --harness claude --json
```

It never guesses a credential, prints a secret, or exposes a private endpoint.

## Already installed

Running `sno setup --harness claude` again to refresh the integration is idempotent. It updates its own hook groups in place, keeps
foreign hook groups at their original position, keeps exactly one permission rule of its own,
rewrites its skill, and touches nothing else.

To change the memory mode, edit `settings.json` and keep the same store and encryption key.

Normal reinstall preserves the memory library.

## Supported surfaces

Linux CLI installation and hook failure paths have real receipts. macOS CLI and Desktop
local-session support are untested. Cloud, web, SSH-hosted sessions, and the VS Code extension
are not covered.

## Onboarding acceptance checklist

Onboarding is complete when:

- the memory mode is recorded in `settings.json` and Local First is selected by the first-release setup;
- Local First completes without an LLM credential;
- Agent Native runs on the existing Claude Code subscription and collects no key;
- REM Enhanced explains the Sno-covered and Claude-covered work in public terms;
- the install command writes only its own entries and `--dry-run` changes nothing;
- `doctor` prints `healthy`, six `present` hooks, and a `present` permission rule after a new
  session;
- the user can create and verify a first memory;
- no secret, private hostname, internal path, or deployment instruction appears in the output.
