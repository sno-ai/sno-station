# `@snoai/sqlite-crypto`

Local AES-256 encryption layer for SNO Station Core SQLite databases. Thin first-party wrapper over `better-sqlite3-multiple-ciphers` (SQLCipher v4 mode) and Node's built-in `crypto`.

The full threat model, settings-file key rules, and recovery steps live in [`docs/security.md`](https://github.com/sno-ai/sno-station/blob/main/docs/security.md).

---

## Install

```sh
npm install @snoai/sqlite-crypto
```

Node 22+ required (production AND development).

---

## Public API

### Database

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDek, openEncryptedDb } from "@snoai/sqlite-crypto";

const profileRoot = process.env.SNO_PROFILE_DIR ?? join(homedir(), ".sno");
const settings = JSON.parse(readFileSync(join(profileRoot, "settings.json"), "utf8"));
const dek = getDek(settings.store.encryptionKey);
const db = openEncryptedDb(settings.store.path, dek);
```

`sno setup` generates the 64-hex key once and writes it to `settings.json` (mode `0600`).
`getDek` accepts that explicit key; it does not find or create one. `openEncryptedDb`
returns a `better-sqlite3-multiple-ciphers` handle configured for SQLCipher v4.
Wrong-key reads throw `WrongKeyError`. The store list remains at
`~/.config/sno-station-core/dbs.json`.

Keep a recoverable copy of `settings.json` with the encrypted store. If the file is
lost, restore its original `store.encryptionKey` from that copy before running the
memory service. Never generate a new key while the store exists: it cannot open
the existing data. If settings are missing or invalid, run `sno setup` after
preserving any existing file and key backup.

### `.sno-station-core` export / import

```ts
import { exportEncrypted, importEncrypted } from "@snoai/sqlite-crypto";

await exportEncrypted("backup.sno-station-core", dek); // gzip-tar all manifest DBs + AES-256-GCM
await importEncrypted("backup.sno-station-core", dek); // verify header + decrypt + restore
```

Layered import error contract:

1. `InvalidExportFormat` / `UnsupportedExportVersion` — structural gates (magic, version) before any AEAD work.
2. `ForeignDekError` — DEK fingerprint mismatch (computed BEFORE `decipher.final()`); restore the original `store.encryptionKey` from your settings backup.
3. `IntegrityCheckFailed` — GCM auth failure (the path that catches all meaningful header tampering, since the entire 12-byte header is bound as AAD).

---

## Settings and recovery

The memory service uses `store.path` and `store.encryptionKey` from
`<profile root>/settings.json`, where the profile root is `SNO_PROFILE_DIR` or `~/.sno`.
The library has no key-management command. `sno setup` writes the settings file;
plugins start the memory service through `memoryPackage` in that file.
The encrypted-store list stays at `~/.config/sno-station-core/dbs.json`.

## Version pins

`better-sqlite3-multiple-ciphers@^12.9.0` is pinned because earlier versions ship Node 22 prebuilt binaries that miss `wrap` API symbols on Linux.

---

## Threat model summary

- **Protects**: copied DB files without the settings key, other OS users who cannot read the private settings file.
- **Does not protect**: an unlocked compromised account with malware running as your user, whole-disk theft without full-disk encryption, root-level memory scraping, OS swap, intentionally-shared content sent to your configured LLM provider.

See `docs/security.md` for the full breakdown, including the filesystem-permission boundary for `settings.json`.
