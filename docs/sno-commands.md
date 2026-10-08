# Sno commands

The only command you type for Sno Station is `sno`. Everything else is a subcommand with arguments, and nothing else is installed on your PATH. Who: **you** type it, an **agent** runs it, or a **timer or hook** runs it.



Global options on every command: `--json` (machine-readable output), `-h` / `--help`.

## 1. Install and lifecycle

| Command | What it does | Who |
| --- | --- | --- |
| `sno setup [--harness claude,codex,hermes,openclaw] [--memory-mode local-first\|agent-native\|rem-enhanced] [PRODUCT]` | Installs Station: Reach, the small programs, the skills, memory, hooks, the nightly timer. Never writes any command other than `sno` to PATH | you or an agent |
| `sno init` | Prepares the CLI's own state and entry skills without installing Station | you or an agent |
| `sno update [--reach-version V] [--skills-version V] [--memory-mode M] [--harness H]` | Updates the CLI and everything installed; removes leftover command files an older setup wrote | you or a timer |
| `sno uninstall [PRODUCT] [--yes] [--purge-state]` | Removes one product or all; without a name it lists what is installed | you |
| `sno doctor` | Checks CLI version, installed products, skills, Station state | you or an agent |
| `sno onboarding status` / `apply` / `verify` | Shows, configures, and proves the Station setup (writes and reads a test memory, delivers a test Reach message) | an agent |
| `sno skills` / `sno skills [NAME]` | Lists the instructions your agent can read, or prints one | an agent |
| `sno products [PRODUCT] [yes\|no\|later]` | Records your answer to an offer of an optional product; with no answer, lists the offers waiting | an agent |
| `sno usage` | Shows remaining model allowance and purchased balance | you |

## 2. Account and computer

| Command | What it does | Who |
| --- | --- | --- |
| `sno account login --email EMAIL` | Signs up or in and attaches this computer to the account | you |
| `sno account register` | Registers this computer without an account | an agent or a timer |
| `sno account claim` | Prints a short code and a link to attach this computer to your account | you |

## 3. Memory and events

| Command | What it does | Who |
| --- | --- | --- |
| `sno memory remember --harness claude\|codex TEXT` | Stores a project memory, prints its id | an agent |
| `sno memory recall --harness H QUERY` | Searches project and global memory | an agent |
| `sno memory get --harness H ID` | Prints one full memory | an agent |
| `sno memory correct --harness H ID TEXT` | Stores a corrected memory and retires the old one | an agent |
| `sno memory import --harness H (--repo ROOT \| --user)` | Queues existing agent notes for import | you or an agent |
| `sno memory doctor --harness H` | Prints memory service health, hook state, permission rule state | you or an agent |
| `sno memory dump --db PATH [--scope S] [--id ID] [--grep T] [--limit N] [--metadata]` | Reads the memory store and prints rows | you |
| `sno memory hook EVENT --harness H` | Entry for the agent's hooks (SessionStart, UserPromptSubmit, Stop and so on); never blocks the agent | a timer |
| `sno observe append EVENT_TYPE --agent=HARNESS --FIELD=VALUE` | Records one observability event; every event is kept until sno.ai has it | an agent or a timer |
| `sno project status` / `sno project list` | Shows recorded project contexts and improvement outcomes; lists known projects | you or an agent |

## 4. Telemetry, audit, REM

| Command | What it does | Who |
| --- | --- | --- |
| `sno station doctor` | Checks identity, telemetry, buffer and configuration | you or an agent |
| `sno station consent` / `sno station consent [off\|metadata-only\|full]` | Shows or changes what leaves this computer: nothing, metadata only, or full details | you |
| `sno station pause` / `resume` | Stops or restarts sending data to Sno | you |
| `sno station export [PATH]` | Saves the local record of events to a file | you |
| `sno station audit [EVENT_ID]` | Checks one stored event | you |
| `sno station rem-start --scope S` / `sno station rem-status [JOB_ID]` | Starts and reads a local nightly-improvement job | an agent or a timer |
| `sno rem judge` / `recall` / `verdict JUDGMENT_ID VERDICT` | Sends a REM run, ranks lessons for a first message, sends a human verdict | an agent or a timer |
| `sno rem-reflect run [--now TS] [--trigger timer\|manual]` / `accept` / `reject` / `tbd` / `recall [--first-message]` / `lesson` / `status` / `install-hooks` | The nightly self-reflection program and its lesson commands | an agent or a timer |

## 5. Reach (messages between agents)

| Command | What it does | Who |
| --- | --- | --- |
| `sno reach VERB [options]` with VERB one of `spawn register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind` | Contact another agent, exchange work cards, read the inbox, wait for a reply, manage seats | an agent |

## 6. Small programs

| Command | What it does | Who |
| --- | --- | --- |
| `sno heartbeat --label NAME [--interval M] [--log PATH] [--until-file PATH] [--max-ticks N] [--max-hours H] [-- COMMAND...]`, `--stop NAME`, `--list` | Reports every so often or waits until a file appears, for long jobs | an agent |
| `sno report-time [--in SECONDS \| --pid PID [--expect-wall S] \| "UTC TIMESTAMP" \| @EPOCH]` | Prints a clock time for the user in their zone | an agent |
| `sno subscription-quota-check [--vendor codex\|claude\|both] [--json\|--human] [--quiet]` | Reads Codex and Claude Code subscription quota without spending any | an agent or a timer |

## 7. Skill commands

| Command | What it does | Who |
| --- | --- | --- |
| `sno away-brief run [--since W] [--repo DIR] [--charters DIR] [--as SEAT]` / `mark` | One page: done, stuck, needs you, spend | you or an agent |
| `sno catch-report run` / `self` / `brief` `[--since W] [--limit N] [--agent claude\|codex\|both] ...` | Counts what mutual review and self-correction caught | you or an agent |
| `sno deliver-proof run CHARTER N -- COMMAND...` / `see CHARTER N FILE TEXT` / `check CHARTER` | Proves a work-order step by running a command and recording the result | an agent |
| `sno handoff-checkpoint [--repo DIR] FILE` / `--verify FILE` | Writes and verifies the progress record that lets another agent take over | an agent |
| `sno medic run [--min-free-mb N]` | Checks the agent team on this machine; repairs nothing | you or an agent |
| `sno rotate-agent-resume --to codex\|claude --cwd DIR --checkpoint FILE --work LABEL [--report-to SEAT] [--checkpoint-cmd CMD]` | Moves a job to the other agent and verifies it resumed | an agent |

## Not Sno commands

Commands of other products stay as they are: `claude`, `codex`, `hermes`, `openclaw`, `npm`, `git`, `systemctl`, `launchctl`.
