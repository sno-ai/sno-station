# Sno Memory for Hermes Agent — Usage Guide

Hermes uses the same encrypted memory service as the other Sno Station integrations. The
Python plugin connects Hermes sessions to that service and exposes four tools to the agent.

## First use

Complete the [onboarding steps](onboarding.md) before opening Hermes. The first-release setup
uses Local First mode and prepares the local embedding model. No Sno CLI or separate Python
package is needed.

From a project directory, you can say:

> Remember that this project uses tabs for indentation.

In a later session in the same directory, ask:

> What indentation does this project use?

The plugin also captures completed primary-agent turns. It supplies relevant memories when a
primary session starts and before a prompt. A child agent can call the explicit memory tools,
but it does not receive automatic memory injection or capture its own turns.

## Explicit memory tools

These are Hermes tools, not commands to run in a shell.

| Tool | What it does |
| --- | --- |
| `sno_memory_recall` | Search memories for this project and global memories by a query |
| `sno_memory_get` | Read one full memory by its id |
| `sno_memory_remember` | Store a project memory and return its id |
| `sno_memory_correct` | Replace an identified wrong memory with a corrected successor and return the new id |

Correction keeps the earlier entry as retired history. If you do not know the id of a wrong
memory, ask Hermes to recall it first. There is no delete tool in this plugin.

## Profile and settings

The default Sno profile is `~/.sno`; set `SNO_PROFILE_DIR` to use another profile. Its
`settings.json` selects the memory mode, store, encryption key, local model cache, and npm
memory-service path. The Hermes plugin does not keep a separate memory database or mode.

Do not replace `store.path` or `store.encryptionKey` when changing a setting for an existing
store. Keep a private backup of the settings file and database. The [shared setup](../memory-setup.md)
is for a new profile, not an existing one.

Hermes selects this provider with:

```bash
hermes config set memory.provider sno-mem-hermes
```

If recall stops working, check the selected provider with `hermes config get memory.provider`,
run `hermes plugins doctor sno-mem-hermes --ci`, and confirm that the configured npm memory
package still exists. The service starts on demand and reports a failure instead of pretending
that a memory was saved.

## Update or remove

```bash
hermes plugins install sno-ai/sno-station/apps/mem-hermes/sno-mem-hermes --force --enable
hermes gateway restart
hermes plugins remove sno-mem-hermes
```

The plugin is installed from a Git subdirectory, so an update is a forced reinstall of that
subdirectory; restart a running Hermes gateway after installing or replacing it. Removing the
plugin does not remove the Sno memory store. The plugin manifest declares Linux
and macOS support; the clean-host memory journey for this release was run on Linux. Installing from the
public GitHub repository, replacing it with `--force`, and removing it were run on a clean Linux host.
