# Sno Memory for OpenClaw

Long-term memory for [OpenClaw](https://github.com/openclaw/openclaw) agents.

Sno Memory captures useful facts, preferences, decisions, and lessons so an agent can carry
context across sessions. You choose how memory-writing decisions are made: entirely locally,
with the host agent's model, or with Sno's memory-specialized models plus the host model.

## Quickstart

Requirements:

- OpenClaw
- Node.js 22.14 or newer

Run the guided installer:

```bash
npx @snoai/mem-claw
```

The wizard asks for the memory mode first. It then writes the plugin configuration and tells you
whether OpenClaw must be restarted.

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
openclaw plugins install @snoai/mem-claw
npx @snoai/mem-claw --configure
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

Local First is the zero-configuration default.

### Local First

Local First makes no LLM calls. It captures useful user content with rules and verbatim slices,
removes exact duplicates by content hash, and uses deterministic behavior for profile updates and
task matching. When two memories conflict, both remain available instead of asking a model to
replace one. It does not generate a model-written reflection summary.

Memory processing remains local. The default local embedder may be downloaded on first use; after
it is cached, Local First does not need a network service.

```bash
npx @snoai/mem-claw --configure --mode local-first
```

### Agent Native

Agent Native uses the model already configured for the OpenClaw agent. During guided setup, the
installer first checks for a usable host subscription. If it finds one, setup completes without a
new key. If it does not, the wizard asks for an API key.

Subscription and bring-your-own-key setup have identical memory routing. They differ only in how
the plugin reaches the model. Memory calls run inline now; an asynchronous queue is a later
resilience improvement, not a requirement for enabling Agent Native.

```bash
npx @snoai/mem-claw --configure --mode agent-native
```

### REM Enhanced

REM Enhanced uses the Sno GPU for the two occasions covered by memory-specialized models:

- memory extraction uses independent episodic and profile extraction routes;
- conflict adjudication uses the memory conflict model.

The host agent's model handles semantic deduplication, active-task classification, profile merging,
completed-task matching, and reflection summaries. If a model call fails, that request falls back
to the corresponding Local First behavior; it does not silently switch to another model tier.

```bash
npx @snoai/mem-claw --configure --mode rem-enhanced
```

## Per-mode defaults

| Memory-writing occasion | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | Deterministic, verbatim | One host-model extraction call | Sno episodic and profile extraction |
| Decide duplicate or new | Content hash | Host model | Host model |
| Classify active tasks | Keyword rules | Host model | Host model |
| Merge profile sections | Deterministic merge | Host model | Host model |
| Match completed tasks | Token overlap | Host model | Host model |
| Resolve conflicts | Keep both memories | Host model | Sno conflict model |
| Build reflection summary | No model reflection; local session memory remains | Host model | Host model |
| Classify query intent | Local embedder | Local embedder | Local embedder |

No occasion is disabled in Agent Native or REM Enhanced. Each model-assisted request either runs
inline or falls back to the matching Local First behavior for that request.

Query-intent classification stays on the local embedder in every mode. Retrieval and reranking are
not mode-selection promises and are intentionally not described as final behavior here.

## Onboarding defaults

The guided installer uses these defaults unless you change them:

- memory mode: Local First;
- memory profile: active capture and recall;
- embedder: local;
- reranking: local lightweight processing;
- session handling: local system session memory;
- cloud observability: off unless you explicitly enable it.

Run setup again at any time:

```bash
npx @snoai/mem-claw --configure
```

View the current setup without changing it:

```bash
npx @snoai/mem-claw --status
```

See the full [onboarding walkthrough](../../docs/mem-claw/onboarding.md) and
[usage guide](../../docs/mem-claw/usage-guide.md).

## Day-to-day commands

Use these commands in OpenClaw chat:

| Command | Purpose |
| --- | --- |
| `/memory status` | Show whether memory is active |
| `/memory stats` | Show memory counts |
| `/memory search <query>` | Search memory explicitly |
| `/memory pause` | Pause memory hooks and tools |
| `/memory resume` | Resume memory hooks and tools |
| `/memory clear --yes --scope <scope>` | Delete memories in one scope |

The agent can also use `memory_recall`, `memory_store`, `memory_update`, and `memory_forget` when
those tools are enabled. Management tools are disabled by default and can be enabled in plugin
configuration.

## Read a memory store

Install the external `sno` subcommand on your PATH with:

```bash
npm install -g @snoai/mem-claw
```

Then print memory rows as JSON Lines without changing the encrypted source store:

```bash
sno memdump --db /path/to/mem-claw.sqlite [--scope <scope>] [--id <id>] [--grep <text>] [--limit <n>]
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
- Do not put API keys in committed configuration files. Use the secret mechanism recommended by
  your OpenClaw installation.

## Reinstall and data safety

Normal plugin uninstall or reinstall does not erase the memory library. To reinstall:

```bash
openclaw plugins uninstall sno-mem-claw
openclaw plugins install @snoai/mem-claw
```

Changing the embedding model or vector dimensions is different: existing vectors cannot be mixed
with a new dimension. Stop OpenClaw and use the provided embedder reset command only when you
intentionally want to rebuild the memory database:

```bash
openclaw sno-mem-config embedder wipe-db --confirm --force
```

This operation deletes memory data. Back up anything you need before running it.

## License

Licensed under [FSL-1.1-ALv2](LICENSE).
