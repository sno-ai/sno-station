# Sno Memory for Hermes Agent — Onboarding

Hermes uses a Python plugin to connect to the shared Sno memory service. The service itself
comes from npm. You do not need Sno CLI for this first-release setup.

## Install

You need Hermes Agent, Git, and Node.js 22.22.3+ on the 22 line, 24.15.0+ on the 24 line, or
25.9.0+. First complete the [shared memory setup](../memory-setup.md). It installs the memory
service and writes `~/.sno/settings.json` with a local store and encryption key.

Then install and select the Hermes plugin:

```bash
hermes plugins install sno-ai/sno-station/apps/mem-hermes/sno-mem-hermes --enable
hermes config set memory.provider sno-mem-hermes
```

The plugin is installed from this repository, not from a separate Python package. The shared
setup installs its npm memory service. The first-release setup uses Local First mode, so it
needs no model API key. It downloads the local embedding model before your first session.

Keep a private backup of `~/.sno/settings.json` and the memory store. Do not rerun the shared
settings block for an existing store: it creates a new encryption key and makes old memories
unreadable.

## Check the installation

```bash
hermes plugins list
hermes plugins doctor sno-mem-hermes --ci
hermes config get memory.provider
```

The plugin should be enabled, the doctor should report no errors, and the selected provider
should be `sno-mem-hermes`.

Open Hermes in a project directory. Ask it to remember a small project fact, then end that
session. Open a new session in the same directory and ask for the fact. The first session saves
the memory; the next one should retrieve it. The memory service starts when the plugin needs
it, so there is no separate start command.

## If you already have a memory store

Install the plugin and select it, but keep the existing `settings.json`, store path, and
encryption key. `SNO_PROFILE_DIR` selects a different profile root if you use one. Removing or
updating the plugin does not delete stored memories.

See the [usage guide](usage-guide.md) for the four memory tools and daily behavior. The public
Git install command above still needs verification against the published Sno Station commit;
the pre-release clean-machine test installed the same plugin from a local source directory.
