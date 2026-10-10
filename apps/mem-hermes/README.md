# Sno Memory for Hermes Agent

Long-term memory for Hermes Agent sessions. The memory service stores and retrieves project
memories; this plugin connects Hermes lifecycle hooks and four memory tools.

For a first installation, see [onboarding](../../docs/mem-hermes/onboarding.md) or
[中文初次设置](../../docs/mem-hermes/locale/onboarding.zh.md). The
[usage guide](../../docs/mem-hermes/usage-guide.md) covers daily behavior and settings.

## Install

Install Hermes Agent and complete the [shared memory setup](https://github.com/sno-ai/sno-station/blob/main/docs/memory-setup.md)
once. Then run:

```bash
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh' && ~/.local/bin/sno setup --harness hermes
```

Setup installs and enables the plugin and selects it as the memory provider unless you already
chose another one (then run `hermes config set memory.provider sno-mem-hermes` yourself).

The plugin starts the memory service when needed, including after it stops during a
conversation. Use `SNO_PROFILE_DIR` to select another profile root.

The plugin offers `sno_memory_recall`, `sno_memory_get`, `sno_memory_remember`, and
`sno_memory_correct`. Correction returns a fresh successor id; the previous entry remains visible as retired
history. Primary agents capture direct turns and receive the service memory block at session
start and before prompts. Child agents can use explicit tools but do not inject or capture memory.

## Update and remove

```bash
sno update
sno uninstall
```

`sno update` reinstalls the plugin when this repository has a newer version and restarts a
running Hermes gateway. `sno uninstall` lists what is installed; name the Hermes memory entry to
remove it. Removing the plugin does not remove stored memory.

## License

Licensed under [Apache-2.0](LICENSE).
