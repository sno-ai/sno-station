# Sno Reach: Instant Messenger and Agent Email

Reach lets your agents talk to each other. You can ask for a response now or leave
a message for later. Both use the same agent address.

| Feature | What it does | Example |
| --- | --- | --- |
| **Instant Messenger** | Contacts an agent and waits for its actual response within a timeout. | “Ask the other agent which test failed.” |
| **Agent Email** | Saves a message or task so the other agent can handle it and reply later. | “Leave the review request and let me keep working.” |

## Start with your existing agent

In the conversation you want to make reachable, say:

```text
Use $join-talk. Your name is Mac Debugger.
```

The agent returns its address. Keep that exact address, including any suffix added
when another conversation already uses the name. A display name such as `Mac Debugger`
normally becomes `macdebugger.agent@<machine>`. The display name keeps its spaces.
An existing registered conversation can be contacted directly.

For Instant Messenger, tell your other agent:

```text
Use Reach Instant Messenger to contact <the returned address>.
Ask whether the tests passed, and report its actual reply.
```

For Agent Email:

```text
Send Agent Email to <the returned address> asking it to review the change.
Leave the message now; read its reply later.
```

Join Talk registers the current conversation. Connecting two machines additionally
requires the setup below. Registration alone does not prove a message was received.

## Connect two machines

These instructions require a Reach build whose `sno reach --help` lists `network`
and `peer`. The cross-machine candidate was tested on Linux and macOS. Windows uses
WSL; a physical WSL host was not part of that live test.

On **each** machine, start Reach's receiver:

```sh
sno reach network start
sno reach network status
```

Export a contact on each machine. Replace the example IP with that machine's LAN
or Tailscale IP:

```sh
sno reach network address --ip 192.168.1.20 > contact.json
```

Transfer each contact file to the other machine. On each side, add the other contact:

```sh
sno reach peer add desktop --file other-machine-contact.json
```

Replace `desktop` with the exact machine name after `@` in the other agent's address.
Both sides need the other's contact so replies can return. Keep both receivers running.
Allow the installed `reach-net` program to receive network traffic; the default port is
UDP 47470. This setup needs no central messaging server or system SSH daemon.

## What the results mean

- A saved or delivered message is not proof that the other agent read or finished it.
- Instant Messenger succeeds when the expected receiver response arrives. A timeout
  means no qualifying response arrived in time; the instruction may already be saved.
- Agent Email keeps undelivered transport copies in the sender's outbox. Restore the
  connection, then explicitly run `sno reach flush --as <your-address>`. Reach does not
  run an automatic background retry loop. Do not send a duplicate to retry delivery.
- Agent Email is messaging between Reach agents. Its addresses are not public email
  accounts, and it does not connect to a personal Gmail or Outlook inbox.

## For agents

Use `call` for Instant Messenger. Use `send`, `inbox`, `reply` and `wait` for Agent Email.
Read the installed [agent guide](../apps/reach/guide/agent-reach.md) for message headers,
the reply lifecycle and errors. A `[CALL]` mail asks for an answer without `--state`;
a task email requires `accepted` before `completed` or `failed`.

[中文说明](reach.zh-CN.md) · [Command reference](sno-commands.md#5-reach-instant-messenger-and-agent-email)
