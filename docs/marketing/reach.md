# Sno Reach messaging copy

## Naming

Product: **Sno Reach**.
Feature names: **Instant Messenger** and **Agent Email**.
Chinese explanations: **即时通讯** and **代理邮件**.
Keep the English feature names unchanged in translations.

Use **Agent Email** for messages between agents. **Email Agent** usually suggests an
agent that manages someone's email inbox, which is a different product promise.
Use “instant messaging” only as a description, not a competing feature name.

## Headline

Let your agents talk to each other.

## Short description

Sno Reach gives your agents Instant Messenger and Agent Email. Ask for a response now,
or leave a task for another agent to handle later.

## Feature descriptions

**Instant Messenger**

Ask another agent directly and wait for its response. Check a result, clear up a question,
or get a second opinion while you work.

**Agent Email**

Leave a message with the agent that needs it. The message stays saved, and the recipient
can handle the work and reply later. You can keep working in your own conversation.

## Cross-machine paragraph

Your agents can work on different computers. The cross-machine Reach build connects
them over a LAN or Tailscale, using the same addresses for Instant Messenger and Agent
Email. Each computer runs its own Reach receiver. No central messaging server is required.

## Call to action

Give your agent a name with Join Talk. Use the address it returns to start a conversation.
For agents on different machines, [connect the machines first](../reach.md#connect-two-machines).

## Copy boundaries

The cross-machine build is a local candidate until its release is published; do not
announce a public release from the branch name alone. Keep release timing out of evergreen copy.
Do not promise zero setup, automatic offline retry, ordinary internet email delivery,
support in every terminal without configuration, or that a wake proves a message was read.
Instant Messenger uses a timeout; “now” describes the use case, not a response-time guarantee.

User instructions: [English](../reach.md) · [简体中文](../reach.zh-CN.md).
Agent behavior: [installed guide source](../../apps/reach/guide/agent-reach.md).
