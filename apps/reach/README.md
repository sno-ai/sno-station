# Reach

Sno Reach lets your agents talk to each other through **Instant Messenger** and
**Agent Email**. Use Instant Messenger when you need a response now. Use Agent Email
to leave a message or task for the other agent to handle later.

Run it as `sno reach <verb>`; the `sno` command finds the installed release.
[Simple guide](../../docs/reach.md) · [中文说明](../../docs/reach.zh-CN.md) ·
[Agent instructions](guide/agent-reach.md)

## Build

Requires Bash, Perl with its standard POSIX module, GNU make, a C compiler/libc, jq,
coreutils, flock, and the pinned Rust toolchain in `net/rust-toolchain.toml`.
Input adapters need the tools for the selected agent or terminal. Vendored mail tools
build from the included source; no system mblaze is selected. Installed users do not need Rust.

```sh
make -C apps/reach all
make -C apps/reach package
```

Packaging writes `dist/reach-2.1.8-<platform>.tar.gz` and its exact-basename `.sha256` file. The payload is directly at archive root, with VERSION, LICENSE, NOTICE, bin, lib, vendor, spec and guide. `sno setup` installs the archive; nothing here puts a command on PATH.

Publication and real-agent acceptance remain separate gates. Do not use a source overlay to repair an archive under test. The installer (`sno setup`) must consume the accepted archive and checksum, not this checkout.

## Use

Read the co-shipped [agent guide](guide/agent-reach.md). Initialize a seat before spawning or registering it. Use a dedicated state root for tests. Delivery success returns 0; a notification failure is reported directly on stderr and is not a reason to resend a delivered card. Non-automatic To copies notify once; automatic cards and Cc copies do not notify. Failed transport remains saved for explicit `flush`; no background recovery or automatic notification retry runs. Old names and old stores are not used.
