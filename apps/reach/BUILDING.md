# Build Reach from source

For installation and everyday use, start with the [Reach README](README.md).

Requires Bash, Perl with its standard POSIX module, GNU make, a C compiler/libc, jq,
coreutils, flock, and the pinned Rust toolchain in `net/rust-toolchain.toml`.
Input adapters need the tools for the selected agent or terminal. Vendored mail tools
build from the included source; no system mblaze is selected. Installed users do not need Rust.

Run from the repository root:

```sh
make -C apps/reach all
make -C apps/reach package
```

Packaging writes `dist/reach-2.1.8-<platform>.tar.gz` and its exact-basename `.sha256`
file. The payload is directly at archive root, with VERSION, LICENSE, NOTICE, bin,
lib, vendor, spec and guide. `sno setup` installs the archive; nothing here puts a
command on PATH.

Publication and real-agent acceptance remain separate gates. Do not use a source
overlay to repair an archive under test. The installer must consume the accepted
archive and checksum, not this checkout. Use a dedicated state root for tests.
