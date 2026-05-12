# @snoai/sno-observe

Host-side observability SDK for SNO agent events. It validates a closed event schema, redacts sensitive fields before hashing, writes an append-only SQLite buffer under `~/.sno`, and flushes Compact JSON v1 envelopes to `sno.ai`.

```ts
import { snoObserve } from "@snoai/sno-observe";

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
- `snoObserve.shouldSampleTool(eventId, toolName, rate)`
- `snoObserve.subscribe(handler)`
- `snoObserve.shutdown()`

Flat exports with the same names are also available for host integrations that prefer direct imports.
