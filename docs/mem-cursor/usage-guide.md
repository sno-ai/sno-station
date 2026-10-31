# Sno Memory for Cursor — Usage Guide

This guide covers day-to-day memory behavior, commands, multi-root workspace handling, and troubleshooting for `@snoai/mem-cursor`.

For initial installation and verification, see the [Cursor Onboarding Guide](onboarding.md).

## Day-to-day memory behavior

Sno Memory integrates with both the Cursor desktop IDE and the Cursor CLI (`cursor-agent`), giving both environments shared, persistent project memory.

### How memory works in the IDE vs CLI

- **Cursor IDE**:
  - **At session start**: A short brief of key repository context, open tasks, and standing conventions is injected into the conversation. In the IDE app, the first chat of a new window gets the brief with its first prompt instead.
  - **On each user prompt**: Memory matching the prompt is retrieved and injected as reference data before the model responds.
  - **At turn completion**: The prompt and assistant response are queued; they are saved to memory when the conversation ends or after 30 quiet minutes. Empty or unfulfilled turns are skipped.
- **Cursor CLI (`cursor-agent`)**:
  - Non-interactive prompts (`cursor-agent -p`) receive the project brief at session initialization.
  - The CLI reads turns directly from the conversation transcript at each `stop` event and when the session ends.

A background worker processes captured turns asynchronously. Turns are flushed when a session ends or after 30 minutes of inactivity.

## The four memory commands

The installed Cursor skill (`~/.cursor/skills/sno-mem-cursor/SKILL.md`) teaches the Cursor agent four commands. You can also run them manually from your terminal inside the repository.

| Command | What it does | When to use |
| --- | --- | --- |
| `sno memory recall --harness cursor <query>` | Searches repository and global memory for relevant context | When researching a topic, checking past conventions, or answering a user question |
| `sno memory get --harness cursor <id>` | Prints the id and full text of one memory entry | When inspecting an entry referenced in search results or checking superseding records |
| `sno memory remember --harness cursor <text>` | Stores a new memory entry in the repository's store | When establishing a project rule, design decision, architecture constraint, or verified fact |
| `sno memory correct --harness cursor <id> <text>` | Stores a corrected entry and marks the previous entry superseded | When a decision changes or an existing memory is discovered to be inaccurate or outdated |

### How corrections supersede old memories

When `sno memory correct --harness cursor <id> <text>` runs:

1. A new memory entry is created with the updated text.
2. The old memory entry (`<id>`) is marked as superseded by the new record.
3. Automatic recall stops injecting the old entry. Explicit `recall` and `get` still show it, marked `retired; superseded by <id>`.

`correct` stores nothing, and says why, when the entry was already corrected or the new text is already stored.

## Multi-folder and workspace scoping

Automatic recall and capture are scoped to one repository, its top-level git root; explicit `recall` and `get` also search global memory:

- **Inside a git repository**: The top-level git root (`git rev-parse --show-toplevel`) is the project scope. All subdirectories within the repository share the same memory space.
- **Multiple folders open (multi-root workspace)**: When multiple workspace folders are open, the hooks use the repository containing the first workspace root. To interact with memory for another folder, navigate to that directory and execute explicit memory commands.
- **Outside a git repository**: Ambient capture and automatic recall are disabled. Explicit `sno memory` commands fallback to using the current working directory as the workspace scope.
- **Temporary directories**: Any path under the system temporary directory (`/tmp`, `/var/tmp`, or `os.tmpdir()`) is treated as a transient run: nothing is captured or recalled automatically there. Explicit `sno memory` commands still work.

## Operator commands and configuration

### Verification

Check integration status and hook registration at any time:

```bash
sno memory doctor --harness cursor
```

A healthy installation reports:
- `sidecar: healthy`
- `hooks: sessionStart=present beforeSubmitPrompt=present afterAgentResponse=present afterAgentThought=present stop=present preCompact=present sessionEnd=present`
- `permission rule: present`
- `IDE permission rule: present`

### Controlling automatic features

Settings are saved in `~/.sno/settings.json` (or under `SNO_PROFILE_DIR` if configured):

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `recall.auto` | boolean | `true` | Set to `false` to disable automatic injection of briefs and prompt-relevant memories |
| `capture.ambient` | boolean | `true` | Set to `false` to disable automatic background capture of conversation turns |

Explicit commands (`sno memory remember`, `sno memory recall`, etc.) remain fully functional even when automatic settings are disabled.

## Troubleshooting: What to check when memory seems missing

If memories are not being recalled or captured as expected, verify the following:

1. **Verify git repository root**:
   Ensure your conversation or terminal is open inside a git work tree. Ambient recall and capture intentionally do not run in non-git directories or temporary folders.
2. **Check the Cursor CLI login** (`cursor-agent login`):
   Background capture saves each finished turn through the Cursor CLI with your login. While you are logged out every save fails, and after three failed attempts the waiting turn is dropped. `sno memory doctor` does not check the login.
3. **Run `sno memory doctor --harness cursor`**:
   - If `sidecar` is `unavailable`, run any `sno memory recall --harness cursor <query>` inside the repository; explicit commands start it.
   - If any hook reports `absent`, re-run `sno setup --harness cursor` to regenerate missing hook entries.
   - If a file reports `unparsable`, the file could not be read as the JSON the installer expects (unreadable, invalid JSON, or an unexpected shape); check the corresponding file in `~/.cursor`.
4. **Inspect `hooks.json`**:
   Confirm that `~/.cursor/hooks.json` has an entry for each of the seven Cursor events, each running `'<path to sno>' memory hook <subcommand> --harness cursor`. Re-run `sno setup --harness cursor` instead of editing these entries by hand.
5. **Check recall query specifics**:
   `recall` looks for semantic and lexical relevance. If a query is overly generic, try searching with exact keywords from the original memory.
