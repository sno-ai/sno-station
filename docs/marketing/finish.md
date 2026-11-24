# Finish messaging copy

## Naming

Sno Station has four parts. Write them without a "Sno" prefix: **Mem**, **Reach**,
**Finish**, **Learn**.

This part: **Finish**.
Feature name: **Timed tasks**. Chinese explanation: **定时任务**.
Keep the English names unchanged in translations.

Finish is the promise, not a program. It covers timed tasks, watching a long run, and
continuing after a usage limit. The command stays `sno heartbeat`.

## Headline

Say when. An agent shows up.

## Short description

Give your agent a task and a time, then leave. At that time an agent starts and does
the work, with the conversation open or closed. If it cannot, it tells you why.

## Feature descriptions

**Timed tasks**

Tell your agent "tomorrow at 9" or "every morning at 7". You do not write a schedule
file. The agent that knows the task is the one that comes back to it.

**A long run watched**

Ask your agent to look at a job every few minutes until it ends. You get the result,
not a terminal to stare at.

**Work that outlives a usage limit**

When one agent runs low, a different agent continues from the same commit.

## Lines that work

- You closed the conversation. The task did not notice.
- It said nine. At nine it was working.

## Call to action

Say one sentence with a time in it to your agent. Then run `sno heartbeat --due` and
see it on the list. [How to use Finish](../finish.md).

## Copy boundaries

Do not promise that every task finishes. The promise is that it starts on time, and
that a task which did not start or did not finish says so with a reason.

Do not say "after a reboot" until a full restart of a computer has been tested. Closed
conversations and a restarted service are tested.

Timed tasks start Claude Code and Codex only. Do not list the other agents here.

"On time" means within about a minute. Do not write "to the second".

The computer has to be on and awake. Do not write "even with the laptop closed".

A timed run is never given more than its conversation had. Do not write that it "runs unattended with full access".

User instructions: [English](../finish.md) · [简体中文](../finish.zh-CN.md).
Agent behavior: [Heartbeat guide](../../apps/heartbeat/README.md).
