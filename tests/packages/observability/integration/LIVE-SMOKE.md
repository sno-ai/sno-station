# Live-endpoint smoke (manual)

CI runs every test against the in-process `node:http` fixture server
(`tests/packages/sno-observe/fixtures/sno-ai-mock-server.mjs`) — the full
status-code matrix, retry/backoff, redact, chain, and consent paths are all
covered there with zero external dependencies.

Three tests are designed to *also* round-trip the real sno.ai endpoint when an
operator wants a manual smoke. They skip cleanly when the env vars below are
absent, so CI stays green by default:

| Test                                       | Task   | Purpose                              |
|--------------------------------------------|--------|--------------------------------------|
| `audit-verify-live-smoke.test.mjs`         | §26.1  | `audit.verify` round-trip            |
| `device-flow-fixture.test.mjs` (gated block) | §27.1 | anonymous `register()` happy path |
| `acceptance-live-smoke.test.mjs`           | §32.1  | Emit each of the 12 SDK event types  |

## How to run a manual live smoke

```sh
SNO_OBSERVE_LIVE_BASE_URL=https://sno.ai \
SNO_OBSERVE_LIVE_EVENT_ID=<known-event-id-or-omit> \
npm test
```

No account login or API key is required. `register()` creates `~/.sno/identity.json`
with a local `machine_secret`, sends only its SHA-256 hash to production, and
subsequent event/audit requests use `Authorization: Bearer <machine_secret>`.
