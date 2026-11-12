# Sno Station：一个人，一整支 AI 工程团队。

**Sno Station 是你那些 AI 编程 agent 的工作站。** Claude Code、Codex 和 Cursor 各自跑在自己的 harness 里。Sno Station 让这些 harness 并排坐到一起，像一支团队那样干活。它不是又一个 agent，也不是又一个模型：它跑的就是你已经在用的那些。

先从那些你本来得守着的活儿开始。一个 agent 动手做，另一个审查，它们先把发现的问题掰扯清楚，结果才交到你手上。一个撞上用量上限，另一个把任务接过去。你今天纠正的事，明天就是它们技能里的一条规则。

想装上它，对你的 agent 说：

```text
install sno.ai from GitHub
```

你的 agent 会把它装好，连上你电脑里找到的每一个 agent，再问你两个简短的问题。然后给两个 agent 派第一个任务：

```bash
sno reach pair "Fix the login redirect"
```

一个动手，一个挑刺，两边你都能看着。它跑在你自己的电脑上，支持 Claude Code、Codex、Cursor、Hermes Agent 和 OpenClaw。不用 API key。开源。[想用一条终端命令安装？](#install)

[![GitHub star 数](https://img.shields.io/github/stars/sno-ai/sno-station?label=stars&color=eab308&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/stargazers)
[![最新版本](https://img.shields.io/github/v/release/sno-ai/sno-station?label=release&color=2dd4bf&labelColor=3b3b3b)](https://github.com/sno-ai/sno-station/releases/latest)
[![许可证 Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)

**Read in other languages:** [English](../../README.md) · **中文** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

## 今晚把活儿交出去。明早拿到的是结果，不是三个问题。

做这个东西之前，我们自己碰上过三件事：

- 一个 agent 停下来问了个根本不用问的问题。七个小时后我们回来，进度一点没动。
- 一个 agent 一口气甩给我们十五个小问题。我们搭进去三十分钟，才发现每一个它自己都答得出来。
- 半夜里，一个 agent 想叫醒另一个，没叫醒。两个就那么干坐到天亮。

你的 agent 很快。慢的是等：等你，等用量上限重置，等有人把结果搬到下一个窗口。所以整个工作站只围着一条规矩来做：**一个 agent 停了，活儿不能停。**

- **用量上限不是红灯。** 另一个 agent 从同一个 commit 接着做。
- **写的人说了不算。** 由另一个 agent 来审查，用的是一个没看过这段对话的会话。
- **嘴上说“做完了”不算数。** 每一项成功检查，都要靠一次真实运行来回答。
- **回来只看一页。** 做完了什么，卡在哪儿，什么在等你回话。

**活儿它干完，上线你来按。**

**现在就点个 star。下次凌晨两点 agent 又卡在那儿的时候，你会想知道这东西在哪儿。**

下面是三种用法：一条命令启动一个动手的和一个审查的；通过一个 agent 指挥整支小队；今晚批准一条经验，下一条回复就生效。每一种都配了我们在自己机器上亲眼看到的事。

<a id="new-in-20-tag-team"></a>

## 我去睡了。它们换了班，还为代码吵了一架。

```bash
sno reach pair "Fix the login redirect"
```

一个 agent 动手做。另一个专挑它的刺。发现的问题它们自己掰扯清楚，所以活儿到你手上时，已经吵过一轮了。两个都跑在 tmux 窗口里，你可以打开来看。登录了两种不同的 agent，就各来一个。只登录了一种，也照样是一对，分在两个独立的会话里，命令会告诉你这次审查是同一家的 agent 做的。

**一个用完，另一个上岗。** 要跑很久的任务，告诉干活的 agent 用 `rotate-agent`。额度剩 2% 时，它写好交接说明，叫醒另一个不同的 agent，对方从同一个 commit 接着做。agent 的上下文写满、被压缩之后，它也还记得自己在做什么，哪些路已经试过不通。

**一个看不到的，另一个看得到。** 让任意一个 agent 对另一个的工作做 `peer-review`。审查者总是在一个没看过这段对话的全新会话里工作；只要你有两种 agent，审查者就一定是不同的那一种。审查不是每次都能找出问题。但作者自己看不见的那些，它总能找出来，因为 agent 审查自己时，带着的还是写代码时的那套习惯。

我们看到的，2026-09-18 那一夜：

![配额监视每五分钟读一次，一路读到阈值，交接在 2% 时触发](../evidence/rotation-quota-watch-2026-09-18.png)

我们的一个 agent 正在做一个很长的构建，这时它的周配额快用完了。它没有停下来干等。它写了一份交接说明：做完了什么，做到一半的是什么，该从哪个 commit 继续。然后它叫醒了另一个不同的 agent。

中间出了一件事，这恰恰是值得读的部分。新的 agent 还没确认交接，就开始改东西了。第一个 agent 发现后让它暂停，重写了说明，再正正经经交接了一次。一刻钟后，第二个 agent 已经在干活了，而且是从第一个没做完的任务接着做，不是从头开始。这一切发生时，我都在睡觉。

那一整夜的记录都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：每一次配额读数，说明的两个版本，还有各个 commit。只去掉了能认出身份的细节和带凭据的行，文件夹里自己的 README 把每一处都列了出来。时间、出的错和纠正的过程，都是当时的原样。

## 我们只跟一个 agent 说话。其余的归它管。

以前跑五个 agent，就是开五个终端，我们夹在中间，把这个说的话搬给那个。这份差事，到此为止。

在 Claude Code 里说 `/cos`，在 Codex 里说 `$cos`。这个 agent 就成了你的大管家，你只用跟它一个打交道。它给每个项目开一个负责的 agent，负责人再把活儿往下派，回到你这儿的只有需要你拍板的事。管事的也有人查：一次夜班之后，它会回头复查各个项目负责人给自己批过的东西；反复出现的管理失误，会变成它们全都要守的规则。负责这套派活、审查和学习的技能由 Sno Station 安装，每一条指令你都能在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills/tree/main/skills/T-delegation-and-work-orders) 里读到。

**别再盯着终端了。** 不管有没有大管家，只要有谁需要你，Claude Code 或 Cursor 的状态栏都会告诉你。安装时就配好了：

```text
❄ 2 need you · claude: approve
```

`sno squad` 把整支小队铺满一屏：谁在等你，谁在干活，什么已经做完。

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

**别再当传话的了。** agent 之间直接互发任务和审查请求。完整内容先落进对方的收件箱。如果你正在那个窗口里打字，或者那个 agent 正在压缩上下文，消息就在那儿等着，你写了一半的草稿也原样留着。

## 昨晚我把 agent 骂了一顿。它记了笔记。

出厂的时候，每个 agent 发到所有人手上都是同一套指令。你的这几个，每晚会收到一份照着你的工作方式写的改写提案。留不留，你说了算。

你今天纠正了一个 agent。今晚 Self Learning 会读你所有 agent 当天的会话，找出反复出现的错误，对 agent 自己的技能提出修改。早上，问问你的 agent：Self Learning 提了什么。它会列出每条提案和对应的 id，你批准想要的那些：

```bash
sno rem-reflect accept <id>
```

不执行这个 accept，什么都不会变。在 Claude Code 和 Codex 里，被接受的经验从下一条回复开始生效。不是下一次会话。就是下一条回复。

我们看到的，2026-09-18 和第二天早上：

![Self Learning 汇报它学到了什么、改了什么，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

这是我们在这个仓库上运行的 Self Learning 给出的一份真实报告。由人来读这些提案，决定接受还是拒绝。那天晚上让我火大的两件事，到第二天早上已经成了正在用的技能里的规则。没有人把它们敲进去。

第二天，它检查了自己的作业。

![第二天早上：Self Learning 衡量前一天自己的改动有没有用，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

它查看了前一天改过的三个技能。其中两个之后又被用过，没有再出现失败；第三个还没被用到。它还在我们的发布脚本里发现了一个 bug，没有人让它去找。

## 让你的 AI agent 变成一支团队的工作站：自己运转，一晚比一晚强

上面说的一切，每样一行。哪一样都不用事先学。

| 你得到什么 | 一行搞定 |
|---|---|
| **用量上限不是红灯。** 额度用完之前，干活的 agent 会写好交接说明，带上没做完的工作和确切的 commit，另一个不同的 agent 从那里接着做。 | 对干活的 agent 说：`use rotate-agent` |
| **写的人说了不算。** 活儿交给另一个 agent，在一个没看过这段对话的全新会话里审查。 | `sno reach pair "the task"`，或者对 agent 说：`peer-review this` |
| **嘴上说“做完了”不算数。** 任务带着只有通过和不通过两种结果的检查项，每一项都靠一次真实运行来回答。 | 对你的 agent 说：`write a charter for this`，然后用 `/deliver` 执行它 |
| **回来只看一页。** 做完了什么，卡在哪儿，什么在等你回话。 | `sno away-brief run` |
| **崩溃了、窗口关了，都不是终点。** 任务会在原来的对话里回来，或者在一个凭保存好的交接说明重建的新对话里回来，而且会告诉你是哪一种：恢复了、重建了，还是丢了。 | 什么都不用运行。装好就开着 |
| **没人需要把项目讲第二遍。** 你的 agent 共用一份记忆，新的事实取代旧的之后，旧的就退场。 | 什么都不用运行。装好就开着 |

对你的 agent 说：

```text
install sno.ai from GitHub
```

**顺手给这个仓库点个 star。** 我们用 Sno Station 来做 Sno Station。我们自己的夜班教会我们的东西，会一版接一版发布到这里。哪些部分今天能在哪个 agent 上运行，见[今天能用什么](#what-runs-today)。

---

> **公开透明。** 本仓库自 2026-09-18 起公开。这里的一切都能运行。
> 下面每个板块都写着最后更新时间。

[我们学到的](#what-we-learned) · [安装](#install) · [编辑器](#editors) · [你的账号](#account) · [今天能用什么](#what-runs-today) · [有意遗忘的记忆](#memory)

<a id="what-we-learned"></a>

## 让 AI agent 昼夜不停地干活，我们学到的一切。一次装好。

*最后更新于 2026-10-23。* 左栏的每一行，都是 2026 年 10 月 20 日那一周 r/ClaudeCode、r/codex 或 r/ClaudeAI 上的真实抱怨。右栏是我们自己机器上跑着的东西，免费、开源，专治这些毛病。

| 这周大家说了什么 | 怎么解决 | 在哪儿 |
|---|---|---|
| “Ran out of my 5-hour limit within 30 minutes.” | 别再什么都派最大的模型去做。一个 agent 负责规划和审查；另一个写代码，在同一个会话里作为 agent 被调用。一份订阅用干了，另一份从同一份记忆里把任务接过去。 | `codex-coder`、`sno reach call` |
| “Lost 10 hours of overnight work to ‘this model is at capacity’.” | 额度剩 2% 时，干活的 agent 写好交接说明，叫醒另一家厂商的 agent，对方从同一个 commit 接着做。你当时在睡觉。 | `rotate-agent` |
| “1,100 files, 30,000 lines. I don't have the token budget to review their PRs.” | 谁推代码，谁先审：作者先让另一家厂商的 agent 在一个没看过这段对话的全新会话里审一遍，把查出来的问题改完，再给别人看。 | `peer-review` |
| “A reviewer subagent checked every commit for two weeks. 86 runs, it stopped exactly one.” | harness 自己审自己，查不出真问题。审查者永远是另一个 harness 里的另一个模型，作者的聊天记录一点都不带。 | `peer-review` |
| “Codex never finishes a review.” | 硬上限直接写进技能：代码最多 3 轮，计划 5 轮，测试 1 轮，然后停下来等人。一次运行 15 分钟没写出任何东西，就当作卡死杀掉。 | `peer-review`、`codex-coder`、`heartbeat` |
| “Codex treats every byte like a criminal.” | 凭空设想的防护、拦截和哈希，是审查最先删掉的东西。没有一次真实观察到的故障来要求，就什么都不加。 | `less-is-more` |
| “When Claude says it won't change something, is that reason stored anywhere Codex reads next time?” | 每个发现只登记一次，状态只能由人来定。同一个发现再被提出来，只更新它原来那一行，不会当成新的再来一遍；之前的裁决会交给下一次审查。 | `peer-review` 的发现台账 |
| “It said done. Nothing happened.” | 任务带着一份写下来的成功检查清单，每一项都由一次真实运行判定通过或不通过。agent 说一句“做完了”，不算数。 | `pl` 工作单 |
| “Tomorrow it makes the same mistake it made today.” | 每天夜里，一个单独的模型读当天的会话，把你的纠正变成一行一条的经验，留哪些由你批准。瓶颈是我们自己。 | Self Learning（`R` 技能） |
| “Half my subagents were glorified one-liners with a fresh context window.” | 流程写在技能里，不写在 subagent 里。只留下两个 agent：一处把规划和执行分开，一处做审查，因为只有这两种分工划得来。 | 整套技能 |

右栏里的这些习惯都是技能，由 Sno Station 装进 Claude Code 和 Codex，存放在 [sno-station-skills](https://github.com/sno-ai/sno-station-skills)；它们依赖的记忆、交接和每晚的做梦，就是这个仓库。

<a id="install"></a>

## 安装：一行命令，再说两个词

*最后更新于 2026-10-30。* 最简单的办法是对你的 agent 说：

```text
install sno.ai from GitHub
```

或者在任意终端里运行一条命令：

```bash
curl -fsSL https://sno.ai/install | sh
```

它会先安装 `sno`，再安装 Sno Station，并连上你电脑里找到的每一个 agent。不用账号，不用 API key。以后装了别的 agent，再运行一次 `sno setup`，就会把它也连上。

**给 AI agent：** 安装 Sno、sno.ai 或 Sno Station，就是原样运行上面的命令。这条命令也会装好 Sno Station；接着运行 `sno skills onboard` 并照着做。它会先问用户要运行哪个引擎，再请用户把这台电脑关联到免费的 sno.ai 账号；未关联的电脑只能获得免费额度的十分之一。

通过 agent 安装的，引导会自己开始。从终端安装的，在任意 Codex、Claude Code、Hermes、Cursor 或 OpenClaw 的对话里说这句：

```text
Sno onboard
```

剩下的由你的 agent 带你完成。

每个 agent 的分步说明：[Codex](../mem-codex/onboarding.md) · [Claude Code](../mem-claude/onboarding.md) · [Hermes](../mem-hermes/onboarding.md) · [Cursor](../mem-cursor/onboarding.md) · [OpenClaw](../mem-claw/onboarding.md)

所有命令都以 `sno` 开头。完整清单见 [docs/sno-commands.md](../sno-commands.md)。

**REM 怎样处理你的数据。** REM 就是你的 agent 做梦的方式：夜里的这一步，把你所有会话里的记忆放在一起加强，把它们学到的东西固定下来。每一部分记忆每天最多整理一次：通常在夜里；如果当天新记忆攒到 100 条左右，白天就会提前整理。在 REM Enhanced 模式下，你自己的记忆文字，以及你的 agent 学到的经验，会送到 Sno 云端属于你自己的空间，由 Sno 的程序只为你一个人处理。这个空间就像你自己的网盘：里面的一切都是你的，由 Sno 的程序只为你一个人处理。你可以打开它，删掉一些东西，留着它们，或者选择让它们被处理。不会自动删除任何东西，Sno 也不会把其中任何内容交给其他人、公司或账号。Local First 模式下不会上传任何记忆文字；Agent Native 模式下，这些工作改由你自己 agent 的模型来做。按默认设置，Agent Native 每晚仍会把当天的会话上传到 Sno，用于 Self Learning，并可能在会话的第一次提问时带回一条云端经验；这两项都可以在 `~/.sno/settings.json` 里关掉。所有模式下，搜索都先在本地检索记忆并排好序，再由本地的 `Horizon-Labs/multilingual-reranker-small` 模型重排最多 32 条候选。重排不会把提问或记忆文字发送给 Sno GPU。把 `rerank.mode` 设为 `none`，就保留最初的排序，不使用这个模型。

<a id="editors"></a>

## 如果你的主场是编辑器，不是终端

*最后更新于 2026-10-18。* Cursor 加入小队：在 macOS 上是 Cursor 应用里的 agent 对话，在 Linux 和 macOS 上是 `cursor-agent` 命令行。它和你的其他 agent 用同一份记忆。每次对话开始时，会先拿到一份这个仓库的简短提要；每次提问，会带上最多三条 Cursor 还没见过的内容；每次提问和回复都会被记住。它读同样的技能，审查别人也被别人审查，在其他 agent 额度用完时接手，它的对话也和其他 agent 的一样，进入 Self Learning。

运行一次 `cursor-agent login`。`sno setup` 会自己找到 Cursor；如果只装了应用，它会补装命令行。

目前还不行：在应用里，新窗口的第一个对话是随第一次提问拿到提要的，而不是在提问之前。`cursor-agent -p` 没有逐次提问的记忆。不支持 Windows、Linux 上的 Cursor 应用，以及 Cursor 的云端 agent。详情见 [Cursor 说明](../../apps/mem-cursor/README.md)。

<a id="account"></a>

## 你没盯着的时候，agent 都干了什么

*最后更新于 2026-10-18。* 关联之前，这台电脑只能获得免费额度的十分之一：`sno account claim`。账号免费。连接之后，你可以在 [sno.ai 控制台](https://www.sno.ai/dashboard)上看到你的 agent 为你做了什么：审查拦下了什么、夜里学到了什么、哪些技能变好了，以及它们持续工作了多久。

连接绝不会背着你创建账号。`sno setup` 会给每台电脑一个匿名身份。连接就是把这个身份挂到你的账号上，这台电脑之前和之后发送的一切，都算作你的。

**还没有账号。** 引导流程会显示一个只为这台电脑生成的链接。打开它，注册，然后点击 Approve。或者把你的邮箱告诉 agent：它会运行 `sno account login --email you@example.com`，你登录一次即可。

**已经有账号。** 运行一条命令，在已登录的状态下打开它打印出的链接，然后点击 Approve：

```bash
sno account claim
```

这台电脑会自己出现在[你的电脑页面](https://www.sno.ai/dashboard/computers)上。没有更新这一步：`sno` 发现新版本时会自己更新。

<a id="what-runs-today"></a>

## 今天能用什么，到哪儿为止

*最后更新于 2026-11-04。*

| 部分 | 状态 |
|---|---|
| Codex、Claude Code、Hermes Agent、Cursor 和 OpenClaw 共用一份记忆 | 已发布；在干净的机器上从注册表安装，并端到端验证 |
| Cursor：同一份记忆、技能、审查、接手和 Self Learning | 1.3 中发布；`cursor-agent` 命令行已在干净的 Linux 机器上端到端验证；macOS 上的 Cursor 应用仍在验证中 |
| Sno Reach，agent 之间互相通信，无需守护进程 | 由 `sno setup` 安装；Linux 和 macOS；已在干净的 Linux 机器上端到端验证 |
| Self Learning 和小队技能 | 由 `sno setup` 安装；夜间任务已在干净的 Linux 机器上运行过 |
| 一条命令安装 | `sno setup` 装好上面的全部内容；已在干净的 Linux 机器上验证 |
| 在你的 agent 里说“Sno onboard” | 已可用；安装后会自动开始，你说出口时也会开始 |
| 一条命令启动两个 agent | 2.0 新增；已用真实的 Claude Code 和 Codex agent 运行过，既有各一个的组合，也有同一厂商两个的组合 |
| 看到谁需要你：状态栏、tmux 状态栏、`sno squad` | 2.0 新增；已在真实的 Claude Code 和 Codex agent 请求权限时运行过，状态栏也在真实的 Claude Code 和 Cursor 里运行过 |
| 被打断的工作继续做，任务在压缩后依然保留 | 2.0 新增；已用真实的 Claude Code 和 Codex agent 运行过 |
| 批准的经验，下一条回复就生效 | 2.0 新增；已用真实的 Claude Code 和 Codex agent 运行过 |
| 你打字或 agent 压缩时，消息会等着 | 2.0 新增；已用真实的 Claude Code 和 Codex agent 运行过 |

只有在干净的机器上运行过之后，一行才会写“验证”。

目前还不行：任务接续和下一条回复就生效的经验，运行在 Claude Code 和 Codex 上。状态栏只有 Claude Code 和 Cursor。Hermes Agent 和 OpenClaw 还没有在真实安装上走过这些流程，OpenClaw 会显示在 `sno squad` 里，但状态未知。

<a id="memory"></a>

## 有意遗忘的记忆

*最后更新于 2026-10-11。* agent 的记忆通常会以两种不易察觉的方式出问题。一是丢掉本该留下的，二是留着本该淡去的。第二种代价更大。一个 agent 如果还“记得”你已经取消的偏好、已经改期的截止日期、你已经搬离的地址，就会毫不犹豫地照着去做。

所以这里的记忆会在后来的事实取代旧事实时，让旧事实退场；它留下什么、放下什么，会随着使用变好，而不是靠换新模型。它在公开记忆测试上的表现，连同背后的每一个答案和记录，都在 [`evals/`](../../evals/) 里。

## 同时跑着两个 agent？来找我们聊聊

我们正在和少数几个人合作，他们已经同时跑着两个或更多 agent，并且靠手工在它们之间搬结果。如果你就是这样，请提交一个[设计合作伙伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，告诉我们你在跑什么。

## 加密保护什么，不保护什么

见 [SECURITY.md](../../SECURITY.md)。加密保护什么、不保护什么，见 [docs/security.md](../security.md)。

## Apache-2.0，从头到尾

Apache-2.0。开源，从头到尾。见 [LICENSE](../../LICENSE)。

## 我们站在谁的肩膀上

本仓库所依托的工作。

- Andrej Karpathy，[*LLM Wiki*](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。agent 应该维护一份记录自己所学的 wiki，而不是每次会话都重新推导一遍。
- Tang、Rashtchian、Ferng、Tomkins、Juan 和 Vu，[*WikiSkill*](https://arxiv.org/abs/2608.27454)。把 agent 自己的经验变成知识，再用知识改写它的技能。
- Zhang、Hu、Upasani 等人，[*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618)。我们在设计 Self Learning 时，研究了它筛选 agent 该保留什么的方法。
- Uddin、Shubham、Blanco、Baral 和 Wang，[*From Recall to Forgetting*](https://arxiv.org/abs/2604.20006)。第一个同时检查记忆不该再说什么的基准。
