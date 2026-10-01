# Utility installed-command proof

This is QCG-7 of the utility-programs PRD. The host shell launches the installed
programs through `$HOME/.local/bin`; each link resolves through the app's `current`
link to `releases/<version>/bin/<program>`. The repository source and the older workshop
commands are different identities. The runner rejects those identities.

Installation and preservation of any existing regular-file command happen before
the runner. The parent executor owns those steps. No test performs installation into
the real home. A temporary-home install is covered separately by release-proof.sh.

## Preconditions and observations

| Check | Command | Expected result | Failure calibration | Owner / field |
|---|---|---|---|---|
| Host | `hostname` | `gpt1` | Another host is outside the admitted journey | Executor / host |
| App identity | `command -v`, `readlink -f`, `sha256sum`, `VERSION` | Each installed core executable at the version in the repository VERSION file, not workshop source | QCG-7 temporarily points heartbeat current at an empty directory | Core / installed-identity |
| Vendor build | `codex --version`, `claude --version` | Bounded successful output | Missing CLI exits nonzero | Machine owner / installed-identity |
| Login state | `codex login status`, `claude auth status` | Both commands exit 0 | Do not revoke shared credentials; absent login requires separate owner repair | Machine owner / vendor-login |
| Subscription path | Test `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are empty | No raw API credentials override subscription use | An injected sentinel in a child environment makes the predicate false; never print values | Executor / subscription-environment |
| Mutation capability | `test -w "$HOME/.local/lib/sno-heartbeat"` | Link can be replaced and restored | Read-only parent would fail before mutation | Executor / writable-link-directory |

`utility-e2e-preflight-<Pacific-date>.md` records all check output and return codes, without stopping at the
first failure. `preflight.sha256` binds that artifact and `identity.txt`; the journey
checks both before starting and compares app/vendor identities after restoration.
Version output is observed at run time, never copied from a previous session.
No model is called. The only live quota request is the installed command in the
journey. Its supported unreadable and needs-auth outcomes remain valid QCG-7
outcomes; a status command alone does not prove that a vendor quota request succeeds.

## Run

```sh
bash tests/apps/heartbeat/utility-e2e.sh preflight <reports-directory>
UTILITY_E2E_ALLOW_LINK_MUTATION=1 bash tests/apps/heartbeat/utility-e2e.sh journey <reports-directory>
```

The mutation must be announced by the parent before invoking the journey. It affects
only the heartbeat current link for the immediate two negative calls. A trap restores
the original link on all normal shell exits. No vendor credential or shared heartbeat
registry is modified. The test uses its own `HEARTBEAT_STATE`, owner and label.

The test observes two real arm/stop runs, the reader instruction, tick log, STOPPED
output, two failing calls through the broken link, and one final vendor response.
Unreadable and authentication responses prove the installed failure path, not a usage reading. A
ninety-second limit applies to first-tick observation and the vendor command. The
parent applies an outer journey timeout and records any failure as source,
environment, stuck, or harness in its journey evidence; no failed run counts as
acceptance. Host restart, executable change, credential change or a dependency
change outside the declared link mutation invalidates the preflight.
