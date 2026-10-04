# Security & Privacy - How Sno Station Protects Your Data

> **The promise**: your local memory store is encrypted on your machine with a key generated once during [shared memory setup](memory-setup.md) and kept in your local `settings.json`. Sno does not receive your database or your Data Encryption Key (DEK).
>
> When you ask an AI model to answer with memory context, share memory, or use an explicit team feature, SNO Station Core may send only the selected data needed for that action. Outside those user-directed flows, actual memory content is not uploaded to a cloud service. Sno is not in the LLM provider path.

This document explains what we do, why the design is strong, and where the security boundary ends.

---

## Abstract

- **Local memory is the source of truth, and it is encrypted by default.** SNO Station Core memory databases are encrypted at rest from first use; outside explicit user actions such as model requests, sharing, or team collaboration, actual memory content stays on the local machine.
- **The key is local and persistent.** First-release setup generates the 256-bit DEK once as 64 lowercase hex characters in `<profile root>/settings.json`. Do not run that one-time settings command again for an existing store.
- **Recovery needs the original settings file.** Keep a private, durable copy of `settings.json` with the encrypted store; restore its original `store.encryptionKey` if the active file is lost. Sno does not receive the copy.
- **The database format is standard, not proprietary obfuscation.** SQLite pages are encrypted through `better-sqlite3-multiple-ciphers` / SQLite3MultipleCiphers in SQLCipher v4-compatible mode, while AES, GCM, and SQLite bring standards-backed component assurance.
- **Our own crypto layer is deliberately small.** `@snoai/sqlite-crypto` is a thin first-party package over vetted libraries: SQLite3MultipleCiphers and Node's built-in `crypto`.
- **File permissions protect the key.** `settings.json` is written with mode `0600`; anyone who can read it and the store can decrypt the data. There is no Sno recovery copy.
- **Metadata is scoped to the user's action.** Operational metadata is minimized and segmented by purpose, for example model routing, sharing, team access, or troubleshooting. It is not a shadow copy of memory content.
- **We are precise about limits.** SNO Station Core protects a copied database only when its key is kept separately; it does not protect an unlocked compromised machine, malware running as your OS user, root-level memory scraping, OS swap, or data you intentionally send to your chosen LLM provider, share target, or team workspace.

---

## What Gets Encrypted

| Data | On disk | Encrypted? |
|---|---|---|
| Memory entries: text, embeddings, metadata | Local SQLite database files | **Yes** - page-level AES-256 encryption. |
| Vector store and embedding cache | Inside the same SQLite databases | **Yes** - encrypted automatically with the database pages. |
| User-created exports | `.sno-station-core` export files | **Yes** - AES-256-GCM using the same local DEK. |
| Application logs | Local log files | **No** - production logs must not contain memory content; they are limited to operational metadata such as token counts, latencies, model names, and error classes. |
| OS swap, hibernation files, crash dumps | OS-managed | **No** - outside SNO Station Core control. Full-disk encryption remains recommended. |

FileVault, BitLocker, or LUKS gives you a second layer below SNO Station Core. SNO Station Core does not require full-disk encryption, but you should enable it.

---

## Local Source Of Truth

SNO Station Core treats local memory as the authoritative store. The encrypted database on the user's machine is the single source of truth for actual memory content unless the user deliberately performs an action that needs data to leave the machine.

Those explicit actions include:

- asking a configured AI model to answer with selected memory context;
- exporting or sharing selected memory;
- enabling a team or collaboration workflow that requires selected memory to be available to other users.

In those cases, SNO Station Core should send the minimum content needed for the requested action and keep the scope visible to the user. Outside those flows, memory content is not mirrored to Sno, synced to a hidden cloud memory store, or reconstructed from telemetry.

Metadata follows the same principle. Metadata is divided by purpose and scope: local indexing metadata stays with the local database; LLM request metadata is tied to the user's configured provider call; sharing metadata is tied to the selected share; team metadata is tied to the selected workspace or permission boundary. Metadata must not become an implicit memory-content replica.

---

## How It Works

The four memory plugins start the one local memory service from the installed
`memoryPackage` in `<profile root>/settings.json` (profile root: `SNO_PROFILE_DIR`
or `~/.sno`). The service opens the encrypted SQLite store at `store.path` using
the 64-lowercase-hex-character `store.encryptionKey` from the same file.
`@snoai/sqlite-crypto` applies that explicit 256-bit key to the SQLite engine
before application queries run. The store list remains at
`~/.config/sno-station-core/dbs.json`.

[Shared memory setup](memory-setup.md) generates the key once on first install and writes `settings.json`
with mode `0600`. Keep a private, durable backup of this file with the store.
If the active file is missing or damaged, preserve it and restore the original
`store.encryptionKey` and `store.path` from the backup. Restore the complete
settings file when possible. Never regenerate the key while an encrypted
store exists; a new key cannot open it. If no backup exists, the encrypted
store cannot be recovered from its ciphertext.

Application code reads and writes normal rows. Database pages are decrypted
in memory when read and encrypted before being written to disk. The key is
not sent to Sno, an LLM provider, an environment variable, or a command line.

---

## Component Assurance

The strongest security claim we can make is not "trust our custom cryptography." It is the opposite: SNO Station Core keeps its own crypto code small and delegates to components with public designs, mature implementations, and external standards behind them.

| Layer | What we use | Assurance basis |
|---|---|---|
| SQLite encryption | `better-sqlite3-multiple-ciphers`, bundling SQLite3MultipleCiphers | SQLCipher-compatible page encryption, public C implementation, same Node API shape as `better-sqlite3`. |
| Cipher mode for DB pages | SQLCipher v4-compatible AES-256-CBC plus page authentication | SQLCipher has been public since 2008; SQLite3MultipleCiphers documents AES-256-CBC, per-page random IVs, and SHA-512 page tags for v4 compatibility. |
| SQLite storage engine | SQLite | SQLite is built with a DO-178B-inspired quality process, high-volume regression testing, malformed database tests, and fuzzing that runs about one billion mutations per day. |
| Key custody | `<profile root>/settings.json` | First-release setup writes the 64-hex key at mode `0600`; a private backup is needed for recovery. |
| Export encryption | Node 22 built-in `crypto`, AES-256-GCM | Encrypts local `.sno-station-core` exports. |
| First-party surface | `@snoai/sqlite-crypto` | Opens encrypted databases with the explicit key; plugins do not reimplement key handling. |

SNO Station Core does not claim FIPS 140 product validation, Common Criteria certification,
SOC 2 certification, or a formal third-party audit. It uses standardized algorithms
and a small first-party cryptography path.

---

## Security Levels

### Default: Private Local Settings

Complete [shared memory setup](memory-setup.md) before first use. It writes `<profile root>/settings.json` at
mode `0600`, with `store.path` and a newly generated `store.encryptionKey`.
The first-release store is `<profile root>/memory.sqlite`.
The key is generated only once. If the store already exists and the key is
missing, restore the original settings from a backup; never generate another.

Anyone who can read both `settings.json` and the encrypted store can open it.
Store the backup privately, apart from cleanup paths that might remove the
active settings file and store. On a headless host, the same settings-file
and backup rule applies; no interactive unlock step is required.

---

## What We Protect Against

| Threat | Protection |
|---|---|
| Stolen database file | The file is ciphertext without the DEK. |
| Time Machine, iCloud, Dropbox, S3, NAS, or other cold backup leakage | Backups contain encrypted DB pages; the DEK is not inside the DB file. |
| Disk extraction from a powered-off machine | If `settings.json` is on that disk, the attacker can obtain both the database and its key. Use full-disk encryption to protect the whole device. |
| Another OS user reading the DB file | The DB is encrypted; mode-`0600` settings restrict access to the key. |
| Sno reading the local memory database | Sno does not receive the DB file or DEK. There is no v1 Sno cloud memory database. |
| Hidden cloud replication of memory content | Local memory is the authoritative store; actual memory content is not mirrored to Sno outside user-directed sharing, team, or model-request flows. |
| Tampering with encrypted DB pages | Page authentication detects modification and fails closed instead of silently returning changed plaintext. |

---

## What We Do Not Protect Against

We do not hide these boundaries:

- **Malware running as your OS user.** Such code can read your settings file and process memory, or capture what you type.
- **An unlocked machine in someone else's hands.** If the machine is unlocked and SNO Station Core is already running, the OS boundary has already been crossed.
- **Root, kernel, debugger, or memory-dump access.** The DEK must exist in process memory while the gateway is using the database.
- **OS swap and hibernation.** Use full-disk encryption to reduce that risk.
- **Lost settings and backups.** There is no Sno escrow, backdoor, or support override for a lost key.
- **Coerced unlock.** Cryptography cannot prevent a person from being forced to unlock a system.
- **The user's chosen LLM provider.** If you configure Anthropic, OpenAI, a local model server, or another provider, the relevant prompt context sent to that provider is governed by that provider and your configuration.
- **Future cloud features.** v1 has no Sno-operated cloud memory store. If cloud sync is added later, it must be explicit opt-in and documented separately.

---

## Data Egress Audit

| Pathway | Carries memory content? | Notes |
|---|---|---|
| Sno-operated memory cloud | **No** | No such v1 service exists. |
| Sno telemetry | **No memory content** | Telemetry is on by default. Events carry hashes, counts and identifiers, never memory content. |
| Crash reports | **No by default** | Production crash reporting must not upload memory content. |
| Update checks | **No** | Version metadata only. |
| User-configured LLM provider | **Yes, when needed for an answer** | The provider is selected by the user and accessed with the user's own API key. Sno is not the intermediary. |
| User-requested sharing | **Only selected content** | The user chooses what to share; sharing metadata is scoped to that share. |
| Team collaboration | **Only selected workspace content** | Team memory, if enabled, is scoped to the selected workspace and permission boundary. Local personal memory remains local. |
| Operational metadata | **No memory content** | Metadata is segmented by purpose and must not contain a copy or reconstruction of actual memory content. |
| Local exports | User-controlled | `.sno-station-core` exports are encrypted locally before you move or back them up. |

---

## How To Verify

### 1. Confirm the Database Is Encrypted

Open the database with the standard `sqlite3` CLI, which does not know the key:

```sh
sqlite3 "<store.path from settings.json>" ".tables"
```

Expected result:

```text
Error: file is not a database
```

That error is correct. The file is encrypted ciphertext, not a plaintext SQLite database.

For a legitimate low-level check, use a SQLCipher-compatible CLI and the DEK:

```text
sqlcipher "<store.path from settings.json>"
> PRAGMA key = "x'<your-64-hex-DEK>'";
> .tables
```

Only print or handle a DEK for local verification. Never share it.

### 2. Confirm Sno Is Not Receiving Memory Content

While running SNO Station Core, monitor outbound connections:

```sh
sudo lsof -i -P -n | grep -i node
```

or:

```sh
sudo tcpdump -i any -A 'host not <your-LLM-provider> and not <your-DNS>'
```

You may see calls to the LLM provider you configured. You should not see memory database uploads to Sno.

### 3. Confirm the Settings and Recovery Copy

Check that `<profile root>/settings.json` contains the intended `store.path`
and a 64-character lowercase hexadecimal `store.encryptionKey`. Keep the key
private; do not print it in logs or support requests. Verify that a saved copy
of the file contains the same original key and can open a backup of the store.
If settings cannot be read, preserve the existing file and restore the original
settings from your private backup; do not generate a replacement key.

---

## Frequently Asked Questions

**Q: Can Sno read my memory database?**

A: No. Sno does not receive your DB file or DEK, and v1 has no Sno-operated cloud memory store.

**Q: Does my memory ever leave my machine?**

A: Not by default. The local database and DEK do not leave your machine through Sno. Selected content may leave only when you ask a configured LLM provider to answer with memory context, share memory, export it, or use an explicit team workflow.

**Q: Is the local database the source of truth?**

A: Yes. For personal memory, the encrypted local database is the authoritative store. Sno does not rebuild your memory from cloud telemetry or maintain a hidden server-side copy.

**Q: What about metadata?**

A: Metadata is scoped to the user's action. Local indexing metadata stays local; model-call metadata belongs to the configured provider request; sharing metadata belongs to the selected share; team metadata belongs to the selected workspace or permission boundary. It must not become a copy of the memory content.

**Q: Why is encryption on by default?**

A: Memory data is sensitive by nature. Modern CPUs handle AES efficiently, and the product risk of a plaintext default is much higher than the overhead of encrypting local SQLite pages.

**Q: Why use SQLite instead of a custom encrypted file format?**

A: SQLite is small, stable, transactional, broadly deployed, and unusually well tested. Keeping SQL, FTS, vector data, metadata, and transactions in one encrypted SQLite database gives us reliability without inventing a storage engine.

**Q: Is the new npm security package auditable?**

A: Yes. `@snoai/sqlite-crypto` is intentionally the only first-party package that handles keys and encrypted DB opening. It wraps established dependencies rather than spreading cryptographic logic through every plugin.

**Q: Is `better-sqlite3-multiple-ciphers` itself certified?**

A: We do not claim formal certification for that npm wrapper. The reliability argument is that it exposes the mature `better-sqlite3` API shape while bundling SQLite3MultipleCiphers, whose SQLCipher-compatible mode uses publicly documented, standard cryptographic building blocks.

**Q: What happens if my laptop is stolen?**

A: A copied DB file alone is ciphertext. If the attacker has the whole disk and `settings.json` is on it, they can decrypt the store. Full-disk encryption protects that case.

**Q: What if I lose `settings.json`?**

A: Restore its original `store.encryptionKey` from your private backup. If both copies are gone, the encrypted store is unrecoverable. Do not generate a new key for it.

**Q: Where do I report a security issue?**

A: Email `security@sno.ai`. Please include reproduction steps and do not file public issues for security bugs.

---

## QA Evidence

To verify recovery, open a real encrypted store using a saved copy
of `settings.json`. The 2026-07-15 key-loss incident in `SECURITY.md` remains
historical context; its former key-file and interactive unlock tests do not
describe the shipped setup.

---

## References

- SQLite3 Multiple Ciphers SQLCipher mode: https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_sqlcipher/
- SQLCipher project: https://github.com/sqlcipher/sqlcipher
- SQLite high reliability: https://sqlite.org/hirely.html
- SQLite testing: https://sqlite.org/testing.html
- SQLite quality management plan: https://sqlite.org/qmplan.html
- NIST FIPS 197, AES: https://csrc.nist.gov/pubs/fips/197/final
- NIST SP 800-38D, GCM: https://csrc.nist.gov/pubs/sp/800/38/d/final

---

*Last updated: 2026-09-27. For corrections or questions: `security@sno.ai`.*
