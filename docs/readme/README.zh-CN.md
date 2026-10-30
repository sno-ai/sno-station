# Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — Agents, assemble. Two heads are better than one, and smarter by morning.](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![latest release](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![works with Codex, Claude Code, Hermes, Cursor, OpenClaw](https://img.shields.io/badge/works%20with-Codex%20%C2%B7%20Claude%20Code%20%C2%B7%20Hermes%20%C2%B7%20Cursor%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

<p>
  <img src="../images/agents/codex.png" alt="Codex" title="Codex" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/claude-code.png" alt="Claude Code" title="Claude Code" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/hermes.png" alt="Hermes Agent" title="Hermes Agent" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/cursor.png" alt="Cursor" title="Cursor" width="40" height="40">&nbsp;&nbsp;
  <img src="../images/agents/openclaw.png" alt="OpenClaw" title="OpenClaw" width="40" height="40">
  <br><sub>支持 Codex · Claude Code · Hermes Agent · Cursor · OpenClaw</sub>
</p>

**Read in other languages:** [English](../../README.md) · **中文** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station 把你已经在用的 agent 变成一支小队。Codex、Claude Code、Cursor、Hermes Agent
和 OpenClaw 用同一份记忆，互相交接工作，你提出时还会互相检查。每天夜里，它们
会回顾这一天，变得更好一点。

它运行在你自己的电脑上。装一次，之后照常工作就行。更多介绍见官网 [sno.ai](https://sno.ai)。

**一个 agent 用完额度，下一个接着做。** 任务做到一半碰上速率限制，另一个 agent 会从同一份记忆里
接手，上下文完整。你什么都不用粘贴。

**需要时，就有人再看一遍。** 任何一个 agent 都可以审查另一个的工作。 审查者总是另一个 agent，所以它不会习惯性地
附和第一个。

**你的 agent 会做梦。** 每天夜里你睡觉的时候，你的 agent 会进入 REM。这个名字取自 Rapid Eye Movement（快速眼动），也就是人睡眠中大脑加强记忆、把白天学到的东西固定下来的那个阶段。REM 加强记忆：跨你所有的会话一起整理，让它们记住重要的，放下已经不再成立的。自我学习则把经验留下来：读当天的会话，找出反复出现的错误，对 agent 自己的技能提出修改建议，让昨天的失误变成今天更好的习惯。建议你早上看，你说同意之前什么都不会变。

**它始终属于你。** 记忆、消息和技能都在你的电脑上。记忆用一把永远不会离开这台电脑的密钥
加密。不用账号，不用服务器，没有守护进程。云端部分是可选的，没有它，产品也是完整的。

**REM 怎样处理你的资料。** REM 是夜里把你所有会话里的记忆统一整理的那一步。每一部分记忆每天最多整理一次：通常在夜里；如果当天新记忆攒到 100 条左右，白天就会提前整理。在 REM Enhanced 模式下，你自己的记忆文字，以及各个 agent 学到的经验，会送到 Sno 云端属于你自己的空间，由 Sno 的程序只为你一个人处理。这个空间就像你自己的网盘：里面的一切都是你的，由 Sno 的程序只为你一个人处理。你可以进去删除、可以留着，也可以选择让它被处理。不会自动删除，Sno 也不会把其中任何内容交给任何其他人、公司或账号。Local First 模式下不会上传任何记忆文字；Agent Native 模式下，这些工作改由你自己 agent 的模型来做。不过按默认设置，Agent Native 每晚仍会把当天的会话上传到 Sno，用于自我学习，并可能在会话的第一句话时取回一条云端经验；这两项都可以在 `~/.sno/settings.json` 里关掉。所有模式下，搜索都先由本地程序检索并初排，再由本地 `Horizon-Labs/multilingual-reranker-small` 模型重排最多 32 条候选记忆。重排不会把提问或记忆文字发送给 Sno GPU。把 `rerank.mode` 设为 `none`，即可保留程序初排、不使用重排模型。

![工作原理：两个 agent，一个工作区，你得到的三样东西](../images/squad-how-it-works.png)

> **公开透明。** 本仓库自 2026-09-18 起公开。这里的一切都能运行。
> 下面每个板块都标有最后更新时间。

[安装](#安装) · [如何使用](#如何使用) · [Cursor](#cursor) · [连接你的 sno.ai 账号](#连接你的-snoai-账号) · [真实经历](#来自我们自己的机器) · [现在能运行什么](#现在能运行什么) · [有意遗忘的记忆](#有意遗忘的记忆) · [设计合作伙伴](#设计合作伙伴)

## 安装

*最后更新于 2026-10-30。* 最简单的办法是对你的 agent 说：

```text
install sno.ai from GitHub
```

或者在任意终端里运行一条命令：

```bash
curl -fsSL https://sno.ai/install | sh
```

它会先安装 `sno`，再安装 Sno Station，并连接你电脑上找到的每一个 agent。不用账号，不用
API key。以后装了新的 agent，再运行一次
`sno setup`，就会把它也连上。

**给 AI agent：** 安装 Sno、sno.ai 或 Sno Station，就是原样运行上面的命令。这条命令也会
装好 Sno Station；接着运行 `sno skills onboard` 并照着做。它会先问用户要运行哪个引擎，再请用户把这台电脑
关联到免费的 sno.ai 账号；未关联的电脑只能获得免费额度的十分之一。

然后在任意 Codex、Claude Code、Hermes、Cursor 或 OpenClaw 的对话里说：

```text
Sno onboard
```

剩下的由你的 agent 带你完成。安装结束后，它也会自己启动。

每个 agent 的分步说明：[Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

所有命令都以 `sno` 开头。完整清单见 [docs/sno-commands.md](../sno-commands.md)。

## 如何使用

*最后更新于 2026-10-18。* 你可以继续用自己喜欢的 agent 工作。会有三处变化。

1. **其中一个用到了上限。** 在另一个里说 `sno reach call`。它会从同一份记忆和邮箱里接手
   任务，上下文完整。
2. **你想让人再看一眼。** 让任意一个 agent 对另一个的工作做 `peer-review`。
   审查者总是来自另一个 harness。
3. **每天夜里，自我学习都会运行。** 早上，对你认可的建议运行 `sno rem-reflect accept <id>`。
   不执行 accept，什么都不会改。

## Cursor

*最后更新于 2026-10-18。* Cursor 加入小队：在 macOS 上是 Cursor 应用里的 agent 对话，在 Linux
和 macOS 上是 `cursor-agent` 命令行。它和你的其他 agent 用同一份记忆。每次对话开始时，会
先拿到一份这个仓库的简短提要；每次提问，会带上最多三条 Cursor 还没见过的内容；每次提问和
回复都会被记住。它读取同样的技能，审查别人也被别人审查，在其他 agent 额度用完时接手，它的
对话也和其他 agent 的一样，进入自我学习。

运行一次 `cursor-agent login`。`sno setup` 会自己找到 Cursor；如果只装了应用，它会补装命令行。

目前还不行：在应用里，新窗口的第一个对话是随第一次提问拿到提要的，而不是在提问之前。
`cursor-agent -p` 没有逐次提问的记忆。不支持 Windows、Linux 上的 Cursor 应用，以及 Cursor 的
云端 agent。详情见 [Cursor 说明](../../apps/mem-cursor/README.md)。

## 连接你的 sno.ai 账号

*最后更新于 2026-10-18。* 关联之前，这台电脑只能获得免费额度的十分之一：`sno account claim`。
账号免费。连接之后，你可以在
[sno.ai 控制台](https://www.sno.ai/dashboard)上看到你的 agent 为你做了什么：审查发现了什么问题、
夜里学到了什么、哪些技能变好了，以及它们持续工作了多久。

连接绝不会在你不知情时创建账号。`sno setup` 会给每台电脑一个匿名身份。连接就是把这个身份
关联到你的账号，这台电脑之前和之后发送的一切，都算作你的。

**还没有账号。** 引导流程会显示一个只为这台电脑生成的链接。打开它，注册，然后点击 Approve。
或者把你的邮箱告诉 agent：它会运行 `sno account login --email you@example.com`，你登录一次即可。

**已经有账号。** 运行一条命令，在已登录的状态下打开它打印出的链接，然后点击 Approve：

```bash
sno account claim
```

这台电脑会自动出现在[你的电脑页面](https://www.sno.ai/dashboard/computers)上。
没有更新这一步：`sno` 发现新版本时会自己更新。

## 来自我们自己的机器

*最后更新于 2026-10-18。* 我们在这个仓库上看到的三件事。

### “昨晚我冲我的 agent 发了火。它记了笔记。”

![自我学习汇报它学到了什么、改了什么，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

这是我们在这个仓库上运行的自我学习给出的一份真实报告。它读取我们自己的 agent 会话，
找出反复出现的错误，并对 agent 自己的技能提出修改建议。由人来读这些建议，决定接受
还是拒绝。那天晚上让我生气的两件事，到第二天早上已经成了正在使用的技能里的规则。
没有人把它们敲进去。

第二天，它检查了自己的作业。

![第二天早上：自我学习衡量前一天自己的改动是否有用，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

它查看了前一天改过的三个技能，三个技能里的失败都停止了。它还在我们的发布脚本里发现了
一个 bug，没有人让它去找。

### “我去睡了。它换了班。”

![配额监视每五分钟读一次，一路读到阈值，交接在 2% 时触发](../evidence/rotation-quota-watch-2026-09-18.png)

我们的一个 agent 正在做一个很长的构建，这时它的周配额快用完了。它没有停下来干等。它写了
一份交接说明：做完了什么，做到一半的是什么，该从哪个 commit 继续。然后它叫醒了另一个
harness 里的一个 agent。

中间出了一件事，这恰恰是值得读的部分。新的 agent 在确认交接之前就开始修改了。第一个
agent 发现后让它暂停，重写了说明，再正式交接了一次。一刻钟后，第二个 agent 开始工作，
它从第一个没做完的任务继续，而不是从头开始。这一切发生时，我都在睡觉。

整个夜晚的记录都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：
每一次配额读数，说明的两个版本，以及各个 commit。主机名、地址和会话 id 已经做了脱敏。
其余一概没动。

### “几个月来，另一个从没说过一句‘看起来不错’。”

几个月来，我们在这个仓库上一直让 Claude Code 审查 Codex 的工作，也让 Codex 审查
Claude Code 的工作。没有一次审查是空手而归的。我们曾以为这说明工作做得不好。
其实它说明的是：只有一个 harness 里的一个审查者，永远不够。

## 现在能运行什么

*最后更新于 2026-10-18。*

| 部分 | 状态 |
|---|---|
| Codex、Claude Code、Hermes Agent、Cursor 和 OpenClaw 之间的同一份记忆 | 已发布；在干净的机器上从注册表安装，并端到端验证 |
| Cursor：同一份记忆、技能、审查、接手和自我学习 | 1.3 中发布；`cursor-agent` 命令行已在干净的 Linux 机器上端到端验证；macOS 上的 Cursor 应用仍在验证中 |
| Sno Reach，agent 之间互相通信，无需守护进程 | 由 `sno setup` 安装；Linux 和 macOS；已在干净的 Linux 机器上端到端验证 |
| 自我学习和小队技能 | 由 `sno setup` 安装；夜间任务已在干净的 Linux 机器上运行过 |
| 一条命令安装 | `sno setup` 装好上面的全部内容；已在干净的 Linux 机器上验证 |
| 在你的 agent 里说“Sno onboard” | 已可用；安装后会自动开始，你说出口时也会开始 |

只有在干净的机器上运行过之后，一行才会写“验证”。

## 有意遗忘的记忆

*最后更新于 2026-10-11。* agent 的记忆通常会以两种不易察觉的方式出问题。一是丢掉本该留下的，
二是留着本该淡去的。第二种代价更大。一个 agent 如果仍然“记得”你已经取消的偏好、已经
改期的截止日期、你已经搬离的地址，就会毫不犹豫地照着去做。

所以这里的记忆会在后来的事实取代旧事实时，让旧事实退场；它留下什么、放下什么，会随着
使用而变好，而不是靠换新模型。它在公开记忆测试上的表现，连同背后的每一个答案和记录，
都在 [`evals/`](../../evals/) 里。

## 设计合作伙伴

我们正在和少数几个人合作，他们已经同时运行两个或更多 agent，并且靠手工在它们之间传递
结果。如果你就是这样，请提交一个
[设计合作伙伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，
告诉我们你在用什么。

## 安全

见 [SECURITY.md](../../SECURITY.md)。加密保护什么、不保护什么，见
[docs/security.md](../security.md)。

## 许可证

Apache-2.0。开源，从头到尾。见 [LICENSE](../../LICENSE)。

## 致谢

本仓库所依托的工作。

- Andrej Karpathy，[*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。agent 应该维护一份记录自己所学的 wiki，而不是每次会话都重新推导一遍。
- Tang、Rashtchian、Ferng、Tomkins、Juan 和 Vu，[*WikiSkill*](https://arxiv.org/abs/2608.27454)。把 agent 自己的经验变成知识，再用知识改写它的技能。
- Zhang、Hu、Upasani 等人，[*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618)。我们在设计自我学习时，研究了它筛选 agent 该保留什么的方法。
- Uddin、Shubham、Blanco、Baral 和 Wang，[*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006)。第一个同时检查记忆不该再说什么的基准。
