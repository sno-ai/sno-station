# Sno Memory for Cursor

Gives the Cursor IDE and the Cursor CLI the same encrypted, local memory that Claude Code and
Codex use through Sno: a conversation starts with what the repository already established,
relevant memory arrives with each message, and what the conversation settles is stored for the
next one, whichever agent opens it.

## Get started

1. Follow the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md).
2. Run `sno setup --harness cursor`. It writes Cursor hook entries into `~/.cursor/hooks.json`
   beside any entries other tools wrote there, allows `sno` in the Cursor CLI, and installs the
   `sno-mem-cursor` skill.
3. Open a Cursor conversation inside a git repository and try:

   ```bash
   sno memory doctor --harness cursor
   sno memory remember --harness cursor "Prefer tabs in this repository"
   sno memory recall --harness cursor "indentation"
   ```

A conversation outside a git repository reads and writes nothing. A conversation with several
folders open belongs to the repository of the first folder.

## Under the hood

This package is the Cursor side only: Cursor hooks and the memory commands. The memory itself
lives in [`@snoai/memory`](https://www.npmjs.com/package/@snoai/memory), a local service on
`127.0.0.1` that owns the encrypted store.

## License

Licensed under [Apache-2.0](LICENSE).
