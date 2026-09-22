# Sno Memory for OpenClaw

Long-term memory for [OpenClaw](https://github.com/openclaw/openclaw) agents.

Sno Memory captures useful facts, preferences, decisions, and lessons so an agent can carry
context across sessions. You choose how memory-writing decisions are made: entirely locally,
with the host agent's model, or with Sno's memory-specialized models plus the host model.

## Quickstart

Requirements:

- OpenClaw on your PATH
- Node.js 22.22.3 or newer on the 22 line, 24.15.0 or newer on the 24 line, or 25.9.0 or newer

Run the guided installer:

```bash
npx @snoai/mem-claw@next
```

The wizard asks for the memory profile, the embedder, and the memory mode, then collects only the
credentials that mode needs. It writes the plugin configuration and prints the gateway restart
command.

After restart, verify the installation:

```text
/memory status
```

Then give the agent a useful preference to remember:

```text
Remember that I prefer tabs for indentation.
```

Check that memory was created:

```text
/memory stats
```

OpenClaw's native installer is also supported:

```bash
openclaw plugins install @snoai/mem-claw@next
npx @snoai/mem-claw@next --configure
```

The package published to npm is the supported public install source. A source checkout, private
deployment host, or manual file copy is not required.

## Choose a memory mode

The mode controls memory writes. It does not create separate subscription and API-key variants:
those are two ways for Agent Native to reach the same host-model routing.

| Mode | Default behavior | Credentials | Best for |
| --- | --- | --- | --- |
| **Local First** | Deterministic verbatim capture; content-hash deduplication; deterministic profile and task handling | None | Fully local operation and predictable zero-LLM behavior |
| **Agent Native** | Uses the host agent's own model for memory extraction and all other model-assisted write decisions | Existing host subscription when available; otherwise your API key | Users who want the host model to handle memory inline |
| **REM Enhanced** | Uses the Sno GPU for the LoRA-covered extraction and conflict occasions, and the host model for the remaining model-assisted write decisions | Sno access plus host-model access | Highest memory-specific assistance |

Agent Native is the default.

### Local First

Local First makes no LLM calls. It captures useful user content with rules and verbatim slices,
removes exact duplicates by content hash, and uses deterministic behavior for profile updates and
task matching. When two memories conflict, both remain available instead of asking a model to
replace one. It does not generate a model-written reflection summary, and it resolves relative
dates without a model.

Memory processing remains local. The default local embedder may be downloaded on first use; after
it is cached, Local First does not need a network service.

```bash
npx @snoai/mem-claw@next --configure --mode local-first
```

### Agent Native

Agent Native uses the model already configured for the OpenClaw agent. During guided setup, the
installer first checks for a usable host subscription. If it finds one, setup completes without a
new key. If it does not, the wizard asks for a key provider (OpenAI or OpenRouter) and the key.

Subscription and bring-your-own-key setup have identical memory routing. They differ only in how
the plugin reaches the model. The subscription transport runs extraction only; the model-written
reflection summary (LLM mode `extraction+reflection`) is available with your own key or in REM
Enhanced. Memory calls run inline.

```bash
npx @snoai/mem-claw@next --configure --mode agent-native
```

### REM Enhanced

REM Enhanced uses the Sno GPU for the two occasions covered by memory-specialized models:

- memory extraction uses the Sno extraction model;
- conflict adjudication uses the memory conflict model.

The host agent's model handles active-task classification, profile merging, completed-task
matching, reflection summaries, and relative-date resolution. If a model call fails, that request
falls back to the corresponding Local First behavior; it does not silently switch to another model
tier.

```bash
npx @snoai/mem-claw@next --configure --mode rem-enhanced
```

## Per-mode defaults

| Memory-writing occasion | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | Deterministic, verbatim | Host model | Sno extraction model |
| Classify active tasks | Keyword rules | Host model | Host model |
| Merge profile sections | Deterministic merge | Host model | Host model |
| Match completed tasks | Token overlap | Host model | Host model |
| Resolve conflicts | Keep both memories | Host model | Sno conflict model |
| Build reflection summary | No model reflection; local session memory remains | Host model, key transport only | Host model |
| Resolve relative dates | No model call | Host model | Host model |

No occasion is disabled in Agent Native or REM Enhanced. Each model-assisted request either runs
inline or falls back to the matching Local First behavior for that request. In REM Enhanced, each
occasion's tier is a switch under `remEnhanced.occasions`; the table shows the defaults.

Two REM operations run over the store on a periodic trigger and use the Sno models in every mode:
`rem-update` rewrites transition narratives into current-state memories and keeps the history;
`rem-replace` adjudicates contradictions across the store and soft-closes the loser reversibly. The
installer requests both by default; pass `--rem-operations rem-update` or
`--rem-operations rem-replace` to request one, and set `remEnhanced.trigger.tick` to `false` to
turn the trigger off.

Retrieval and reranking are not mode-selection promises and are intentionally not described as
final behavior here.

## Onboarding defaults

The guided installer uses these defaults unless you change them:

- memory mode: Agent Native;
- memory profile: `local-active` (active capture and recall);
- embedder: local;
- reranking: local lightweight processing;
- recall depth: Default;
- session handling: local system session memory;
- management tools: off;
- cloud observability: off unless you explicitly enable it.

Run setup again at any time:

```bash
npx @snoai/mem-claw@next --configure
```

View the current setup without changing it:

```bash
npx @snoai/mem-claw@next --status
```

See the full [onboarding walkthrough](https://github.com/sno-ai/sno-station/blob/main/docs/mem-claw/onboarding.md) and
[usage guide](https://github.com/sno-ai/sno-station/blob/main/docs/mem-claw/usage-guide.md).

## Day-to-day commands

Use these commands in OpenClaw chat:

| Command | Purpose |
| --- | --- |
| `/memory status` | Show memory counts, the store path, and the sidecar process id |
| `/memory stats` | Show memory counts by scope and category |
| `/memory search <query>` | Search memory explicitly |
| `/memory clear --yes --scope <scope>` | Delete memories in one scope |

From the terminal, `openclaw sno-mem` offers `list`, `search`, `stats`, `delete`, `export`, and
`import`.

The agent can use `memory_recall`, `memory_store`, `memory_update`, and `memory_forget`.
`memory_stats` and `memory_list` are management tools, off by default and enabled with
`enableManagementTools: true` in the plugin configuration.

To stop automatic capture without uninstalling, switch the memory profile:

```bash
npx @snoai/mem-claw@next --configure --memory-profile manual-only
```

## Read a memory store

The package ships `sno-memdump`. It prints memory rows as JSON Lines without changing the
encrypted source store:

```bash
npx --package @snoai/mem-claw@next sno-memdump --db ~/.openclaw/mem-claw/mem-claw.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>] [--metadata]
```

## Privacy and network behavior

- Memory data is stored in encrypted local SQLite storage.
- Local First does not send memory text to an LLM service.
- Agent Native sends model-assisted memory work through the host-model transport selected during
  onboarding.
- REM Enhanced sends only its covered memory operations through Sno and uses the host model for the
  remaining model-assisted operations.
- Raw memory content is not included in cloud observability unless the user explicitly selects a
  consent level that permits it.
- Keys entered in the wizard are stored in the plugin's onboarding env file (mode 0600) and a
  systemd user drop-in for the gateway, never in the committed OpenClaw configuration.

## Reinstall and data safety

Normal plugin uninstall or reinstall does not erase the memory library. To reinstall:

```bash
openclaw plugins uninstall sno-mem-claw
openclaw plugins install @snoai/mem-claw@next
```

Changing the embedding model or vector dimensions is different: existing vectors cannot be mixed
with a new dimension. Stop OpenClaw and use the provided embedder reset command only when you
intentionally want to rebuild the memory database:

```bash
openclaw sno-mem-config embedder wipe-db --confirm --force
```

This operation deletes memory data. Back up anything you need before running it.

## License

Licensed under [Apache-2.0](LICENSE).

### Sidecar availability

The loopback sidecar serves unregistered skins with installed defaults and does not enforce
bearer-token, kill-switch, storage-failure-latch or startup-integrity admission. Errors are
logged per operation. The plugin retries registration after connection failure and after
sidecar restart.
