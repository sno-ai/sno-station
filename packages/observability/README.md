# @snoai/observability

A private record of what your agents did, kept on your machine.

When a plugin saves a memory or an agent runs a tool, this package writes it down. It scrubs secrets first and keeps the notes in a small local database under `~/.sno`. You decide how much leaves your machine: nothing, metadata only (what happened and when, which tool, never the text itself), or the full event details. Change it any time with `sno station telemetry consent set off`, `metadata-only` or `full`.

Most people never use this package directly. It comes with the Sno Station plugins. If you just want shared memory for your agents, start with the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md) and
install the plugin for your agent ([Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude),
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw)).

```bash
npm install @snoai/observability@1.2.0
```

Needs Node.js 22.14 or newer. The `sno` command can also append an event from a shell:
`sno observe append <event_type> --agent=<harness> --field=value`.
It returns as soon as the event is stored on your machine and prints `stored`; sending to sno.ai continues in a short background process, so a slow network never delays or loses the event.

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
