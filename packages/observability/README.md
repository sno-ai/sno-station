# @snoai/observability

A private record of what your agents did, kept on your machine.

When a plugin saves a memory or an agent runs a tool, this package writes it down. It scrubs secrets first and keeps the notes in a small local database under `~/.sno`. You decide how much leaves your machine: nothing, metadata only (what happened and when, which tool, never the text itself), or the full event details. Change it any time with `sno station consent off`, `metadata-only` or `full`.

Most people never use this package directly. It comes with the Sno Station plugins. If you just want one memory for your agents, start with the
[memory service setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md) and
install the plugin for your agent ([Codex](https://www.npmjs.com/package/@snoai/mem-codex),
[Claude Code](https://www.npmjs.com/package/@snoai/mem-claude),
[OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw)).

```bash
npm install @snoai/observability@1.2.1
```

Needs Node.js 22.14 or newer. The `sno` command can also append an event from a shell:
`sno observe append <event_type> --agent=<agent> --field=value`.
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

### Remote diagnostic logging

Detailed operational logs default to `debug`. The event server can return this optional
field in a successful response from `POST /api/v1/events`:

```json
{"receipt_id":"accepted-event-id","logging":{"level":"info"}}
```

`info` stops debug messages while retaining ordinary operation records, warnings and
errors. Return `debug` to enable detailed logs again. Only those two values are accepted.
This setting does not change memory event recording, content previews, evaluation
traces, or upload consent.

The receiver updates the current process immediately and saves only `logging.level`
in the existing profile's `settings.json`, preserving its other fields. Restarted
clients use the saved setting. Other running processes apply it when they receive
the same server setting through their own upload response, or when they restart.
The server should include its current choice in every successful event response.
Without a setting in the response, the client keeps its current choice. Offline
clients receive changes on their next successful upload; there is no automatic
three-month expiry or separate polling connection.

A settings-write failure is logged and does not turn an accepted upload into a
retry; the new level still applies to the receiving process. The server response
field is the integration contract; an operator dashboard and server-side rollout
are not provided by this package.

### Methods

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
