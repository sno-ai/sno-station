# Sno Memory for Codex CLI — Onboarding

This walkthrough describes the public first-run experience for `@snoai/mem-codex`.

## Start setup

Requirements:

- Codex CLI on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer
- `git` on your PATH (memory is scoped to the repository you work in)

Complete the [shared memory setup](../memory-setup.md), then install the Codex integration:

```bash
npm install -g @snoai/mem-codex@1.0.1
sno setup --harness codex
```

The shared setup writes `<profile root>/settings.json`; the install command configures Codex.
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

Choose Agent Native to use your own Codex CLI as the memory model.

The capture worker runs `codex exec` in an ephemeral, read-only, hooks-disabled session on your
existing Codex subscription. No API key is collected and no key is stored. Every model-assisted
memory decision goes through that child process.

### REM Enhanced

Choose REM Enhanced to use the Sno GPU for the LoRA-covered extraction and conflict calls,
with your Codex CLI covering the other model-assisted memory decisions. REM Enhanced needs a Sno GPU key in `snoGpu.apiKey` in `settings.json`.

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
| Capture memories | Deterministic, verbatim | Your Codex CLI | Sno extraction model |
| Classify active tasks | Keyword rules | Your Codex CLI | Your Codex CLI |
| Merge profile sections | Deterministic merge | Your Codex CLI | Your Codex CLI |
| Match completed tasks | Token overlap | Your Codex CLI | Your Codex CLI |
| Resolve conflicts | Keep both | Your Codex CLI | Sno conflict model |
| Build reflection summary | No model reflection; local session memory remains | Same | Same |
| Resolve relative dates | No model call | Your Codex CLI | Your Codex CLI |

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

`sno setup --harness codex` installs the hooks, trust entries, rules file and skill and prints one row per step. It then queues your existing Codex
memory notes for import; the capture worker feeds them to the store in the background. If the
notes cannot be queued, it prints that the import is deferred and the installation stays active.

The memory service starts on demand. The first hook or memory command after install
starts it and waits for it to be healthy.

Open a new Codex session inside a git repository, then run:

```bash
sno memory doctor --harness codex
```

The output has four lines:

```text
sidecar: healthy
hook trust: SessionStart=trusted-current UserPromptSubmit=trusted-current Stop=trusted-current SessionEnd=trusted-current PreToolUse=trusted-current PostToolUse=trusted-current
rules: present
import receipts: 2
```

`import receipts` counts the import records on disk. The first is written by `install` for your user-level Codex notes, so right after install it shows `1`. The second appears when the first session starts in a repository (one more for each further repository), so after you open your first repository it shows `2`.

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
sno memory remember --harness codex "Prefer concise replies and tabs for indentation in this repository."
```

Then verify:

```bash
sno memory recall --harness codex "indentation"
```

Turns you complete inside a Codex session are captured on their own after the session's `Stop`
hook fires; explicit commands are for facts you want stored right now.

Do not use temporary debug state, test output, or private infrastructure details as first memories.

## Non-interactive installs

`sno setup --harness codex` never prompts, so it is safe in scripts. `--json` prints one JSON value instead of rows:

```bash
sno setup --harness codex --json
```

It never guesses a credential, prints a secret, or exposes a private endpoint.

## Already installed

Running `sno setup --harness codex` again to refresh the integration is idempotent. It updates its own hook entries in place, keeps
foreign hook entries at their original position, rewrites its trust entries, rules file, and
skill, and touches nothing else.

To change the memory mode, edit `settings.json` and keep the same store and encryption key.

Normal reinstall preserves the memory library.

## Onboarding acceptance checklist

Onboarding is complete when:

- the memory mode is recorded in `settings.json` and Local First is selected by the first-release setup;
- Local First completes without an LLM credential;
- Agent Native runs on the existing Codex subscription and collects no key;
- REM Enhanced explains the Sno-covered and Codex-covered work in public terms;
- the install command writes only its own entries and `--dry-run` changes nothing;
- `doctor` prints `healthy`, six `trusted-current` hooks, and `present` rules after a new session;
- the user can create and verify a first memory;
- no secret, private hostname, internal path, or deployment instruction appears in the output.
