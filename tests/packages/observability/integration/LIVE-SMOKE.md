# Live-endpoint smoke (manual)

Pre-launch: sno.ai is one deployment, no separate "staging" environment. CI
runs every test against the in-process `node:http` fixture server
(`tests/packages/sno-observe/fixtures/sno-ai-mock-server.mjs`) — the full
status-code matrix, retry/backoff, redact, chain, and consent paths are all
covered there with zero external dependencies.

Three tests are designed to *also* round-trip the real sno.ai endpoint when an
operator wants a manual smoke. They skip cleanly when the env vars below are
absent, so CI stays green by default:

| Test                                  | Task   | Purpose                              |
|---------------------------------------|--------|--------------------------------------|
| `audit-verify-staging.test.mjs`       | §26.1  | `audit.verify` round-trip            |
| `device-flow-fixture.test.mjs` (gated block) | §27.1 | `register()` happy path        |
| `staging-acceptance.test.mjs`         | §32.1  | Emit each of the 12 SDK event types  |

## How to run a manual live smoke

```sh
SNO_OBSERVE_LIVE_BASE_URL=https://www.sno.ai \
SNO_API_KEY=$(cat ~/.sno/state/apikey) \
SNO_OBSERVE_STAGING_EVENT_ID=<known-event-id-or-omit> \
npm test
```

`SNO_API_KEY` is only needed for `audit.verify` (see
`sno-ai-api-contract.md` §6.1 — Bearer is rejected on that endpoint). For
`emit` / `register`, no auth is needed at the rule-1/2 default; rule-5/6 bearer
attaches automatically when `register()` has populated `~/.sno/state/tokens.json`.

## Why no separate staging env

The original design split `SNO_OBSERVE_STAGING_BASE_URL` +
`SNO_OBSERVE_STAGING_BEARER` to mirror a published staging job. Two things made
that over-engineering at this milestone:

1. **No production yet** — there is no live data to protect from test traffic.
2. **`STAGING_BEARER` was wrong** — the audit endpoint takes an API key, not
   a bearer (`sno-ai-api-contract.md` §6.1).

Collapsing to one env (`SNO_OBSERVE_LIVE_BASE_URL`) plus the standard
`SNO_API_KEY` removes the misleading auth field and matches how operators run
`sno doctor` / `sno audit verify` in normal use.
