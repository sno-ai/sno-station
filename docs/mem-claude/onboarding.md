# Sno Memory for Claude Code — Onboarding

This walkthrough describes the public first-run experience for `@snoai/mem-claude`.

## Start setup

Requirements:

- Claude Code on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer
- `git` on your PATH (memory is scoped to the repository you work in)

Complete the [shared memory setup](../memory-setup.md), then install the Claude Code integration:

```bash
npm install -g @snoai/mem-claude@1.0.0
sno-mem-claude install --config-dir ~/.claude
```

The shared setup writes `<profile root>/settings.json`; the install command configures Claude Code.
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

Choose REM Enhanced to use the Sno GPU for the LoRA-covered extraction and conflict calls,
with your Claude Code covering the other model-assisted memory decisions. REM Enhanced needs a Sno GPU key in `snoGpu.apiKey` in `settings.json`.

## Step 2: accept or change the remaining defaults

The memory client uses these standard defaults:

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Scope | The current repository, plus a `global` scope readable everywhere |
| Embedder | Local |
| Ambient capture | On (every completed turn is captured) |
| Auto-recall | On (session start and every prompt) |
| Session handling | Local system session memory |
| Management tools | Off |
| Cloud observability | Off |

Mode-specific defaults are:

| Memory-writing call | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | Deterministic, verbatim | Your Claude Code | Sno extraction model |
| Classify active tasks | Keyword rules | Your Claude Code | Your Claude Code |
| Merge profile sections | Deterministic merge | Your Claude Code | Your Claude Code |
| Match completed tasks | Token overlap | Your Claude Code | Your Claude Code |
| Resolve conflicts | Keep both | Your Claude Code | Sno conflict model |
| Build reflection summary | No model reflection; local session memory remains | Same | Same |
| Resolve relative dates | No model call | Your Claude Code | Your Claude Code |

No memory-writing call is disabled in Agent Native or REM Enhanced. A failed model request
uses the corresponding Local First behavior for that request instead of switching model tiers.

In REM Enhanced, the selected mode fixes each model call's destination as shown above.

Two REM operations run over the store on a periodic trigger and route model calls by the selected
mode:

- `rem-update` rewrites transition narratives into clean current-state memories while keeping the
  history;
- `rem-replace` adjudicates contradictions across the store and soft-closes the losing memory
  reversibly.

Both are requested by default. Change `rem.operations` in `settings.json` to request one, or set
`rem.tick` to `false` to turn the trigger off.

The mode choice does not finalize retrieval or reranker behavior.

## Step 3: complete setup and verify

The `sno-mem-claude install` integration refresh command prints one `would write` line per planned file with `--dry-run`, and
`sno-mem-claude install complete` when it has written them. If the memory settings cannot be read, keep the existing file and its backup for key recovery; follow the shared setup only for a new profile.

The memory service starts on demand. The first hook or memory command after install
starts it and waits for it to be healthy.

Subagents and sessions outside a git repository inject and capture nothing. A session with
`sandbox.enabled: true` is unsupported: its memory commands cannot reach the local sidecar, so
turn the sandbox off or expect a failure line.

Open a new Claude Code session inside a git repository, then run:

```bash
sno-mem-claude doctor
```

The output has four lines:

```text
sidecar: healthy
hooks: SessionStart=present UserPromptSubmit=present Stop=present
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
sno-mem-claude remember "Prefer concise replies and tabs for indentation in this repository."
```

Then verify:

```bash
sno-mem-claude recall "indentation"
```

Turns you complete inside a Claude Code session are captured on their own after the session's `Stop`
hook fires; explicit commands are for facts you want stored right now.

Do not use temporary debug state, test output, or private infrastructure details as first memories.

## Non-interactive installs

The `sno-mem-claude install` integration refresh command never prompts, so it is safe in scripts. `--dry-run` prints every planned
write and changes nothing:

```bash
sno-mem-claude install --config-dir /absolute/path/to/claude-config --dry-run
```

It never guesses a credential, prints a secret, or exposes a private endpoint.

## Already installed

Running `sno-mem-claude install` again to refresh the integration is idempotent. It updates its own hook groups in place, keeps
foreign hook groups at their original position, keeps exactly one permission rule of its own,
rewrites its skill, and touches nothing else.

To change the memory mode, edit `settings.json` and keep the same store and encryption key.

Normal reinstall preserves the memory library.

## Supported surfaces

Linux CLI installation and hook failure paths have real receipts. macOS CLI and Desktop
local-session support are unverified until their receipts exist. Cloud, web, SSH-hosted sessions,
and the VS Code extension are not claimed.

## Onboarding acceptance checklist

Onboarding is complete when:

- the memory mode is recorded in `settings.json` and Local First is selected by the first-release setup;
- Local First completes without an LLM credential;
- Agent Native runs on the existing Claude Code subscription and collects no key;
- REM Enhanced explains the Sno-covered and Claude-covered work in public terms;
- the install command writes only its own entries and `--dry-run` changes nothing;
- `doctor` prints `healthy`, three `present` hooks, and a `present` permission rule after a new
  session;
- the user can create and verify a first memory;
- no secret, private hostname, internal path, or deployment instruction appears in the output.
