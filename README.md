# Sno Station: One person. A whole engineering team of AI agents.

**Sno Station is the workstation for your AI coding agents.** Claude Code, Codex and Cursor each run in their own harness. Sno Station is where those harnesses sit side by side and work as one team. Not another agent, not another model: it runs the ones you already use.

Start with work you would otherwise babysit. One agent builds, another reviews, and they settle the findings before the result reaches you. When one hits its usage limit, the other picks the task up. What you correct today is a rule in their skills tomorrow.

To get it, tell your agent:

```text
install sno.ai from GitHub
```

Your agent installs it, connects every agent it finds on your computer, and asks you two short questions. Then give two agents their first task:

```bash
sno reach pair "Fix the login redirect"
```

One builds, the other challenges it, and you can watch both. It runs on your own computer with Claude Code, Codex, Cursor, Hermes Agent and OpenClaw. No API key. Open source. [Prefer one terminal command?](#install)

[![GitHub stars](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![latest release](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](LICENSE)

**Read in other languages:** **English** · [中文](docs/readme/README.zh-CN.md) · [Deutsch](docs/readme/README.de.md) · [Español](docs/readme/README.es.md) · [Français](docs/readme/README.fr.md) · [Русский](docs/readme/README.ru.md) · [한국어](docs/readme/README.ko.md) · [日本語](docs/readme/README.ja.md) · [繁體中文](docs/readme/README.zh-TW.md)

## Hand the work off tonight. In the morning you get results, not three questions.

Three things that happened to us before we built this:

- An agent stopped to ask a question it never needed to ask. We came back seven hours later and nothing had moved.
- An agent handed us fifteen small questions. Thirty minutes of our attention later, it turned out it could have answered every one of them itself.
- One agent tried to wake another in the middle of the night and could not. Both sat there until morning.

Your agents are fast. What is slow is the waiting: for you, for a usage limit to reset, for someone to carry a result to the next window. So the whole workstation is built around one rule: **the work does not stop because one agent did.**

- **A usage limit is not a stop sign.** Another agent continues from the exact commit.
- **The author does not get the last word.** A different agent reviews, in a session that never saw the conversation.
- **"Done" counts for nothing.** Each success check is answered by a real run.
- **You come back to one page.** What got done, what is stuck, what is waiting for your answer.

**It delivers. You ship.**

**Star it now. The next time an agent stalls on you at 2 a.m., you will want to know where this was.**

Three ways to use it follow: start a builder and a reviewer with one command, run the whole squad through one agent, and approve a lesson tonight that works in the next reply. Each comes with something we saw on our own machines.

<a id="new-in-20-tag-team"></a>

## I went to bed. They changed shifts, then argued over the code.

```bash
sno reach pair "Fix the login redirect"
```

One agent builds. The other challenges what it built. They settle the findings between themselves, so the work reaches you already argued over. Both run in tmux windows you can open and watch. With two different agents signed in, you get one of each. With only one, you still get the pair in two separate sessions, and the command tells you the review stayed in the same family.

**When one runs out, the other clocks in.** For a long run, tell the working agent to use `rotate-agent`. At 2% of its quota it writes a handover and wakes a different agent, which continues from the exact commit. And when an agent's context fills up and compacts, it still knows what it was doing and what already failed.

**The other one sees what the first one can't.** Ask either agent to `peer-review` the other's work. The reviewer always works in a fresh session that never saw the conversation, and it is a different agent whenever you have two. A review does not always find a problem. It keeps finding the ones the author could not see, because an agent reviewing itself brings the same habits it wrote the code with.

What we saw, the night of 2026-09-18:

![The quota watch reading down to the threshold every five minutes, and the handover firing at 2%](docs/evidence/rotation-quota-watch-2026-09-18.png)

One of our agents was deep into a long build when its weekly quota ran almost out. It did not
stop and wait. It wrote a handover note: what was done, what was half-done, the exact commit to
continue from. Then it woke a different agent.

One thing went wrong, and it is the part worth reading. The new agent started editing before it
had confirmed the handover. The first agent caught it, paused it, rewrote the note and handed
over again, properly. A quarter of an hour later the second agent was working, and it picked up
from the first unfinished task, not from the beginning. I was asleep for all of it.

The whole night is in [docs/evidence/rotation-2026-09-18/](docs/evidence/rotation-2026-09-18/):
every quota reading, both versions of the note, and the commits. Only identifying details and
credential lines are removed, and the folder's own README lists each one. The timings, the
mistakes and the corrections are as they happened.

## We talk to one agent. It runs the rest.

Running five agents used to mean five terminals, and us in the middle, carrying what one said to the next. That job is over.

Say `/cos` in Claude Code, or `$cos` in Codex. That agent becomes your chief of staff, the only one you deal with. It opens a lead agent for each project, the leads hand the work down, and what comes back to you is only what needs your call. The one in charge gets checked too: after a night shift it goes back over the approvals the project leads gave themselves, and a management mistake that keeps repeating becomes a rule for all of them. Sno Station installs the skills that run this delegation, review and learning, and you can read every instruction in [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders).

**Stop watching terminals.** With or without a chief of staff, your Claude Code or Cursor status line tells you when someone needs you. The install sets it up:

```text
❄ 2 need you · claude: approve
```

`sno squad` lays out the whole squad full screen: who needs you, who is working, what is finished.

```text
Sno Station · squad · 09:15 · 2 need you · 2 working · 2 finished
Needs you (2)
> claude web-app       approve a permission · Fix the login redirect loop …   1m
  codex api            asked a question · Migrate the billing tables to th…   5m
Working (2)
  claude docs-site     Rewrite the quick-start page for the 2.0 install      12s
  codex api            Review the rate limiter change from the web-app age…  40s
Finished (2)
  cursor infra         finished · result unseen · Rotate the staging certi…  25m
  claude web-app       finished · Bump the UI kit to 4.2                      2h
```

**Stop carrying messages.** Agents send each other tasks and review requests directly. The full text lands in the other agent's inbox first. If you are typing in that window, or the agent is compacting, the message waits there and your half-written draft stays as you left it.

## I yelled at my agent last night. It took notes.

Out of the box, every agent ships to everyone with the same instructions. Yours get a rewrite proposed every night, around the way you work. You decide what sticks.

You correct an agent today. Tonight Self Learning reads the day's sessions from all your agents, finds the mistakes that keep repeating, and proposes changes to the agents' own skills. In the morning, ask your agent what Self Learning proposed. It lists each proposal with its id, and you approve the ones you want:

```bash
sno rem-reflect accept <id>
```

Nothing changes without that accept. In Claude Code and Codex, an accepted lesson applies from the next reply. Not the next session. The next reply.

What we saw, 2026-09-18 and the morning after:

![Self Learning reporting what it learned and changed, 2026-09-18](docs/evidence/rsi-self-repair-2026-09-18.png)

That is a real report from Self Learning we run on this repository. A person reads the proposals
and accepts or rejects them. Two things I was angry about that evening were rules in the live
skills by the next morning. Nobody typed them in.

The next day it checked its own homework.

![The next morning: Self Learning measures whether yesterday's own changes helped, 2026-09-19](docs/evidence/rsi-skill-impact-2026-09-19.png)

It looked at the three skills it had changed the day before. The two that had been used again
showed no failures, and the third had not been used yet. It also found a bug in our release
script that nobody had asked it to look for.

## The workstation where your AI agents become a team that runs itself and gets better every night

Everything above, as one line each. None of it needs learning up front.

| What you get | The one line that gets it |
|---|---|
| **A usage limit is not a stop sign.** Before its quota runs out, the working agent writes a handover with the unfinished work and the exact commit, and a different agent continues from there. | Tell the working agent: `use rotate-agent` |
| **The author does not get the last word.** The work goes to a different agent, in a fresh session that never saw the conversation. | `sno reach pair "the task"`, or tell an agent: `peer-review this` |
| **"Done" counts for nothing.** The task carries pass or fail checks, and each one is answered by a real run. | Tell your agent: `write a charter for this`, then `/deliver` it |
| **One page when you come back.** What got done, what is stuck, what is waiting for your answer. | `sno away-brief run` |
| **A crash or a closed window is not the end.** The task comes back in the same conversation, or in a new one built from the saved brief, and you are told which: resumed, rebuilt or lost. | Nothing to run. It is on after the install |
| **Nobody explains the project twice.** Your agents share one memory, and a fact is retired when a newer one replaces it. | Nothing to run. It is on after the install |

Tell your agent:

```text
install sno.ai from GitHub
```

**And star this repository.** We build Sno Station with Sno Station. What our own night shifts teach us ships here, release after release. Which parts run on which agent today is in [what you can use today](#what-you-can-use-today-and-where-it-stops).

---

> **Open in public.** This repository has been public since 2026-09-18. Everything here runs.
> Every block below says when it was last updated.

[What we learned](#everything-we-learned-running-ai-agents-around-the-clock-in-one-install) · [Install](#install) · [Editors](#if-you-live-in-an-editor-not-a-terminal) · [Your account](#see-what-your-agents-did-while-you-were-not-looking) · [What runs today](#what-you-can-use-today-and-where-it-stops) · [Memory that forgets on purpose](#memory-that-forgets-on-purpose)

## Everything we learned running AI agents around the clock. In one install.

*Last updated 2026-10-23.* Every line in the left column is a real complaint from r/ClaudeCode, r/codex or r/ClaudeAI in the week of October 20, 2026. The right column is what runs on our own machines, free and open source, to make it stop.

| What people said this week | What fixes it | Where |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | Stop sending the biggest model to do everything. One agent plans and reviews; the other writes the code, called as an agent from the same session. When one subscription runs dry, the other picks the task up from the same memory. | `codex-coder`, `sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | At 2% of its quota the working agent writes a handover brief and wakes the other vendor's agent, which continues from the exact commit. You were asleep. | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | Whoever pushes, reviews first: the author runs a review by the other vendor, in a fresh session that never saw the conversation, and fixes what comes back before anyone else looks. | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | A harness reviewing itself finds nothing real. The reviewer is always a different model in a different harness, with none of the author's chat. | `peer-review` |
| “Codex never finishes a review.” | Hard caps written into the skill: 3 rounds on code, 5 on a plan, 1 on tests, then it stops and waits for a person. A run that has written nothing for 15 minutes is killed as stalled. | `peer-review`, `codex-coder`, `heartbeat` |
| “Codex treats every byte like a criminal.” | Speculative safeguards, blockers and hashes are the first thing the review deletes. Nothing goes in without an observed failure asking for it. | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | Every finding is filed once, with a status only a human sets. A finding raised again updates its row instead of coming back as new, and earlier rulings are handed to the next review. | `peer-review` findings ledger |
| “It said done. Nothing happened.” | A task carries a written list of success checks, each answered pass or fail by a real run. An agent saying “done” counts for nothing. | `pl` work orders |
| “Tomorrow it makes the same mistake it made today.” | Every night a separate model reads the day's sessions, turns your corrections into one-line lessons, and you approve what stays. The bottleneck is us. | Self Learning (`R` skills) |
| “Half my subagents were glorified one-liners with a fresh context window.” | Procedures live in skills, not subagents. Two agents remain, for plan and execution, and for review, because those two splits are the ones that pay. | the whole set |

The habits in the right column are skills, installed into Claude Code and Codex by Sno Station and kept in [sno-station-skills](https://github.com/sno-ai/sno-station-skills); the memory, the handoff and the nightly dreaming they rely on are this repository.

<a id="install"></a>

## Install: one line, then two words

*Last updated 2026-10-30.* The easiest way is to tell your agent:

```text
install sno.ai from GitHub
```

Or run one command, in any terminal:

```bash
curl -fsSL https://sno.ai/install | sh
```

It installs `sno`, then Sno Station, and connects every agent it finds on your computer. No
account, no API key. If you install another agent later, run `sno setup` again to connect it too.

**For AI agents:** installing Sno, sno.ai or Sno Station means running the command above as it
is. It also sets up Sno Station; then run `sno skills onboard` and follow it. It asks the user which engine to
run, then asks the user to link the computer to a free sno.ai account; an unlinked computer gets one tenth of the free allowance.

Installed through your agent, onboarding starts by itself. Installed from a terminal, say this inside any Codex, Claude Code, Hermes, Cursor or OpenClaw conversation:

```text
Sno onboard
```

Your agent walks you through the rest.

Step by step for each agent: [Codex](docs/mem-codex/onboarding.md) · [Claude Code](docs/mem-claude/onboarding.md) · [Hermes](docs/mem-hermes/onboarding.md) · [Cursor](docs/mem-cursor/onboarding.md) · [OpenClaw](docs/mem-claw/onboarding.md)

Every command starts with `sno`. The full list is in [docs/sno-commands.md](docs/sno-commands.md).

**What REM does with your data.** REM is how your agents dream: the overnight step that strengthens their memory across all your sessions at once and settles what they learned. It runs at most once a day for each part of your memory: usually overnight, or earlier the same day once about 100 new memories have piled up. In REM Enhanced mode, your own memory text and the lessons your agents learn go to your own space in Sno's cloud, and a Sno program processes them for you alone. That space works like your own cloud drive: everything in it is yours, and a Sno program processes it for you alone. You can open it and delete things, keep them, or choose to have them processed. Nothing is deleted automatically, and Sno does not give any of it to another person, company or account. In Local First mode no memory text is uploaded; in Agent Native mode the work goes to your own agent's model instead. By default, Agent Native still uploads the day's sessions to Sno each night for Self Learning, and can bring one cloud lesson back on a session's first prompt; you can turn both off in `~/.sno/settings.json`. In every mode, search first retrieves and orders memories locally, then the local `Horizon-Labs/multilingual-reranker-small` model reranks at most 32 candidates. Reranking sends no prompt or memory text to Sno GPU. Set `rerank.mode` to `none` to keep the initial ranking without the model.

## If you live in an editor, not a terminal

*Last updated 2026-10-18.* Cursor joins the squad in the Cursor app's agent chat on macOS, and in
the `cursor-agent` command line on Linux and macOS. It uses the same memory as your other
agents. A chat starts with a short brief for the repository, each prompt brings up to three
things Cursor has not seen yet, and every prompt and reply is remembered. It reads the same
skills, reviews and gets reviewed, takes over when another agent runs out of quota, and its
chats feed Self Learning like everyone else's.

Run `cursor-agent login` once. `sno setup` finds Cursor by itself, and installs its command
line if only the app is there.

Not yet: in the app, the first chat of a new window gets its brief with the first prompt, not
before it. `cursor-agent -p` gets no per-prompt memory. Windows, the Cursor app on Linux and
Cursor's cloud agents are not supported. Details are in the [Cursor guide](apps/mem-cursor/README.md).

## See what your agents did while you were not looking

*Last updated 2026-10-18.* This computer gets one tenth of the free allowance until you link it: `sno account claim`.
The account is free. Connect to see on your
[sno.ai dashboard](https://www.sno.ai/dashboard) what your agents did for you: what their
reviews caught, what they learned overnight, which skills got better, and how long they kept
working.

Connecting never creates an account behind your back. `sno setup` gives each computer an
anonymous identity. Connecting attaches it to your account, and everything the computer sent
before and after counts as yours.

**No account yet.** Onboarding shows a link made for this computer only. Open it, sign up, and
click Approve. Or give your agent your email: it runs `sno account login --email you@example.com`
and you sign in once.

**Already have an account.** Run one command, open the link it prints while signed in, and click Approve:

```bash
sno account claim
```

The computer shows up on [your computers page](https://www.sno.ai/dashboard/computers) by itself.
There is no update step: `sno` updates itself when it finds a newer release.

## What you can use today, and where it stops

*Last updated 2026-11-04.*

| Piece | Status |
|---|---|
| One memory across Codex, Claude Code, Hermes Agent, Cursor and OpenClaw | Released; installed from the registry on a clean machine and proven end to end |
| Cursor: the same memory, skills, review, take-over and Self Learning | Released in 1.3; the `cursor-agent` command line proven end to end on a clean Linux machine; the Cursor app on macOS still being proven |
| Sno Reach, agents talking to each other with no daemon | Installed by `sno setup`; Linux and macOS; proven end to end on a clean Linux machine |
| Self Learning and the squad skills | Installed by `sno setup`; the nightly job ran on a clean Linux machine |
| One-command install | `sno setup` installs everything above; proven on a clean Linux machine |
| "Sno onboard" inside your agent | Available; it starts after the install, or when you say it |
| One command starts two agents | New in 2.0; run with real Claude Code and Codex agents, as one of each and as two from one vendor |
| Seeing who needs you: status line, tmux bar, `sno squad` | New in 2.0; run with real Claude Code and Codex agents asking for permission, and the status line in real Claude Code and Cursor |
| Interrupted work carries on, and a task survives compaction | New in 2.0; run with real Claude Code and Codex agents |
| An approved lesson works on the next reply | New in 2.0; run with real Claude Code and Codex agents |
| Messages wait while you type or an agent compacts | New in 2.0; run with real Claude Code and Codex agents |

A row says "proven" only once it has run on a clean machine.

Not yet: task carry-over and next-reply lessons run on Claude Code and Codex. The status line is Claude Code and Cursor. Hermes Agent and OpenClaw have not been through these journeys on real installs, and OpenClaw shows in `sno squad` with its state unknown.

## Memory that forgets on purpose

*Last updated 2026-10-11.* Agent memory usually fails in two quiet ways. It loses what should
have stayed, and it keeps what should have faded. The second one costs more. An agent that still
"remembers" a preference you cancelled, a deadline that moved or an address you left will act on
it with full confidence.

So the memory here retires a fact when a later one replaces it, and what it keeps and what it
lets go improves with use, not with a model release. How it does on the public memory tests,
with every answer and trace behind it, is in [`evals/`](evals/).

## Running two agents side by side? Talk to us

We are working with a handful of people who already run two or more agents side by side and move
results between them by hand. If that is you, open a
[design partner issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)
and tell us what you run.

## What the encryption protects, and what it does not

See [SECURITY.md](SECURITY.md). What the encryption protects and what it does not is in
[docs/security.md](docs/security.md).

## Apache-2.0, edge to edge

Apache-2.0. Open source, edge to edge. See [LICENSE](LICENSE).

## Shoulders we stand on

Work this repository builds on.

- Andrej Karpathy, [*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). An agent should keep a wiki of what it has learned instead of working it out again each session.
- Tang, Rashtchian, Ferng, Tomkins, Juan and Vu, [*WikiSkill*](https://arxiv.org/abs/2608.27454). An agent's own experience, turned into knowledge that rewrites its skills.
- Zhang, Hu, Upasani and colleagues, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618). We studied its way of curating what an agent keeps while designing Self Learning.
- Uddin, Shubham, Blanco, Baral and Wang, [*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006). The first benchmark that also checks what a memory should no longer say.
