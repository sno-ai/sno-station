# `@snoai/sqlite-crypto`

The encryption layer under Sno Station memory: your SQLite database is encrypted on disk with a key that never leaves your machine. It is a thin wrapper over `better-sqlite3-multiple-ciphers` (SQLCipher v4 mode) and Node's built-in `crypto`.

The full threat model, settings-file key rules, and recovery steps live in [`docs/security.md`](https://github.com/sno-ai/sno-station/blob/main/docs/security.md).

---

## Install

```sh
npm install @snoai/sqlite-crypto@1.2.0
```

Needs Node.js 22.14 or newer.

Who it is for: the memory engine, and anyone who wants the same encrypted-database layer. If you only want shared agent memory, you do not use it directly: the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md) creates the key and the plugins for [Codex](https://www.npmjs.com/package/@snoai/mem-codex), [Claude Code](https://www.npmjs.com/package/@snoai/mem-claude) and [OpenClaw](https://www.npmjs.com/package/@snoai/mem-claw) do the rest.

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

The [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
generates the 64-hex key once and writes it to `settings.json` (mode `0600`).
`getDek` accepts that explicit key; it does not find or create one. `openEncryptedDb`
returns a `better-sqlite3-multiple-ciphers` handle configured for SQLCipher v4.
Wrong-key reads throw `WrongKeyError`. The store list remains at
`~/.config/sno-station-core/dbs.json`.

Keep a recoverable copy of `settings.json` with the encrypted store. If the file is
lost, restore its original `store.encryptionKey` from that copy before running the
memory service. Never generate a new key while the store exists: it cannot open
the existing data. If settings are missing or invalid, follow the
[shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
only for a new profile; preserve any existing file and key backup.

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
The library has no key-management command. The shared memory setup writes the settings file;
plugins start the memory service through `memoryPackage` in that file.
The encrypted-store list stays at `~/.config/sno-station-core/dbs.json`.

---

## Threat model summary

- **Protects**: copied DB files without the settings key, other OS users who cannot read the private settings file.
- **Does not protect**: an unlocked compromised account with malware running as your user, whole-disk theft without full-disk encryption, root-level memory scraping, OS swap, intentionally-shared content sent to your configured LLM provider.

See `docs/security.md` for the full breakdown, including the filesystem-permission boundary for `settings.json`.
