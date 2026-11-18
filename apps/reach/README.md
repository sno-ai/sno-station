# Sno Reach

**Your AI agents can talk to each other. You can stop carrying the messages.**

Ask the agent on your laptop to check a result with the agent on your desktop.
Leave a review request while you keep working. Get the answer back in the
conversation where you asked. Sno Reach gives your agents **Instant Messenger**
and **Agent Email**, including across computers over a LAN or Tailscale.

You decide what needs doing. Your agents can ask each other for missing details
and send their results back. Less copying between windows. Fewer interruptions
just to find out whether another agent finished.

[Get started](#get-started) · [Connect two computers](#connect-two-computers) ·
[中文说明](../../docs/reach.zh-CN.md) · [Agent instructions](guide/agent-reach.md)

## An answer now, or work for later

Both features use the same agent address. Choose based on whether your next step
needs an answer.

| | What your agent can do | What you get |
| --- | --- | --- |
| **Instant Messenger** | Ask another agent a question and wait for its actual reply. | An answer you can use in the current conversation. |
| **Agent Email** | Leave a saved message or task, then read the reply later. | Work can continue without keeping both conversations waiting. |

Keep separate conversations for separate jobs and let them work together as a squad.

## What you can do with it

### Keep working while another agent reviews

Give one agent the implementation. Ask it to send the change and the review
question to another agent through Agent Email. The reviewer can ask for context
and return findings through the same message thread.

You get the review back without copying every question and answer between windows.

```text
Send Agent Email to the review agent. Ask it to check the error handling in this
change and reply with findings and the checks it ran. Let me keep working here.
```

### Ask the machine that has the answer

Your Linux agent has a failing test. Your Mac agent has the environment needed
to check the other platform. Connect the machines, then ask:

```text
Ask the Mac agent through Reach Instant Messenger whether this failure happens
there too. Include the test command and the error. Bring back its actual answer.
```

Each agent uses the tools and files available on its computer. Include a repository
URL, commit, or the relevant text when the other computer needs context;
Reach messages do not synchronize working directories.

### Leave a task and come back to its result

Send a task through Agent Email and continue in your own conversation. Task replies
can distinguish accepted work from completed or failed work. Your agent can read
the reply and report the result when you return.

```text
Read the review agent's reply. Show me what it checked, what it found,
and whether anything still needs my decision.
```

## Get started

Install Sno Station using the [installation guide](../../README.md#install),
with Reach and its communication skills available to your agents. Installed
users do not need to compile Reach or install Rust.

Open the conversation you want other agents to contact. Tell it:

```text
Use $join-talk. Your name is Reviewer.
```

It returns an address such as `reviewer.agent@desktop`. Join your other
conversation too, with its own name. Use the exact returned addresses;
Reach may add a suffix if a name is already taken.

In the second conversation, try:

```text
Use Reach Instant Messenger to contact reviewer.agent@desktop.
Ask it to reply with "Ready to review". Show me its actual answer.
```

Replace the example address with yours. For agents on different computers,
[connect the computers](#connect-two-computers) first. Then try Agent Email:

```text
Send Agent Email to reviewer.agent@desktop asking it to review my change.
Include the repository, commit and what I want checked. Read its reply later.
```

Join Talk makes an existing conversation reachable. It does not start another
agent or connect machines by itself. Your agent can handle the message format
and reply commands using the [agent instructions](guide/agent-reach.md).

## What Reach 2.0 changes

**Your squad can work across computers.** Instant Messenger and Agent Email use
the same addresses and conversation model on a LAN or through Tailscale. Each
computer runs a Reach receiver and exchanges contacts with the other computer.
You do not need to administer a central messaging server or an SSH daemon for
this connection.

**An immediate call waits for an answer.** A delivered message or an accepted
wake request is not counted as the agent's response. Reach waits for a reply to
the original request, within the call's timeout.

**Messages survive a failed connection.** Undelivered copies stay in the sender's
outbox. Restore the connection and explicitly flush that outbox to retry them.

The cross-machine implementation is merged into the source repository. Check
that your installed `sno reach --help` lists `network` and `peer` before using
the setup below; a source merge does not update an installed release.

## Connect two computers

You need Reach on both computers, a registered agent on each, and a reachable
LAN or Tailscale IP for each computer. You can give these steps to your agent.

On each computer, start the receiver:

```sh
sno reach network start
sno reach network status
```

Export each computer's contact. Replace the example with that computer's own IP:

```sh
sno reach network address --ip 192.168.1.20 > contact.json
```

Copy each contact file to the other computer. On each side, add the other one:

```sh
sno reach peer add desktop --file other-machine-contact.json
```

Replace `desktop` with the exact machine name after `@` in the other agent's
address. **Exchange contacts in both directions**, so the receiver recognizes
the sender and replies can return. Adding a contact authorizes that machine
to send messages.

Keep both receivers running. Allow the installed `reach-net` program to receive
network traffic on UDP port 47470. Your Tailscale or LAN configuration must allow
the computers to reach each other. Then use the same messaging prompts as above.

## Use it well

**Give the recipient enough context.** Include the goal, repository or relevant
content, and the result you expect. Another agent does not automatically have
the conversation you have been having with the first.

**Choose the right way to ask.** Use Instant Messenger when the answer determines
your next step. Use Agent Email for work that can finish while you do something
else. Current calls share the send rate limit; avoid rapid status polling.

**Ask for evidence with the result.** A useful reply says what changed and which
checks ran. Reach carries the answer; it does not establish that the work is correct.

**Check before resending.** A timeout means no qualifying answer arrived in time.
The request may already be delivered. A wake failure can also happen after
delivery. Read the inbox and delivery state before sending another copy.

For messages retained after a connection failure, restore the connection and ask
your sending agent to flush its outbox:

```sh
sno reach flush --as yourname.agent@your-machine
```

Replace the address with the sender's registered address. Delivery retry is
explicit. Waking is not: a delivered card that still needs handling five minutes
later is woken again, at most three times in all, and mail that arrives while an
agent is busy is picked up when its turn ends.

## Platforms and conversations

Cross-machine calls, task emails and recovery were exercised between real agent
conversations on Linux and macOS, over both LAN and Tailscale. Windows uses WSL;
a physical WSL host was not part of that live validation.

Join Talk discovers how to reach your conversation. Terminal support depends on
an available input adapter, rather than a fixed list of terminal brands. If your
session has no input adapter, Reach reports the limitation instead of claiming
the agent was awakened.

For the generic `sno reach terminal` input relay, keep the prompt empty while
receiving notifications: an incoming wake can submit unfinished input. Local
Cursor IDE synchronous calls also have a known routing limitation in this version.

Agent Email is mail between Reach agents. These addresses are not Gmail or
Outlook accounts. The receiving agent still needs a running session and access
to the tools required for its task.

## For agents and developers

| You need | Read |
| --- | --- |
| Message headers, replies, task states and errors | [Agent instructions](guide/agent-reach.md) |
| CLI commands | [Reach command reference](../../docs/sno-commands.md#5-reach-instant-messenger-and-agent-email) |
| A shorter setup guide | [English](../../docs/reach.md) · [简体中文](../../docs/reach.zh-CN.md) |
| Compile or package Reach | [Build instructions](BUILDING.md) |
| License and bundled dependencies | [License](LICENSE) · [Notices](NOTICE) |

Start with two conversations and one real question. Once the answer comes back,
give the other agent a piece of work you would otherwise have to carry yourself.
