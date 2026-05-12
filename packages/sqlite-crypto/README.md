# `@snoai/nodix-crypto`

Local AES-256 encryption layer for Nodix-family SQLite databases. Thin first-party wrapper over vetted libraries: `better-sqlite3-multiple-ciphers` (SQLCipher v4 mode), `@napi-rs/keyring`, `argon2`, and Node's built-in `crypto`.

The full threat model, fallback caveats, and recovery procedures live in [`docs/security.md`](../../docs/security.md).

---

## Install

```sh
npm install @snoai/nodix-crypto
```

Node 22+ required (production AND development).

---

## Public API

### Database

```ts
import { getDek, getDekSync, openEncryptedDb } from "@snoai/nodix-crypto";

// async — supports passphrase mode (interactive prompt) and keychain
const dek = await getDek();
const db = openEncryptedDb("/path/to/store.db", dek);

// sync — for entry points that cannot await (e.g. plugin register())
// throws on passphrase mode (which inherently requires async prompt)
const dekSync = getDekSync();
```

`openEncryptedDb` returns a `better-sqlite3-multiple-ciphers` `Database` handle preconfigured for SQLCipher v4 with the DEK applied. Wrong-key reads throw `WrongKeyError`. The first open of a fresh DB transparently registers it in the manifest at `~/.config/nodix/dbs.json`.

### Passphrase mode (opt-in)

```ts
import { setPassphrase, removePassphrase } from "@snoai/nodix-crypto";

await setPassphrase(Buffer.from("your-passphrase", "utf8"));
// later — revert to keychain / file-fallback
await removePassphrase(Buffer.from("your-passphrase", "utf8"));
```

Both functions take `Buffer` (not `string`) so callers can zero-fill the buffer after use. They implement two-phase commit with mid-flight crash recovery; see the spec for the state machine.

### `.nodix` export / import

```ts
import { exportEncrypted, importEncrypted } from "@snoai/nodix-crypto";

await exportEncrypted("backup.nodix");          // gzip-tar all manifest DBs + AES-256-GCM
await importEncrypted("backup.nodix");           // verify header + decrypt + restore
```

Layered import error contract:

1. `InvalidExportFormat` / `UnsupportedExportVersion` — structural gates (magic, version) before any AEAD work.
2. `ForeignDekError` — DEK fingerprint mismatch (computed BEFORE `decipher.final()`); message references the v1.1 `--import-dek` recovery path.
3. `IntegrityCheckFailed` — GCM auth failure (the path that catches all meaningful header tampering, since the entire 12-byte header is bound as AAD).

---

## CLI

The package ships a `nodix` binary:

```sh
nodix lock --status                    # mode + 8-char fingerprint + manifest health
nodix lock --set-passphrase            # upgrade to passphrase mode (two prompts)
nodix lock --remove-passphrase         # revert to keychain / file-fallback
nodix lock --rebuild-manifest [paths]  # rebuild dbs.json with per-entry y/n confirmation
nodix lock --rebuild-manifest --reset-marker  # destructive: clear orphan rename marker
nodix export <out.nodix>
nodix import <in.nodix>
```

Test-only environment hooks (D18 isolation):

| Var | Purpose |
|---|---|
| `XDG_CONFIG_HOME` | Redirect `~/.config/nodix/...` to a tmpdir |
| `NODIX_KEYCHAIN_SERVICE` | Per-test keychain isolation |
| `NODIX_PASSPHRASE_STDIN` | Read passphrase from piped stdin (non-TTY) |
| `NODIX_CRASH_AFTER` | Force `process.exit(137)` at named two-phase transition |
| `NODIX_FORCE_CANARY_FAIL` | Force the canary verify step to throw |

These hooks are read in production paths so test recovery exercises the production code path; they have no effect when unset.

---

## Version pins

`better-sqlite3-multiple-ciphers@^12.9.0` is pinned because earlier versions ship Node 22 prebuilt binaries that miss `wrap` API symbols on Linux. `@napi-rs/keyring@^1.3.0` is the first version that maps Linux libsecret-missing failures to a recoverable error class.

---

## Threat model summary

- **Protects**: cold disk theft, copied DB files, unauthorized OS-user processes that cannot read your keychain.
- **Does not protect**: an unlocked compromised account with malware running as your user, root-level memory scraping, OS swap, intentionally-shared content sent to your configured LLM provider.

See `docs/security.md` for the full breakdown including the file-fallback cold-backup caveat (when libsecret/dbus is unavailable, the DEK is protected only by file-system permissions on `~/.config/nodix/key`).
