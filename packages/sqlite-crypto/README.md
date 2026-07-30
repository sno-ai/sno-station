# `@snoai/sno-station-core-crypto`

Local AES-256 encryption layer for SNO Station Core SQLite databases. Thin first-party wrapper over vetted libraries: `better-sqlite3-multiple-ciphers` (SQLCipher v4 mode), `@napi-rs/keyring`, `argon2`, and Node's built-in `crypto`.

The full threat model, explicit provisioning rules, and key-custody caveats live in [`docs/security.md`](../../docs/security.md).

---

## Install

```sh
npm install @snoai/sno-station-core-crypto
```

Node 22+ required (production AND development).

---

## Public API

### Database

```ts
import { getDek, getDekSync, openEncryptedDb } from "@snoai/sno-station-core-crypto";

// async — supports passphrase mode (interactive prompt) and keychain
const dek = await getDek();
const db = openEncryptedDb("/path/to/store.db", dek);

// sync — for entry points that cannot await (e.g. plugin register())
// throws on passphrase mode (which inherently requires async prompt)
const dekSync = getDekSync();
```

`openEncryptedDb` returns a `better-sqlite3-multiple-ciphers` `Database` handle preconfigured for SQLCipher v4 with the DEK applied. Wrong-key reads throw `WrongKeyError`. The first open of a fresh DB transparently registers it in the manifest at `~/.config/sno-station-core/dbs.json`.

### Passphrase mode (opt-in)

```ts
import { setPassphrase, removePassphrase } from "@snoai/sno-station-core-crypto";

await setPassphrase(Buffer.from("your-passphrase", "utf8"));
// later — revert to keychain / file-fallback
await removePassphrase(Buffer.from("your-passphrase", "utf8"));
```

Both functions take `Buffer` (not `string`) so callers can zero-fill the buffer after use. They implement two-phase commit with mid-flight crash recovery; see the spec for the state machine.

### `.sno-station-core` export / import

```ts
import { exportEncrypted, importEncrypted } from "@snoai/sno-station-core-crypto";

await exportEncrypted("backup.sno-station-core");          // gzip-tar all manifest DBs + AES-256-GCM
await importEncrypted("backup.sno-station-core");           // verify header + decrypt + restore
```

Layered import error contract:

1. `InvalidExportFormat` / `UnsupportedExportVersion` — structural gates (magic, version) before any AEAD work.
2. `ForeignDekError` — DEK fingerprint mismatch (computed BEFORE `decipher.final()`); message references the v1.1 `--import-dek` recovery path.
3. `IntegrityCheckFailed` — GCM auth failure (the path that catches all meaningful header tampering, since the entire 12-byte header is bound as AAD).

---

## CLI

The package ships a `sno-station-core` binary:

```sh
sno-station-core lock --provision-key             # explicitly create the one durable key
sno-station-core lock --restore-key <path>        # restore a missing primary from an operator-held copy
sno-station-core lock --status                    # mode + 8-char fingerprint + manifest health
sno-station-core lock --set-passphrase            # upgrade to passphrase mode (two prompts)
sno-station-core lock --remove-passphrase         # revert to keychain / file-fallback
sno-station-core lock --rebuild-manifest [paths]  # rebuild dbs.json with per-entry y/n confirmation
sno-station-core lock --rebuild-manifest --reset-marker  # destructive: clear orphan rename marker
sno-station-core export <out.sno-station-core>
sno-station-core import <in.sno-station-core>
```

Test-only environment hooks (D18 isolation):

| Var | Purpose |
|---|---|
| `XDG_CONFIG_HOME` | Redirect manifests for test isolation; never provisions a key |
| `SNO_STATION_CORE_KEYCHAIN_SERVICE` | Per-test keychain isolation |
| `SNO_STATION_CORE_KEY_FILE` | Select an already-provisioned durable key file independently of `XDG_CONFIG_HOME`; temporary paths are rejected |
| `SNO_STATION_CORE_PASSPHRASE_STDIN` | Read passphrase from piped stdin (non-TTY) |
| `SNO_STATION_CORE_CRASH_AFTER` | Force `process.exit(137)` at named two-phase transition |
| `SNO_STATION_CORE_FORCE_CANARY_FAIL` | Force the canary verify step to throw |

These hooks are read in production paths so tests exercise the production code path; they have no effect when unset.

---

## Explicit operator provisioning

Normal library calls never create a DEK. A senior operator provisions the one
durable key deliberately before any encrypted store is created:

```sh
sno-station-core lock --provision-key
```

Set `SNO_STATION_CORE_KEY_FILE` first when the durable operator path differs
from `~/.config/sno-station-core/key`. Provisioning refuses temporary,
scratch, cache, runtime, and already-populated paths, and refuses to create a
replacement after any encrypted database is registered. Missing-key runtime
resolution fails loudly with the same command instead of generating a key.
The durability check applies to every resolved key path, including the default
path derived from `XDG_CONFIG_HOME`; a pre-existing scratch key is rejected,
not read or deleted.

The operator must retain a separate mode-`0600` recovery copy in durable,
operator-controlled storage. If the primary file becomes unavailable, restore
it explicitly:

```sh
sno-station-core lock --restore-key /operator-controlled/recovery/key
```

Set `SNO_STATION_CORE_KEY_FILE` first when restoring to a non-default primary
path. The command refuses to overwrite an existing primary, rejects temporary
or weakly permissioned recovery files, verifies the recovery copy against
every registered database fingerprint, writes the restored primary as mode
`0600`, and leaves the recovery copy unchanged. Runtime failures with
registered encrypted databases name this command instead of suggesting a new
key.

The Memora evaluation harness has a narrower, non-interactive contract: it
requires this explicitly provisioned file in plain mode and does not fall back
to a keychain-only or passphrase-prompt path. This keeps one durable VM key
authoritative across server-root wipes. Its operator recovery copy must live
outside the same wipe and cleanup roots.

---

## Version pins

`better-sqlite3-multiple-ciphers@^12.9.0` is pinned because earlier versions ship Node 22 prebuilt binaries that miss `wrap` API symbols on Linux. `@napi-rs/keyring@^1.3.0` is the first version that maps Linux libsecret-missing failures to a recoverable error class.

---

## Threat model summary

- **Protects**: cold disk theft, copied DB files, unauthorized OS-user processes that cannot read your keychain.
- **Does not protect**: an unlocked compromised account with malware running as your user, root-level memory scraping, OS swap, intentionally-shared content sent to your configured LLM provider.

See `docs/security.md` for the full breakdown, including the filesystem-permission boundary for explicitly provisioned file keys.
