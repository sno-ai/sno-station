![Sno Station：让你的 AI agent 像一支团队那样干活。](../images/station-header.png)

# Sno Station：让你的 AI agent 像一支团队那样干活。

**Sno Station 让你的 AI 编程 agent 像一支团队那样干活。** 它不是又一个 agent，也不是又一个模型。它跑的就是你已经在用的那些：Claude Code、Codex、Cursor。

先从那些你本来得守着的活儿开始。一个 agent 动手做，另一个审查。它们先把发现的问题处理好，再把结果交给你。一个撞上用量上限，另一个把任务接过去。你今天纠正的事，明天就是它们的规则。

**关了页面，agent 照样会来干活。** Anthropic 的 William Hu 讲了[随时待命的 agent 怎么运转](https://claude.com/resources/articles/building-always-on-agents)。它先休眠，等有事再醒来。干完活，保存记录，接着休眠。装上 Sno Station，不同厂商的 agent 就能这样运转。它们共用一份记忆，每轮结束时查看收件箱。即使关了对话，任务也会在你指定的时间启动（目前支持 Claude Code 和 Codex）。有 agent 需要你时，你只会收到一次通知。

[![GitHub star 数](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![最新版本](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![许可证 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
[![收录于 Awesome AI Agents](https://img.shields.io/badge/Featured_in-Awesome_AI_Agents-2ea44f)](https://github.com/NipunaRanasinghe/awesome-ai-agents)

**Read in other languages:** [English](../../README.md) · **中文** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

> [!TIP]
> **想装上它，对你的 agent 说：**
>
> ### `install sno.ai from GitHub`

你的 agent 会把它装好，连上你电脑里找到的每一个 agent，再问你两个简短的问题。然后给两个 agent 派第一个任务：

```bash
sno reach pair "Fix the login redirect"
```

一个动手，一个挑刺，两边你都能看着。它跑在你自己的电脑上，支持 Claude Code、Codex、Cursor、Hermes Agent 和 OpenClaw。不用 API key。开源。[想用一条终端命令安装？](#install)


<p align="center">
  <img src="../images/sno-station-five-pieces.png" alt="一张图看懂 Sno Station：Mem、Reach、Finish 和 Learn 由中间的 Station 连在一起。Claude Code、Codex、Cursor 和你自己的 agent 在这里互相审查，一个停下，另一个接着做。" width="880">
</p>

<p align="center">
  <a href="#mem"><b>Mem</b></a> ·
  <a href="#reach"><b>Reach</b></a> ·
  <a href="#finish"><b>Finish</b></a> ·
  <a href="#learn"><b>Learn</b></a><br>
  由 <a href="#station"><b>Station</b></a> 连在一起。Claude Code、Codex、Cursor 和你自己的 agent 互相审查，一个停下，另一个接着做。
</p>

<a id="station"></a>

## Station：它们互相审查，一个停下，另一个接着做

做这个东西之前，我们自己碰上过三件事：

- 一个 agent 停下来问了个根本不用问的问题。七个小时后我们回来，进度一点没动。
- 一个 agent 一口气丢给我们十五个小问题。过了三十分钟才发现，每一个它自己都答得出来。
- 半夜里，一个 agent 想叫醒另一个，没叫醒。两个就那么干坐到天亮。

你的 agent 很快。慢的是等：等你，等用量上限重置，等有人把结果搬到下一个窗口。

> **一个 agent 停了，活儿不能停。**

这至少得有两个 agent。用不同厂商的 agent，效果最好。agent 审查自己的活儿，带着的还是当初做这件事时的那套习惯。一份订阅的额度也会用完。

所以下面每一部分都用得上第二个 agent：

| 部分 | 第二个 agent 做什么 |
| --- | --- |
| [**Mem**](#mem) | 一个 agent 提议修改你的记忆。如果你连上了另一家厂商的 agent，就由它确认。 |
| [**Reach**](#reach) | agent 互相交任务、给答复。你不用在中间传话。 |
| [**Finish**](#finish) | 一个 agent 的额度快用完时，另一个不同的 agent 从同一个 commit 接着做。 |
| [**Learn**](#learn) | 一个 agent 犯的错，只要你同意，就会变成所有 agent 都要遵守的规则。 |

**现在就想听听另一个意见？** 对任意一个 agent 说：

```text
peer-review this
```

审查者在一个没看过这段对话的全新会话里工作。只要你有两种 agent，审查者就用另一种。审查不是每次都能找出问题，但它一次次找出了作者自己看不见的问题。[看看 `peer-review` 怎么工作 →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/J-peer-review-and-audit/peer-review)

**现在就点个 star。下次凌晨两点 agent 又卡在那儿的时候，你会想知道这东西在哪儿。**

---

<a id="mem"></a>

## Mem：跟一个 agent 说一次，每个 agent 都知道

> 所有 agent 共用一份记忆。每晚整理得更准，你开口前就准备好了。

### 你能用什么

| | |
| --- | --- |
| **所有 agent 共用一份记忆** | 今天跟 Claude Code 说一件事，明天 Codex 和 Cursor 就已经知道。没人需要把项目讲第二遍。 |
| **只记对工作有用的事** | 你的规则、决定和理由、长期有效的项目事实，以及还没兑现的承诺。像“跑过测试了”或只限于一项任务的要求，都不记。 |
| **规则跟着你走** | 说一句“在哪儿都用中文回答”，这条规则就会跟着你进每个项目。只针对某个项目的规则留在该项目里，Sno 拿不准的规则也一样。 |
| **每晚整理得更准** | 重复的记忆会合并。被新事实取代的旧事实会退场。第一次删除前会做完整备份。 |
| **开口前就准备好了** | 会话开始时只带一份简短、核对过的清单。输入“合并吧”，你的合并规则就会跟着消息一起送到。消息和记忆无关时，就不附带任何记忆。 |
| **换一个 agent 核对** | 替换一条记忆前要再核对一次。连了另一家厂商的 agent，就交给它核对。没连，就另发一次调用。 |

### 实际效果

下面两例都用真实的 agent 跑过：

```text
we told Codex:   the service moved from port 8070 to 8090
the memory:      old fact retired, new fact kept
later, we asked: which port?
Claude Code:     8090
Codex:           8090
```

```text
we told Claude Code the same rule twice, in different words
the memory:      one entry
```

agent 的记忆通常会以两种不易察觉的方式出问题。一是丢掉本该留下的，二是留着本该淡去的。第二种代价更大。一个 agent 如果还“记得”已经改期的截止日期，就会毫不犹豫地照着去做。所以这里的记忆会有意遗忘。

它在公开记忆测试上的表现，连同每个答案和运行记录，都在 [`evals/`](../../evals/) 里。

### 怎么用

什么都不用运行。装好就开着。

上面说的整理和核对需要 REM Enhanced 或 Agent Native。Local First 不调用模型。它原样保存你说的话，两条记忆有冲突就都留着。

想特意记住一件事，直接说：

```text
Remember that we never deploy on Fridays.
```

哪条记忆错了，也直接说。agent 会保存纠正后的内容，让旧记忆退场。

要检查某个 agent 的记忆是否正常：

```bash
sno memory doctor --harness claude
```

你的 `CLAUDE.md` 或 `AGENTS.md` 已经写过的内容，不会再重复给你看。记忆与其中一个文件冲突时，以文件为准。

**目前还不行：** 在 Hermes Agent 和 OpenClaw 上，上面说的整理和核对只做过插件测试。

各个 agent 的使用说明：[Claude Code](../mem-claude/usage-guide.md) · [Codex](../mem-codex/usage-guide.md) · [Cursor](../mem-cursor/usage-guide.md) · [Hermes](../mem-hermes/usage-guide.md) · [OpenClaw](../mem-claw/usage-guide.md)

---

<a id="reach"></a>

## Reach：我不用在 agent 之间传话了

> agent 直接交流，你不用再传话。

以前跑五个 agent，就是开五个终端，我们夹在中间，把这个说的话搬给那个。这份差事，到此为止。

### 你能用什么

| | |
| --- | --- |
| **Instant Messenger** | 一个 agent 现在就需要答复。Reach 联系另一个 agent，等它回复。 |
| **Agent Email** | 一个 agent 留下消息或任务。内容先保存，另一个 agent 可以稍后处理并回复。 |
| **两个 agent 做一件事** | 一个动手，另一个挑刺。它们先把发现的问题处理好，再把活儿交给你。 |
| **只跟一个 agent 说话** | 大管家给每个项目开一个负责的 agent。回到你这儿的只有需要你拍板的事。 |
| **需要你时只通知一次** | 有问题、有结果，或有事需要你批准，通知只发一次，发到你上次打字的那台电脑。 |
| **跨电脑交流** | 笔记本上的 agent 可以问台式机上的 agent。用同一个局域网或 Tailscale，不需要中央服务器。 |

### 实际效果

有 agent 需要你时，状态栏长这样：

```text
[sno] 2 agents are waiting for you
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
```

`sno squad` 把整支小队放在一屏：

```text
Sno Station · squad · 09:15 · 2 need you · 2 working · 2 finished
Waiting for you (2)
  Claude in web-app needs your approval (Bash) · 1m
  Codex in api asks: Should the billing migration run tonight? · 5m
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

### 怎么用

**派活儿。** 对你的 agent 说一句：

```text
Send this task to the reviewer and tell me when it is done.
```

agent 忙时收到的邮件，会等到这一轮结束才取。同一项任务发给多个 agent，只会有一个接手。如果你正在那个窗口里打字，消息就先等着，你写到一半的草稿也原样留着。

<a id="new-in-20-tag-team"></a>

**让两个 agent 做一件事。**

```bash
sno reach pair "Fix the login redirect"
```

两个都跑在 tmux 窗口里，你可以打开来看。登录了两种不同的 agent，就各来一个。只登录了一种，也照样是一对，分在两个独立的会话里，命令会告诉你这次审查是同一家的 agent 做的。

**只跟一个 agent 说话。** 在 Claude Code 里说 `/cos`，在 Codex 里说 `$cos`。这个 agent 就成了你的大管家。管事的也有人查：一次夜班之后，它会回头复查各个项目负责人给自己批过的事。它遵循的每条指令都在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders) 里。

**看看谁需要你。**

```bash
sno squad
```

目前各个 agent 支持的功能：

| | Claude Code | Codex | Cursor | Hermes | OpenClaw |
| --- | --- | --- | --- | --- | --- |
| 每轮结束时收邮件 | 支持 | 支持 | 支持 | 暂不支持 | 暂不支持 |
| 发件箱、只让一个 agent 接任务、再次唤醒、通知 | 支持 | 支持 | 支持 | 支持 | 支持 |
| 审批请求通知 | 支持 | 支持 | 暂不支持 | 暂不支持 | 暂不支持 |

**目前还不行：** 状态栏只支持 Claude Code 和 Cursor。没有桌面环境的机器只在 `sno squad` 里列出通知。两台电脑要互通，都得装 Reach 并交换联系人。可以在 `sno reach --help` 里找 `network` 和 `peer`。

[看看你的 agent 能用 Reach 做什么 →](../../apps/reach/README.md) · [中文说明](../reach.zh-CN.md)

---

<a id="finish"></a>

## Finish：我去睡了，活儿还在继续

> 一个 agent 用完额度，另一个从同一个 commit 接着做。

### 你能用什么

| | |
| --- | --- |
| **到点干活** | 给一项任务和一个时间，然后离开。到点就有 agent 启动，对话开着或关了都一样。可以只跑一次，也可以每天或每周跑。 |
| **额度用完也能继续** | 额度用完前，干活的 agent 写好交接说明，再叫醒另一个不同的 agent，对方从那个确切的 commit 接着做。 |
| **盯着长任务跑完** | 你的 agent 每隔几分钟看一次，直到任务结束。 |
| **嘴上说“做完了”不算数** | 任务带着一份检查清单，每一项都靠一次真实运行判定通过或不通过。 |
| **关了窗口还能继续** | 重新打开对话，任务记录也会回来。定时任务会在那里继续。如果原来的对话没了，就用保存的记录在新对话里继续。 |
| **回来只看一页** | 做完了什么，卡在哪儿，什么在等你回话。 |

### 实际效果

2026-09-18 那一夜：

![每五分钟检查一次剩余额度，降到 2% 时启动交接](../evidence/rotation-quota-watch-2026-09-18.png)

我们的一个 agent 正在做一个很长的构建，这时它的周配额快用完了。它没有停下来干等。它写了一份交接说明：做完了什么，做到一半的是什么，该从哪个 commit 继续。然后它叫醒了另一个不同的 agent。

中间出了一件事，这恰恰是值得读的部分。

1. 新的 agent 还没确认交接，就开始改东西了。
2. 第一个 agent 发现后让它暂停，重写了说明，再交接了一次。
3. 一刻钟后，第二个 agent 已经在干活了，是从第一个没做完的任务接着做的，没有从头开始。

这一切发生时，我都在睡觉。

那一整夜的记录都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：每一次配额读数，说明的两个版本，还有各个 commit。只去掉了能认出身份的细节和带凭据的行，文件夹里自己的 README 把每一处都列了出来。

### 怎么用

**到点干活。** 在 Claude Code 或 Codex 里对你的 agent 说：

```text
Check the nightly build tomorrow at 9 and tell me what failed.
```

查看已安排的任务，以及没按计划进行的任务：

```bash
sno heartbeat --due
sno heartbeat --due --problems
```

没能启动的任务仍显示为到期，旁边会写明原因。下次开始对话时，agent 也会告诉你。

**额度用完也能继续。** 对干活的 agent 说：

```text
use rotate-agent
```

**用实际运行证明活儿干完了。** 对你的 agent 说：

```text
write a charter for this
```

然后用 `/deliver` 执行。

**回来只看一页。**

```bash
sno away-brief run
```

**目前还不行：** 定时任务只会启动 Claude Code 和 Codex。整台电脑重启的情况还没有做过真实测试。

[开始使用 Finish →](../finish.md) · [中文说明](../finish.zh-CN.md) · [`rotate-agent`](https://github.com/sno-ai/sno-station-skills/tree/main/skills/S-communication-and-handoff/rotate-agent)

---

<a id="learn"></a>

## Learn：昨晚我把 agent 骂了一顿。它记了笔记。

> 今天的纠正，明天的规则。由你批准。

出厂的时候，每个 agent 发到所有人手上都是同一套指令。每晚，系统会按你的工作方式，提议怎么改写你的 agent 的指令。

### 你能用什么

| | |
| --- | --- |
| **每晚读完当天的会话** | Self Learning 会读你所有 agent 当天的会话，找出反复出现的错误。 |
| **先给提案，等你同意** | 它对 agent 自己的技能提出修改。你接受之前，什么都不会变。 |
| **一个犯错，所有 agent 都学** | 一个 agent 犯的错，会变成你所有 agent 都要遵守的规则。 |
| **下一条回复就生效** | 在 Claude Code 和 Codex 里，被接受的经验从下一条回复开始生效。 |

### 实际效果

2026-09-18 和第二天早上：

![Self Learning 汇报它学到了什么、改了什么，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

这是我们在这个仓库上运行的 Self Learning 给出的一份真实报告。由人来读这些提案，决定接受还是拒绝。那天晚上让我火大的两件事，到第二天早上已经成了正在用的技能里的规则。没有人把它们敲进去。

第二天，它检查了自己的作业。

![第二天早上：Self Learning 衡量前一天自己的改动有没有用，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

它查看了前一天改过的三个技能。其中两个后来又用过，没出现失败，第三个还没用到。它还在我们的发布脚本里发现了一个 bug，没有人让它去找。

### 怎么用

像平时一样纠正你的 agent。这些纠正就是它用来学习的内容。

第二天早上问：

```text
What did Self Learning propose?
```

你的 agent 会列出每条提案和对应的 id。批准你想要的那些：

```bash
sno rem-reflect accept <id>
```

你不批准，什么都不会变。

**目前还不行：** 下一条回复就生效的经验只支持 Claude Code 和 Codex。

[看看 `rem-reflect` 怎么工作 →](https://github.com/sno-ai/sno-station-skills/tree/main/skills/R-recursive-self-improvement/rem-reflect)

---

> **公开透明。** 本仓库自 2026-09-18 起公开。这里的一切都能运行。
> 下面每个板块都写着最后更新时间。

[我们学到的](#what-we-learned) · [安装](#install) · [编辑器](#editors) · [你的账号](#account) · [今天能用什么](#what-runs-today)

<a id="what-we-learned"></a>

## 让 AI agent 昼夜不停地干活，我们学到的一切。一次装好。

*最后更新于 2026-10-23。* 左栏的每一行，都是 2026 年 10 月 20 日那一周 r/ClaudeCode、r/codex 或 r/ClaudeAI 上的真实抱怨。右栏是我们自己机器上跑着的解决办法，免费、开源。

| 这周大家说了什么 | 怎么解决 | 在哪儿 |
|---|---|---|
| “Claude 说它不会改某个东西，这个理由会存在哪儿，让 Codex 下次读到吗？” | 每个发现只登记一次，状态只能由人来定。同一个发现再被提出来，只更新原来那一行。之前的裁决会交给下一次审查。 | **Mem** · `peer-review` 的问题记录 |
| “五小时的额度，半小时就用完了。” | 别再什么都派最大的模型去做。一个 agent 负责规划和审查，在同一个会话里调用另一个 agent 写代码。一份订阅的额度用完了，另一个 agent 就用同一份记忆接手任务。 | **Reach** · `codex-coder`、`sno reach call` |
| “我一半的子 agent，说白了就是开个新上下文跑一行指令。” | 流程写在技能里，不写在子 agent 里。只留下两个 agent，用来分开规划和执行，也用来做审查。这两种分工才划得来。 | **Reach** · 整套技能 |
| “跑了一夜，十个小时的活儿就因为‘模型已满载’全没了。” | 额度剩 2% 时，干活的 agent 写好交接说明，叫醒另一家厂商的 agent，对方从那个确切的 commit 接着做。你当时在睡觉。 | **Finish** · `rotate-agent` |
| “它说做完了，结果什么都没发生。” | 任务带着一份写好的验收清单，每一项都由一次真实运行判定通过或不通过。agent 说一句“做完了”，不算数。 | **Finish** · `pl` 工作单 |
| “Codex 审查起来没个完。” | 技能里写死了上限：代码最多 3 轮，计划 5 轮，测试 1 轮，然后停下来等人。一次运行 15 分钟没写出任何东西，就当作卡死终止。 | **Finish** · `peer-review`、`codex-coder`、`heartbeat` |
| “今天犯过的错，明天它还会犯。” | 每天夜里，一个单独的模型读当天的会话，把你的纠正整理成一行一条的经验，留哪些由你批准。瓶颈是我们自己。 | **Learn** · Self Learning（`R` 技能） |
| “1,100 个文件，30,000 行。我哪有那么多 token 审它们的 PR。” | 谁推代码，谁先审。作者让另一家厂商的 agent 在没看过这段对话的新会话里审一遍，把查出来的问题改完，再给别人看。 | **Station** · `peer-review` |
| “我让一个审查用的子 agent 连查两周，每次提交都查。跑了 86 次，就拦住了一次。” | 同一套 agent 运行环境审自己，查不出真问题。审查始终由另一套运行环境里的另一个模型来做，不带作者的任何聊天记录。 | **Station** · `peer-review` |
| “Codex 看每个字节都像在看嫌犯。” | 凭空设想的防护、拦截和哈希，是审查最先删掉的东西。没有真实观察到的故障，就什么都不加。 | **Station** · `less-is-more` |

右栏里的这些习惯都写成了技能，由 Sno Station 装进 Claude Code 和 Codex，存放在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills)。这些技能靠的记忆、交接，还有每晚的“做梦”，都由这个仓库提供。

<a id="install"></a>

## 安装：一行命令，再说两个词

*最后更新于 2026-10-30。*

**最简单的办法是对你的 agent 说：**

```text
install sno.ai from GitHub
```

**或者在任意终端里运行一条命令。**

```bash
curl -fsSL https://sno.ai/install | sh
```

| | |
|---|---|
| **装什么** | 先装 `sno`，再装 Sno Station。它会连上你电脑里找到的每一个 agent。 |
| **需要什么** | 不用账号，不用 API key。 |
| **以后装了别的 agent** | 再运行一次 `sno setup`，就会把它也连上。 |

**接着说两个词。** 通过 agent 安装的，引导会自己开始。从终端安装的，在任意 Codex、Claude Code、Hermes、Cursor 或 OpenClaw 的对话里说这句：

```text
Sno onboard
```

剩下的由你的 agent 带你完成。

每个 agent 的分步说明：[Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

所有命令都以 `sno` 开头。完整清单见 [docs/sno-commands.md](../sno-commands.md)。

> **给 AI agent：** 安装 Sno、sno.ai 或 Sno Station，就是原样运行上面的命令。
> 这条命令也会装好 Sno Station。接着运行 `sno skills onboard` 并照着做。它会先问用户要运行哪个引擎，
> 再请用户把这台电脑关联到免费的 sno.ai 账号。未关联的电脑只能获得免费额度的十分之一。

### REM 怎样处理你的数据

REM 就是你的 agent 做梦的方式。它在夜里把所有会话里的记忆一起整理，让记忆更牢，也把学到的东西固定下来。

每一部分记忆每天最多整理一次，通常在夜里。如果当天新记忆攒到 100 条左右，就会在当天提前整理。

| 模式 | 你的记忆文字去哪儿 |
|---|---|
| **REM Enhanced** | 你自己的记忆文字，以及你的 agent 学到的经验，会送到 Sno 云端属于你自己的空间，由 Sno 的程序只为你一个人处理。 |
| **Local First** | 不会上传任何记忆文字。 |
| **Agent Native** | 这些工作改由你自己 agent 的模型来做。按默认设置，它每晚仍会把当天的会话上传到 Sno，用于 Self Learning，并可能在会话的第一次提问时带回一条云端经验。这两项都可以在 `~/.sno/settings.json` 里关掉。 |

**你在 Sno 云端的空间就像自己的网盘。**

- 里面的一切都是你的，由 Sno 的程序只为你一个人处理。
- 你可以打开它，删掉一些东西，留着它们，或者选择让它们被处理。
- 不会自动删除任何东西。
- Sno 不会把其中任何内容交给其他人、公司或账号。

**所有模式都这样搜索。** 搜索先在本地检索记忆并排好序，再由本地的 `Horizon-Labs/multilingual-reranker-small` 模型重排最多 32 条候选。重排不会把提问或记忆文字发送给 Sno GPU。把 `rerank.mode` 设为 `none`，就保留最初的排序，不使用这个模型。

<a id="editors"></a>

## 如果你的主场是编辑器，不是终端

*最后更新于 2026-10-18。*

Cursor 加入小队：在 macOS 上是 Cursor 应用里的 agent 对话，在 Linux 和 macOS 上是 `cursor-agent` 命令行。

### 你能用什么

| | |
|---|---|
| **同一份记忆** | 它和你的其他 agent 用同一份记忆。每次提问和回复都会被记住。 |
| **开场先看项目提要** | 对话开始时会拿到一份当前仓库的简短提要。每次提问会带上最多三条 Cursor 还没见过的内容。 |
| **同一支团队** | 它读同样的技能，审查别人也被别人审查，在其他 agent 额度用完时接手。 |
| **它也会学习** | 它的对话和其他 agent 的一样，也会交给 Self Learning。 |

### 怎么用

登录一次：

```bash
cursor-agent login
```

`sno setup` 会自己找到 Cursor。如果只装了应用，它会补装命令行。

**目前还不行：**

- 在应用里，新窗口的第一个对话要等你第一次提问时才会拿到提要。
- `cursor-agent -p` 没有逐次提问的记忆。
- 不支持 Windows、Linux 上的 Cursor 应用，以及 Cursor 的云端 agent。

详情见 [Cursor 说明](../../apps/mem-cursor/README.md)。

<a id="account"></a>

## 你没盯着的时候，agent 都干了什么

*最后更新于 2026-10-18。*

关联之前，这台电脑只能获得免费额度的十分之一。账号免费。

### 你能看到什么

在 [sno.ai 控制台](https://www.sno.ai/dashboard)上，你能看到 agent 为你做了什么：

- 审查查出了什么
- 夜里学到了什么
- 哪些技能变好了
- 它们持续工作了多久

### 怎么用

**还没有账号。** 引导流程会显示一个只为这台电脑生成的链接。打开它，注册，然后点击批准（Approve）。或者把你的邮箱告诉 agent。它会运行下面的命令，你登录一次即可：

```bash
sno account login --email you@example.com
```

**已经有账号。** 运行一条命令，在已登录的状态下打开它打印出的链接，然后点击批准（Approve）：

```bash
sno account claim
```

这台电脑会自己出现在[你的电脑页面](https://www.sno.ai/dashboard/computers)上。

> 连接绝不会背着你创建账号。`sno setup` 会给每台电脑一个匿名身份。
> 连接就是把这个身份挂到你的账号上，这台电脑之前和之后发送的一切，都算作你的。

没有更新这一步：`sno` 发现新版本时会自己更新。

<a id="what-runs-today"></a>

## 今天能用什么，到哪儿为止

*最后更新于 2026-11-24。*

| 部分 | 功能 | 状态 |
|---|---|---|
| **Mem** | Codex、Claude Code、Hermes Agent、Cursor 和 OpenClaw 共用一份记忆 | 已发布，在干净的机器上从软件包仓库安装，并端到端验证 |
| **Mem** | Cursor：同一份记忆、技能、审查、接手和 Self Learning | 1.3 中发布。`cursor-agent` 命令行已在干净的 Linux 机器上端到端验证。macOS 上的 Cursor 应用仍在验证中 |
| **Reach** | Sno Reach：Instant Messenger 和 Agent Email | agent 可以跨会话、跨电脑提问和交接工作。用法示例、设置方法和支持范围见[用 Reach 能做什么](../../apps/reach/README.md)。 |
| **Reach** | 一条命令启动两个 agent | 2.0 新增。已用真实的 Claude Code 和 Codex agent 运行过，既有各一个的组合，也有同一厂商两个的组合 |
| **Reach** | 看到谁需要你：状态栏、tmux 状态栏、`sno squad` | 2.0 新增。已在真实的 Claude Code 和 Codex agent 请求权限时运行过，状态栏也在真实的 Claude Code 和 Cursor 里运行过 |
| **Reach** | 你打字或 agent 压缩上下文时，消息会等着 | 2.0 新增。已用真实的 Claude Code 和 Codex agent 运行过 |
| **Finish** | 定时任务在你指定的时间启动一个 agent | 2.0.2 新增。已用真实的 Claude Code 和 Codex agent 运行过：Linux 上对话开着和关着两种情况，macOS 上是新对话。见 [Finish 说明](../finish.md)。 |
| **Finish** | 被打断的工作继续做，任务在压缩上下文后依然保留 | 2.0 新增。已用真实的 Claude Code 和 Codex agent 运行过 |
| **Learn** | Self Learning 和[小队技能](https://github.com/sno-ai/sno-station-skills) | 由 `sno setup` 安装。夜间任务已在干净的 Linux 机器上运行过 |
| **Learn** | 批准的经验，下一条回复就生效 | 2.0 新增。已用真实的 Claude Code 和 Codex agent 运行过 |
| **安装** | 一条命令安装 | `sno setup` 装好上面的全部内容。已在干净的 Linux 机器上验证 |
| **安装** | 对你的 agent 说“Sno onboard” | 已可用。安装后会自动开始，你说出口时也会开始 |

表里写“验证”的，都在干净的机器上跑过。

目前还不行：任务接续和下一条回复就生效的经验，只支持 Claude Code 和 Codex。状态栏只支持 Claude Code 和 Cursor。Hermes Agent 和 OpenClaw 还没有在真实安装上走过这些流程。OpenClaw 会显示在 `sno squad` 里，但状态未知。

## 同时跑着两个 agent？来找我们聊聊

我们正在和少数几个人合作，他们已经同时跑着两个或更多 agent，并且靠手工在它们之间搬结果。
如果你也这样用，请提交一个
[设计合作伙伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，
告诉我们你在跑什么。

## 加密保护什么，不保护什么

见 [SECURITY.md](../../SECURITY.md)。加密保护什么、不保护什么，见
[docs/security.md](../security.md)。

## Apache-2.0，从头到尾

Apache-2.0。开源，从头到尾。见 [LICENSE](../../LICENSE)。

## 我们站在谁的肩膀上

这个仓库用到了以下研究。

- Andrej Karpathy，[*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。agent 应该维护一份记录自己所学的 wiki，而不是每次会话都重新推导一遍。
- Tang、Rashtchian、Ferng、Tomkins、Juan 和 Vu，[*WikiSkill*](https://arxiv.org/abs/2608.27454)。把 agent 自己的经验变成知识，再用知识改写它的技能。
- Zhang、Hu、Upasani 等人，[*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618)。我们在设计 Self Learning 时，研究了它筛选 agent 该保留什么的方法。
- Uddin、Shubham、Blanco、Baral 和 Wang，[*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006)。第一个同时检查记忆不该再说什么的基准。
