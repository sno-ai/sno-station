# Local squad observations

Sno Station records observations from Claude Code, Codex, Cursor and Hermes without the memory service. A reader computes activity, process presence, resume evidence and human waits when a view opens. Known Reach seats without supported capture remain visible with unknown observations, including OpenClaw.

The `sno squad` dispatcher is pending CLI integration. The Station implementation is packaged as `@snoai/memory/dist/agent-state-view.js`. The CLI integration should run that entry with Node, forward the existing global JSON option as `--json`, inherit terminal input/output, and propagate its exit code. It takes no work-set argument. Without a terminal it prints one snapshot; `--json` prints one JSON object. With a terminal, arrows or j/k select a row, Enter opens a result, Space reads local observations, r explicitly reads account quota, and q/Escape restores the terminal and exits.

For installed integrations:

```js
import { readAgentView, compactAgentView, observeAgentEvent } from '@snoai/memory/coding-skin';

const view = await readAgentView();
const segment = compactAgentView(view, { harness: 'claude', sessionId: currentSessionId });
```

`readAgentView` returns `observedAt`, `agents`, `work`, `quota` and `errors`. Agent rows expose `harness`, `sessionId`, `reachAddress`, `cwd`, `description`, `doing`, `process`, `resumable`, `waitingForHuman`, `waitingReason`, `group`, `subgroup`, `lastEvent`, `ageSeconds`, `resultId`, `humanSeen`, `finalReply`, `work`, `delivery`, `resumeEvidence` and `missingReasons`. Missing evidence is the literal `unknown`; errors retain their operation, target, cause and affected result. An unreadable primary inventory fails the command; an optional-source failure preserves usable observations.

Hooks append JSON lines under the active profile's `station/agents/`, one file per harness/session. The single record format is `{harness,sessionId,at,event,input,pid?,processStart?,reachAddress?,cwd?}`. The file name is the URL-encoded harness, `--`, URL-encoded session identity, and `.jsonl`. Nothing persists the computed groups or axes. Human inspection appends `human-seen` for a particular completion. Passive JSON/status/tmux reads never acknowledge results.

Permission and question waits take precedence over working. Ask tools precede the final-question-mark rule. An ordinary final answer proves an idle finished turn, with outcome and human-wait status unknown unless separately observed. Asynchronous question submission does not prove an answer. Old current activity and unresolved waits become unknown after the existing 900-second Reach observation horizon; their actual age and last reason remain visible. Historical completion is retained. A matching Linux PID and process-start value establishes presence; tmux attachment distinguishes detached sessions. Unsupported process inspection stays unknown. A saved vendor session record supplies resume evidence, rather than an estimate from context percentage.

Claude Code and Cursor installers compose the user's existing status command and preserve its configuration for uninstall; a later user replacement remains untouched. The user's command receives identical stdin. Its output is kept, with one final line break removed when the squad segment appends. State-render failure leaves the user's output and exit status intact. The current session is excluded by the client's actual identity. These status lines update when their client refreshes; they are not idle alarms.

Reach-created tmux sessions append a local command to their session's inherited `status-right`. ACP sessions, global options and unrelated sessions are unchanged. Refresh uses tmux's own redraw facility, with no new watcher. See the [tmux manual](https://man.openbsd.org/tmux.1) for its session attachment and status formats. Missing display components leave the agent running.

Quota is read only through the existing subscription reader on explicit full-screen refresh. Local redraw, JSON, status lines and tmux do not probe account endpoints. Unknown, unauthenticated and not-applicable results retain their meaning; a reader failure is not exhaustion.

Work discovery reuses Reach message headers and its existing progress parser. Released handoff ownership needs the actual work/message and both agents associated with the release. That association and the public CLI dispatcher remain pending; readiness and a generic release category do not establish transfer. Live model/visual journeys still need authenticated disposable client profiles.
