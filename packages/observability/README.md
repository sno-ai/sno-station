# @snoai/observability

Local, redacted usage events for Sno Station, buffered on your machine and delivered only if you
turn delivery on.

Agent plugins can record what happened (a memory was written, a tool was called) as events in a
closed schema. This package validates each event, redacts sensitive fields before hashing,
appends it to a local SQLite buffer under `~/.sno`, and, when delivery is enabled, flushes
Compact JSON v1 envelopes to `sno.ai`. The shared memory setup turns delivery off
(`telemetry.observe.enabled` is `false`), so a default install keeps every event on your machine.

Who it is for: the Sno Station packages and anyone integrating a host agent. If you only want
shared agent memory, follow the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md) and
install the plugin for your agent ([Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude),
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw)).

```bash
npm install @snoai/observability@1.0.1
```

Needs Node.js 22.14 or newer. The package also installs a `sno-observe` command
(`sno-observe append <event_type> --agent=<harness> --field=value`) for appending an event from
a shell.

```ts
import { snoObserve } from "@snoai/observability";

await snoObserve.emit({
	event_type: "memory.write",
	agent_id: "codex",
	payload: {
		key_hash: "sha256-post-redaction",
		byte_len: 42,
		content_tokens: 12,
		tokens_method: "fast",
	},
});
await snoObserve.flush({ force: true });
```

## Runtime Files

- `~/.sno/identity.json`: anonymous CUID2 user id, UUID v7 machine id, and local
  machine secret.
- `~/.sno/buffer.db`: SQLite event buffer and local hash-chain tails.
- `~/.sno/state/consent.json`: current consent value, defaulting to `metadata-only`.
- `~/.sno/redaction-rules.txt`: optional newline-separated regexes for extra redaction.

Tests and non-default profiles can override paths with `SNO_PROFILE_DIR`,
`SNO_IDENTITY_PATH`, `SNO_BUFFER_PATH`, and `SNO_CONSENT_PATH`.

## Consent

Consent values are `off`, `metadata-only`, and `full`. `off` keeps emitted events local and terminal; resuming does not back-ship off-period rows. Consent changes emit a `consent.change` audit event and start a new hash-chain epoch with `agent.identify`.

## API

- `snoObserve.emit(event)`
- `snoObserve.flush({ force })`
- `snoObserve.consent.get()` / `snoObserve.consent.set(value, reason)`
- `snoObserve.observe.pause()` / `resume()` / `export({ path, format })`
- `snoObserve.register()`
- `snoObserve.audit.verify(eventId)`
- `snoObserve.doctor()`
- `snoObserve.subscribe(handler)`
- `snoObserve.shutdown()`

Flat exports with the same names are also available for host integrations that prefer direct imports.
