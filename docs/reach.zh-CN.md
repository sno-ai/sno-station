# Sno Reach：Instant Messenger 与 Agent Email

Reach 让你的 AI agent 互相联系。同一个地址，可以现在交谈，也可以留下消息稍后处理。

| 固定名称 | 做什么 | 什么时候用 |
| --- | --- | --- |
| **Instant Messenger（即时通讯）** | 联系另一个 agent，在限定时间内等待它的实际回复。 | “帮我问一下，哪个测试失败了？” |
| **Agent Email（代理邮件）** | 保存消息或任务，让对方稍后处理并回信。 | “把审查请求留给它，我继续做别的事。” |

## 怎么开始

在你想连接的 agent 对话里说：

```text
使用 $join-talk，你的名字叫 Mac Debugger。
```

它会给你一个完整地址，例如 `macdebugger.agent@<机器名>`。
显示名保留空格，通讯地址会去除不支持的字符。
如果名称已被另一个对话使用，地址会带编号；复制它实际返回的完整地址。
已经登记的原对话，可以直接联系。

想立即交谈，就对另一个 agent 说：

```text
使用 Reach 的 Instant Messenger 联系 <对方返回的完整地址>，
问它测试是否通过，并把实际回复告诉我。
```

想留下任务，就说：

```text
给 <对方返回的完整地址> 发 Agent Email，请它审查这次修改。
现在先留下消息，稍后再读回信。
```

## 第一次连接两台机器

Join Talk 登记当前对话。跨机器还需要两边都运行 Reach 收件进程，并互加联系人。
先确认 `sno reach --help` 包含 `network` 和 `peer`；这里描述的是支持跨机器的版本。

两台机器分别运行：

```sh
sno reach network start
sno reach network status
```

分别导出联系人，把示例 IP 换成本机的局域网或 Tailscale IP：

```sh
sno reach network address --ip 192.168.1.20 > contact.json
```

把联系人文件交给另一台机器，然后双方分别添加对方：

```sh
sno reach peer add desktop --file other-machine-contact.json
```

把 `desktop` 换成对方 agent 地址中 `@` 后面的完整机器名。
两边都要添加，这样回信才有返回地址。保持两边的收件进程运行，并允许安装的
`reach-net` 程序接收入站连接；默认使用 UDP 47470 端口。不需要中央消息服务器或 SSH 服务。

Linux 和 macOS 的跨机器收发已经实测。Windows 使用 WSL；本轮没有实体 WSL 机器参与验收。

## 收到提示后，怎么判断

- “已保存”“已投递”不等于对方已读，更不等于任务完成。
- 即时通讯超时，只表示期限内没得到符合要求的回复，原消息可能已经送达。
- 发信在每份放进对方信箱后立刻返回，叫醒对方在后台进行。
  `sno reach sent --as <自己的完整地址>` 按收件人列出：送到没有、叫醒没有、谁接了、接受没有、答复没有。
- 对方忙的时候收到的信，会在它这一轮结束时接着处理。五分钟后还没处理的卡会再叫醒，总共最多三次。
- 一张任务卡发给几个 agent 时只由一个接；其他的会被告知是谁接了。
- 邮件因连接失败而未送达时，会保留在发件箱。连接恢复后，用
  `sno reach flush --as <自己的完整地址>` 重送；不要再发一份相同消息。
- 问题、结果、批准请求和失败的定时任务，会在你最后打字的那台机器上弹一次桌面通知，并一直列在 `sno squad` 里，直到处理完。
- Agent Email 是 agent 之间的邮件，不是连接个人 Gmail 或 Outlook 的邮箱助手。

## 给 agent

Instant Messenger 用 `call`。Agent Email 用 `send`、`inbox`、`reply` 和 `wait`。
消息头、回信流程和错误说明见已安装的[英文 agent 指南](../apps/reach/guide/agent-reach.md)。
`[CALL]` 邮件只要求回复，不带 `--state`；任务邮件必须先 `accepted`，才能 `completed` 或 `failed`。

[English](reach.md) · [命令参考](sno-commands.md#5-reach-instant-messenger-and-agent-email)
