# Sno Station 🧊 — Agents, assemble. Two heads are better than one, and smarter by morning.

![Sno Station — 两个终端 agent 共享同一份记忆，运行在你自己的机器上](../images/hero-banner.png)

[![license Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-97ca00.svg?labelColor=3b3b3b)](../../LICENSE)
![status assembled in public](https://img.shields.io/badge/status-assembled%20in%20public-2dd4bf.svg?labelColor=3b3b3b)
![runs on your laptop, no daemon](https://img.shields.io/badge/runs%20on-your%20laptop%2C%20no%20daemon-3b82f6.svg?labelColor=3b3b3b)
![harnesses Claude Code, Codex, OpenClaw](https://img.shields.io/badge/harnesses-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20OpenClaw-f0a04b.svg?labelColor=3b3b3b)

**其他语言版本：** [English](../../README.md) · **中文** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [繁體中文](README.zh-TW.md)

Sno Station 是你的 agent 的工作站：一款开源软件，它把你已经在运行的 AI agent——无论是编码 agent 还是通用
工作 agent——变成运行在你自己机器上的同一支团队。当其中一个撞上它的速率限制，另一个
会带着完整的上下文接手。它们会互相审阅对方的工作，所以到达你手里的错误更少。而它们
共享的那个工作区每晚都会变得更聪明：它读取它们的会话，向它们自己的技能提出修改建议，
并等待你点头。

**属于你，而且始终属于你。** 记忆、消息和技能都存放在你笔记本电脑上的同一个工作区里。
不需要守护进程，不需要服务器，也不需要云；云端功能到来之时是可选的，产品在没有它的
情况下也是完整的。Apache-2.0，从头到尾开源。记忆存储从第一次使用起就在你的机器上加密，
密钥只配置一次，且永远不会离开你的机器；Sno 永远不会收到你的数据库或你的密钥。完整的
边界说明——它保护什么、不保护什么——见 [docs/security.md](../security.md)。

**支持你的语言。** 用英语、中文（简体或繁体）、日语、韩语、德语、法语、西班牙语或俄语和你的 agent 对话；
记忆引擎会为每条记忆存储其语言，按地区分类，并在每个 key 和搜索中保持中日韩文字完整
无损。Duo 技能
的写法可以用你和 agent 交流时使用的任何语言来遵循，本 README 提供九种语言版本。

![工作原理：两个 agent，一个共享工作区，你能获得的三件事](../images/squad-how-it-works.png)

> **公开组装中。** 本仓库正在被一块一块地开放，从 2026-09-18 开始。今天在这里的内容
> 是真实可用的；还没在这里的内容则不做任何声明。下面每个板块都会标注最后更新时间。

[安装](#install) · [如何使用](#how-to-use) · [今天可运行的功能](#what-runs-today) · [有意遗忘的记忆](#memory-that-forgets-on-purpose) · [设计合作伙伴](#design-partners) · [参考文献](#references)

## Install

*最后更新于 2026-09-19。* 还没有。一条命令完成安装会随 onboarding 技能一起上线；
在那之前，请持续关注本仓库。上线后它会是这样的：

```bash
# inside any Claude Code, Codex or OpenClaw conversation:
Sno onboarding
```

Agent 会通过 `sno` CLI 自行完成设置：共享记忆、Sno Reach、Duo 技能，以及每种 harness
所需要的 hook。不需要记住任何包名。

## How to use

*最后更新于 2026-09-19。* 安装完成后，你可以继续像以前一样工作，用你喜欢的任何一个
agent。有三件事会改变：

1. **其中一个撞上了它的上限。** 在另一个 agent 里说 `sno reach call`；它会从共享记忆
   和邮箱里接手任务，上下文完整无损。
2. **你想要多一双眼睛来审查。** 让任意一个 agent 对另一个的工作做 `peer-review`。
   审查者总是来自另一个 harness。
3. **每晚 RSI 循环都会运行。** 第二天早上，对你喜欢的提案运行 `rem-reflect accept <id>`。
   不点头，什么都不会改变。

## "我昨晚冲着我的 agent 发了火，它记下来了。"

*这是我们自己机器上的实际样子。三天，三份报告。最后更新于 2026-09-19。*

**第一天——它学习了。**

![夜间循环报告它学到了什么、改动了什么，2026-09-18](../evidence/rsi-self-repair-2026-09-18.png)

这是我们在本仓库上运行的 RSI 循环给出的一份真实报告。它每天读一次我们自己的 agent 会话，
找出反复出现的错误，并向 agent 自己的技能文件提出修改建议。一个人来阅读这些提案，
接受或拒绝。不点头，什么都不会改变。那天晚上让负责人感到沮丧的两件事，到第二天早上
就已经变成了活跃技能里的规则；没有人手动输入过它们。

**第二天——它检查自己的作业。**

![第二天早上：RSI 循环测量昨天自己做的改动是否有效，2026-09-19](../evidence/rsi-skill-impact-2026-09-19.png)

下一次运行在 00:58 自动触发，读取了 113 个会话，并测量了它前一天修改的三个技能。
三个技能的失败率都降到了零。它还在我们的发布脚本里发现了一个真实的 bug——zsh 一直
把它藏在 bash 的视线之外。没有人让它去找。

**第三天——你安装它。** 这个 RSI 循环这周会作为本仓库中的一个技能发布；到那时，这个板块
就会变成安装命令。在那之前，这个板块会随着循环的运行而更新：每周一份新的报告，
不做任何修饰。

这个循环受两项我们一直反复回味的工作启发：Andrej Karpathy 的 *"LLM Wiki"*——agent
应该保留一份持久的、可编辑的 wiki 来记录自己学到的东西，而不是每次会话都重新推导
一遍；以及来自 Google Research 和 Virginia Tech 的 *"WikiSkill"*——它把 agent 自己的
经验编译成持久知识，用来重写它自己的技能。链接见[参考文献](#references)。

## "共事数月，另一个从没说过一句'看起来不错'。"

数月以来，我们一直让 Claude Code 审查 Codex 的工作，也让 Codex 审查 Claude Code 的
工作，就在这个仓库上。没有一次审查是空手而归的。一次都没有。我们曾经以为这说明这项
工作做得不好。其实它说明的是：只靠一个 harness 的一个审查者永远不够。

我们把这一对称为 Duo：最小的小队。我们从不说哪一个更细心、哪一个更快。这个角色每个月、
每项工作都会互换。重点在于它们彼此不同。

## "我睡了一觉，它换了班。"

*这是我们自己机器上的实际样子，2026-09-18。*

![配额监视每五分钟读一次，一路降到阈值，交接在 2% 时触发](../evidence/rotation-quota-watch-2026-09-18.png)

我们的一个 agent 正在做一个二十七项任务的构建，做到第二十一项时，它的周配额降到了 2%。
它没有停在那里等死。它写了一份交接简报：做完了什么，做了一半的是什么，该从哪个 commit
继续。然后它唤醒了另一个 harness 的一个 agent，并且在对方量出简报的大小和校验和、
并亲口说出来之前，不让它碰任何东西。

有一件事出了错，而这恰恰是值得读的部分。接手方在确认释放之前就开始编辑了。发出方
发现了，叫停它，重写了简报，然后再次正式释放。交接开始十四分钟四十一秒后，第二个
agent 已经在工作，第一个带着 1% 的余量签退。交接之前的每一个 commit 都完好无损；
第二个 agent 从第一个未勾选的任务继续，而不是从头开始。这整个过程我都在睡觉。

整晚的记录都在 [docs/evidence/rotation-2026-09-18/](../evidence/rotation-2026-09-18/)：
每隔五分钟一次的全部配额读数、简报的两个版本、就绪和释放的回执，以及 commit 摘要。
主机名、地址和会话 id 已做脱敏；其余一概未动。

## What runs today

*最后更新于 2026-09-20。*

| 部分 | 状态 |
|---|---|
| `packages/chunking` | 在本仓库中，已测试，已发布到 npm |
| 共享包（`common-core`、`utils`、`embedder`、`sno-observe`、`sno-station-core-crypto`、`content-sanitizer`） | 在本仓库中 |
| Claude Code、Codex 与 OpenClaw 之间的共享记忆 | 引擎与全部三种皮肤均已在本仓库中；干净机器验证待完成 |
| Sno Reach —— agent 之间互相通信，无需守护进程 | 源码在本仓库中；发布归档待完成 |
| RSI 循环（技能） | 本周 |
| 一条命令完成安装（`sno assemble`，或在你的 agent 里说 "Sno onboarding"） | 尚未声明 |

只有在一台干净的机器上运行过之后，一行才会写“proven”；在那之前，它写的是这里已经有什么。

## Memory that forgets on purpose

*最后更新于 2026-09-19。*

记忆是这个产品的地基，而不是它的头条。但地基恰恰是大多数 agent 记忆系统失败的地方，
而且失败得悄无声息，有两种方式：它忘记了本该留下的东西，也留下了本该衰减的东西。
第二种失败代价更高。一个 agent 如果依然"记得"你已经取消的偏好、已经改期的截止日期、
你已经搬离的地址，它会带着十足的信心照此行事。

在今年之前，没有人测量过这一点。人们常引用的那些长期记忆基准（LoCoMo、LongMemEval）
只给召回打分：正确的事实有没有被找回来。一个从不遗忘任何东西的系统在这些基准上能拿
满分。2026 年 4 月，亚利桑那州立大学的一个团队发布了 **Memora**（Uddin、Shubham、
Blanco、Baral、Wang，*From Recall to Forgetting: Benchmarking Long-Term Memory for
Personalized Agents*，[arXiv 2604.20006](https://arxiv.org/abs/2604.20006)，
ACL 2026 Findings）。这是第一个围绕第二种失败构建的基准。每个问题都带有两类检查：
必须被召回的事实，以及在对话中已被取消或被取代、绝**不能**再出现的事实。它的核心指标
**FAMA**（Forgetting-Aware Memory Accuracy，遗忘感知记忆准确率）等于召回率减去 agent
仍在依赖的每一个过期事实所带来的惩罚。论文对其测试的六个记忆 agent 得出的结论是：
"frequent reuse of invalid memories and failures to reconcile evolving memories."
（频繁复用失效记忆，且未能协调不断演变的记忆。）

那正是 Sno Station 的记忆系统被设计来通过的考试，也是它的记忆会自我改进的原因：
什么被留下、什么被淘汰、以及后来的事实如何取代早先的事实，都会随使用而变化，而不是
随模型版本的发布而变化。

![Memora 周度track：FAMA 与遗忘代价，Sno Station 对比论文中的六个 agent](../images/memora-forgetting-cost.png)

**我们在论文周度 track 上的结果**（六个 persona，九十个问题，一次正式运行，
2026-09-06；[九十道题的回答、裁判记录和 trace](../../evals/memora/formal-run-2026-09-06/)
都在这里）：

| | Remember | Reason | Recommend | **FAMA** | MPA（仅召回） | 遗忘代价 |
|---|---:|---:|---:|---:|---:|---:|
| **Sno Station** | 77.4 | 93.3 | 90.9 | **87.2** | 91.0 | **3.76 分（占召回率的 4.1%）** |
| LangMem（论文） | 71.2 | 30.0 | 48.9 | 50.0 | 57.7 | 7.70（13.3%） |
| Nemori（论文） | 65.1 | 18.7 | 52.8 | 45.5 | 53.1 | 7.60（14.3%） |
| MemoryOS（论文） | 51.8 | 20.7 | 62.6 | 45.0 | 51.7 | 6.70（13.0%） |
| MemoBase（论文） | 43.6 | 18.0 | 68.9 | 43.5 | 51.5 | 8.00（15.5%） |
| A-Mem（论文） | 71.8 | 2.0 | 35.0 | 36.3 | 39.3 | 3.00（7.6%） |
| Mem-0（论文） | 40.4 | 16.0 | 52.6 | 36.3 | 39.8 | 3.50（8.8%） |

如何诚实地解读这些数字：

- **遗忘代价**是 MPA 减去 FAMA：系统因过期事实而损失的分数。请把它看作该系统自身召回率
  的一个占比，而不是原始分数。A-Mem 和 Mem-0 损失的原始分数更少，仅仅是因为它们召回的
  东西太少，没剩下多少可以损失的。
- **推理**（组合多条记忆）是已发表领域中最薄弱的一环，满分 100 分中只有 2 到 30 分。
  我们的分数是 93.3。
- 论文中的六个 agent 是用论文自己的评判模型（GPT-4o-mini）打分的；我们的是用自己的
  评判模型体系打分，并按论文的逐题惩罚公式（§4.2）重新计算的。这是方向性的比较，而
  非经过认证的比较。我们的 FAA（正确排除掉的已取消事实的比例）测得为 0.833；论文没有
  按 agent 公布 FAA，所以图表中不展示任何竞品的 FAA。

另外三套证据遵循同样的规则：每项选择一个正式结果，底层回答或检索记录都在 `evals/`：

| 基准 | 它衡量什么 | 结果 |
|---|---|---|
| **LoCoMo** | 长对话问答，1542 个问题 | 96.76%（合并答案集：每轮修复后仍然答错的问题会被重新作答，已经答对的问题则沿用之前的结果；原始凭证注明了这一点） |
| LongMemEval-S（500 个问题）上的 **R@5** | 检索：正确的记忆是否出现在前五名内 | 95.4%（R@10 为 98.6，R@20 为 99.4） |
| **Sno Memory Bench** | 我们自己的 23 项端到端探测，包括公开基准未覆盖的"保留还是淘汰"场景 | 23 之 23 |

## Design partners

我们正在和一小批人合作，他们已经并行运行两个或更多 agent，并且要手动在它们之间
搬运结果。如果这说的就是你，请开一个[设计合作伙伴 issue](https://github.com/sno-ai/sno-station/issues/new?template=design-partner.yml)，
说说你在用什么。

## Security

见 [SECURITY.md](../../SECURITY.md)。

## License

Apache-2.0。开源，从头到尾。见 [LICENSE](../../LICENSE)。

## References

Work this repository builds on, with thanks.

- Andrej Karpathy. *LLM Wiki.* Gist, April 2026.
  https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan, Tu Vu
  (Google Research, Virginia Tech). *WikiSkill: Compiling Agent Experience into Persistent
  Knowledge for Skill Evolution.* arXiv:2608.27454, August 2026.
  https://arxiv.org/abs/2608.27454
- Qizheng Zhang, Changran Hu, Shubhangi Upasani, Boyuan Ma, Fenglu Hong, Vamsidhar Kamanuru,
  Jay Rainton, et al. (Stanford University, SambaNova). *Agentic Context Engineering: Evolving
  Contexts for Self-Improving Language Models.* arXiv:2510.04618, October 2025. Its curator
  and helpful/harmful bookkeeping were studied while designing our loop.
  https://arxiv.org/abs/2510.04618
- Md Nayem Uddin, Kumar Shubham, Eduardo Blanco, Chitta Baral, Gengyu Wang (Arizona State
  University). *From Recall to Forgetting: Benchmarking Long-Term Memory for Personalized
  Agents* (the Memora benchmark). arXiv:2604.20006, April 2026, ACL 2026 Findings.
  https://arxiv.org/abs/2604.20006
