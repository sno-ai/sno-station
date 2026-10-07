# Sno Memory for Hermes Agent — Onboarding

Hermes uses a Python plugin to connect to the shared Sno memory service. The service itself
comes from npm. The `sno` command installs the plugin and selects it for you.

## Install

You need Hermes Agent, Git, and Node.js 22.22.3+ on the 22 line, 24.15.0+ on the 24 line, or
25.9.0+. First complete the [shared memory setup](../memory-setup.md). It installs the memory
service and writes `~/.sno/settings.json` with a local store and encryption key.

Then install the Hermes plugin:

```bash
sh -c 'sno_installer_body=$(curl -fsSL https://sno.ai/install) && printf "%s\n" "$sno_installer_body" | sh'
sno setup --harness hermes
```

`sno setup` installs and enables the plugin from this repository (not a separate Python
package), selects it as Hermes's memory provider when you have not chosen another one, and
restarts a running Hermes gateway. The shared setup installs its npm memory service. The
first-release setup uses Local First mode, so it needs no model API key. It downloads the
local embedding model before your first session.

Keep a private backup of `~/.sno/settings.json` and the memory store. Do not rerun the shared
settings block for an existing store: it creates a new encryption key and makes old memories
unreadable.

## Check the installation

```bash
sno doctor
hermes plugins list
hermes config get memory.provider
```

`sno doctor` should show the Hermes memory row as ok, the plugin should be enabled, and the
selected provider should be `sno-mem-hermes`.

Open Hermes in a project directory. Ask it to remember a small project fact, then end that
session. Open a new session in the same directory and ask for the fact. The first session saves
the memory; the next one should retrieve it. The memory service starts when the plugin needs
it, so there is no separate start command.

## If you already have a memory store

Run `sno setup --harness hermes`, but keep the existing `settings.json`, store path, and
encryption key. If another memory provider is already selected in Hermes, setup leaves your
choice alone; select Sno memory yourself with `hermes config set memory.provider sno-mem-hermes`. `SNO_PROFILE_DIR` selects a different profile root if you use one. Removing or
updating the plugin does not delete stored memories.

See the [usage guide](usage-guide.md) for the four memory tools and daily behavior.
