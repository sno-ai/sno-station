# Sno Memory for Hermes Agent

Long-term memory for Hermes Agent sessions. The memory service stores and retrieves project
memories; this plugin connects Hermes lifecycle hooks and four memory tools.

## Install

Install Hermes Agent and Node.js 22.22.3+, 24.15.0+, or 25.9.0+. Then run:

```bash
sno setup
hermes plugins install sno-ai/sno-station/apps/mem-hermes/sno-mem-hermes --enable
hermes config set memory.provider sno-mem-hermes
```

`sno setup` writes `~/.sno/settings.json` and installs the memory service. The plugin starts it
when needed, including after it stops during a conversation. Use `SNO_PROFILE_DIR` to select
another profile root. If the settings file is missing or unreadable, the plugin reports its
path and asks you to run `sno setup`.

The plugin offers `sno_memory_recall`, `sno_memory_get`, `sno_memory_remember`, and
`sno_memory_correct`. It also captures direct turns and prepares a short working brief.

## Update and remove

```bash
hermes plugins update sno-mem-hermes
hermes plugins remove sno-mem-hermes
```

Removing the plugin does not remove stored memory.

## License

Licensed under [Apache-2.0](LICENSE).
