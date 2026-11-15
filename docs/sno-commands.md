# Sno commands

The only command you type for Sno Station is `sno`. Everything else is a subcommand with arguments, and nothing else is installed on your PATH. Who: **you** type it, an **agent** runs it, or a **timer or hook** runs it.



Global options on every command: `--json` (machine-readable output), `-h` / `--help`.

## 1. Install and lifecycle

| Command | What it does | Who |
| --- | --- | --- |
| `sno setup [--harness claude,codex,cursor,hermes,openclaw] [--memory-mode local-first\|agent-native\|rem-enhanced] [PRODUCT]` | Installs Station: Reach, the small programs, the skills, memory, hooks, the nightly timer. Never writes any command other than `sno` to PATH | you or an agent |
| `sno init` | Prepares the CLI's own state and entry skills without installing Station | you or an agent |
| `sno update [--reach-version V] [--skills-version V] [--memory-mode M] [--harness H]` | Updates the CLI and everything installed; removes leftover command files an older setup wrote | you or a timer |
| `sno uninstall [PRODUCT] [--yes] [--purge-state]` | Removes one product or all; without a name it lists what is installed | you |
| `sno doctor` | Checks CLI version, installed products, skills, Station state | you or an agent |
| `sno onboarding status` / `apply` / `verify` | Shows, configures, and proves the Station setup (writes and reads a test memory, delivers a test Reach message) | an agent |
| `sno skills` / `sno skills [NAME]` | Lists the instructions your agent can read, or prints one | an agent |
| `sno products [PRODUCT] [yes\|no\|later]` | Records your answer to an offer of an optional product; with no answer, lists the offers waiting | an agent |
| `sno usage` | Shows the remaining weekly allowance and your balance | you |

`sno usage` shows the remaining weekly allowances for memory and Self Learning. It also shows when each allowance resets and your balance in dollars. When a weekly allowance is used up, your balance is used; with no balance left, Sno uses your own agent's model until it resets.

## 2. Account and computer

| Command | What it does | Who |
| --- | --- | --- |
| `sno account login --email EMAIL` | Signs up or in and attaches this computer to the account | you |
| `sno account register` | Registers this computer without an account | an agent or a timer |
| `sno account claim` | Prints a short code and a link to attach this computer to your account | you |

## 3. Memory and events

| Command | What it does | Who |
| --- | --- | --- |
| `sno memory remember --harness claude\|codex\|cursor TEXT` | Stores a project memory, prints its id | an agent |
| `sno memory recall --harness H QUERY` | Searches project and global memory | an agent |
| `sno memory get --harness H ID` | Prints one full memory | an agent |
| `sno memory correct --harness H ID TEXT` | Stores a corrected memory and retires the old one | an agent |
| `sno memory import --harness H (--repo ROOT \| --user)` | Queues existing agent notes for import | you or an agent |
| `sno memory doctor --harness H` | Prints memory service health, hook state, permission rule state | you or an agent |
| `sno memory dump --db PATH [--scope S] [--id ID] [--grep T] [--limit N] [--metadata]` | Reads the memory store and prints rows | you |
| `sno memory hook EVENT --harness H` | Entry for the agent's hooks (SessionStart, UserPromptSubmit, Stop and so on); never blocks the agent | a timer |
| `sno observe append EVENT_TYPE --agent=HARNESS --FIELD=VALUE` | Records one observability event; every event is kept until sno.ai has it | an agent or a timer |
| `sno project status` / `sno project list` | Shows recorded project contexts and improvement outcomes; lists known projects | you or an agent |

## 4. Telemetry, audit, REM, Self Learning

| Command | What it does | Who |
| --- | --- | --- |
| `sno station doctor` | Checks identity, telemetry, buffer and configuration | you or an agent |
| `sno station consent` / `sno station consent [off\|metadata-only\|full]` | Shows or changes what leaves this computer: nothing, metadata only, or full details | you |
| `sno station pause` / `resume` | Stops or restarts sending data to Sno | you |
| `sno station export [PATH]` | Saves the local record of events to a file | you |
| `sno station audit [EVENT_ID]` | Checks one stored event | you |
| `sno station rem-start --scope S` / `sno station rem-status [JOB_ID]` | Starts and reads a local memory-maintenance job | an agent or a timer |
| `sno rem judge` / `recall` / `verdict JUDGMENT_ID VERDICT` | Sends a Self Learning run, ranks lessons for a first message, sends a human verdict | an agent or a timer |
| `sno rem-reflect run [--now TS] [--trigger timer\|manual]` / `accept` / `reject` / `tbd` / `recall [--first-message]` / `lesson` / `status` / `install-hooks` | Self Learning and its lesson commands | an agent or a timer |

## 5. Reach: Instant Messenger and Agent Email

**Instant Messenger** asks another agent now and waits for a response. **Agent Email**
leaves a saved message or task to handle later. See the [simple guide](reach.md).

| Command | What it does | Who |
| --- | --- | --- |
| `sno reach VERB [options]` with VERB one of `pair spawn terminal terminal-info network peer register unregister seats call watch ring send reply inbox wait dismiss log state flush init rebind doctor export lint remind` | Use Instant Messenger or Agent Email, configure connections, and manage agent identities | an agent |
| `sno squad` / `sno --json squad` | Shows who needs you, who is working, and finished results across local agents; opens full screen in a terminal, or prints a snapshot/JSON | you or an agent |
| `sno reach pair "TASK"` | Starts two new agents in the current project: one implements and the other reviews its result through Reach; uses one signed-in vendor when needed and identifies the actual composition | you or an agent |
| `sno reach call SEAT "TEXT" [--expect REGEX] [--timeout SECONDS] [--every SECONDS]` | Instant Messenger: sends the instruction and waits for an actual response. Remote and supported local conversations return a threaded mail answer; existing terminal capture paths verify receiver output. Timeout does not mean the message was never delivered. | an agent |
| `sno reach call SEAT "TEXT" --raw` | Types literal text into a tmux seat without mailbox storage or a reply wait | an agent |
| `sno reach send --as ADDRESS` | Agent Email: reads a complete message on stdin, saves it, and attempts delivery | an agent |
| `sno reach inbox --as ADDRESS` / `reply --as ADDRESS --card FILE` | Read saved Agent Email and reply to the original message; reply body comes from stdin | an agent |
| `sno reach network start` / `status` / `stop` / `address` | Start or inspect the local cross-machine receiver; export its contact | you or an agent |
| `sno reach peer add MACHINE --file CONTACT.json` / `peer list` | Add or inspect the machine contacts used for cross-machine communication | you or an agent |

See [local squad observations](agent-state-view.md) for the status lines, tmux bar and full-screen controls.

## 6. Small programs

| Command | What it does | Who |
| --- | --- | --- |
| `sno heartbeat --label NAME [--interval M] [--log PATH] [--until-file PATH] [--max-ticks N] [--max-hours H] [-- COMMAND...]`, `--stop NAME`, `--list` | Reports every so often or waits until a file appears, for long jobs | an agent |
| `sno report-time [--in SECONDS \| --pid PID [--expect-wall S] \| "UTC TIMESTAMP" \| @EPOCH]` | Prints a clock time for the user in their zone | an agent |
| `sno subscription-quota-check [--vendor codex\|claude\|both\|cursor] [--json\|--human] [--quiet]` | Reads Codex and Claude Code subscription quota without spending any; Cursor is read only with `--vendor cursor`, not the default `both` | an agent or a timer |

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
