# Sno Memory for Claude Code — 初次设置

这份说明描述 `@snoai/mem-claude` 的公开安装与首次设置流程。

## 开始设置

要求：

- PATH 上有 Claude Code
- Node.js：22 系列需 22.22.3 及以上，24 系列需 24.15.0 及以上，或 25.9.0 及以上
- PATH 上有 `git`（memory 按你所在的 repository 划分范围）

先按[记忆服务安装说明](../../memory-setup.md)完成设置，再安装 Claude Code 插件：

```bash
curl -fsSL https://sno.ai/install | sh
```

记忆服务安装步骤写入 `<配置根目录>/settings.json`，插件安装命令配置 Claude Code。配置根目录是
`SNO_PROFILE_DIR`，未设置时为 `~/.sno`。请私下备份这个文件，里面有记忆库的唯一密钥。

## 第一步：选 memory mode

首发安装步骤在 `<配置根目录>/settings.json` 中选择 Local First；配置根目录是
`SNO_PROFILE_DIR`，未设置时为 `~/.sno`。以后若手动修改 mode，必须保留原来的
`store.path` 和 `store.encryptionKey`；换掉密钥就无法读取旧记忆。请私下备份 `settings.json`。

### Local First

Local First 适合完全本地运行：

- 原文照存地 capture 你的每一轮对话；
- 确定性的 profile merge 与 task 处理；
- 不生成由模型撰写的 reflection summary；
- 不需要 LLM credential。

默认 embedder 在本地运行。第一次使用时可能需要下载模型，缓存完成后不再依赖远程服务。

### Agent Native

Agent Native 把你自己的 Claude Code 当作 memory 模型。

capture worker 用 `claude -p` 起一个单轮、关掉 hooks、没有工具、不读设置、不保存会话的子进程，
跑在你已有的 Claude Code subscription 上。不收 API key，也不存 key。所有需要模型判断的 memory
决定都经过这个子进程。

默认每晚会把当天会话上传到 Sno 做自我学习，会话的第一个提示也可能带回一条云端经验；你可以在配置根目录的 `settings.json` 中关闭这两项。

### REM Enhanced

REM 是你的 agent 做梦的方式：夜里它们加强记忆，并把当天学到的东西沉淀下来。每一部分记忆每天最多整理一次：通常在夜里；如果当天新记忆攒到 100 条左右，白天就会提前整理。REM Enhanced 让 Sno 自己的记忆模型帮忙做最难的两件事：从对话里记下重点，以及判断两条互相矛盾的记忆哪条对。其余工作由你自己的 Claude Code 处理，包括补全每条记忆的细节、确认它说的是谁。使用它需要在 `settings.json` 的 `snoGpu.apiKey` 里配置 Sno 的密钥。

**你的资料仍然是你的。** 在这个模式下，交给 Sno 处理的记忆文字，以及各个 agent 学到的经验，会送到 Sno 云端属于你自己的空间。它就像你自己的网盘：里面的一切都是你的，由 Sno 的程序只为你一个人处理。你可以进去删除、可以留着，也可以选择让它被处理。不会自动删除，Sno 也不会把其中任何内容交给任何人。

## 第二步：确认其他默认值

下表列出插件的标准配置；首发安装步骤会把 Memory mode 设为 Local First，实际值以 `settings.json` 为准。

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Scope | 当前 repository，加上处处可读的 `global` scope |
| Embedder | Local |
| Ambient capture | 开（会话安静 30 分钟或结束后，整段一起 capture） |
| Auto-recall | 开（session 开始和每个 prompt） |
| Session handling | 本地 system session memory |
| Management tools | 关闭 |
| Cloud observability | 关闭 |

每个模式的默认 routing 如下：

| 要做的事 | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| 记下重点 | 原文照存 | 你的 Claude Code | Sno 的记忆模型记下；你的 Claude Code补全细节、确认说的是谁 |
| 判断你在做哪件事 | 简单关键词匹配 | 你的 Claude Code | 你的 Claude Code |
| 更新对你的了解 | 固定规则 | 你的 Claude Code | 你的 Claude Code |
| 识别已完成的任务 | 字词比对 | 你的 Claude Code | 你的 Claude Code |
| 处理互相矛盾的记忆 | 两条都保留 | 你的 Claude Code | Sno 的记忆模型 |
| 排列要召回的记忆 | 在你的电脑上 | 在你的电脑上 | 在你的电脑上 |
| 总结这一天 | 不生成 model reflection；仍保留 local session memory | 同左 | 同左 |
| 把“明天”换成日期 | 不调用模型 | 你的 Claude Code | 你的 Claude Code |

Agent Native 与 REM Enhanced 不会把任何 memory-writing call 永久关掉。
在 REM Enhanced 模式下，Sno 模型请求被拒绝时（例如每周额度已用完），会改用你自己的 agent 模型；如果它也失败，该次请求才使用 Local First 行为。

REM Enhanced 的模型调用目标由所选模式决定，不能按用途单独修改。
上表的模型调用目标由所选模式固定。

REM 还会按计划整理你的记忆，分两种：

- 把“我以前……后来改了……”这样的过程叙述，改写成一条干净的当前记忆，同时保留历史；
- 处理互相矛盾的记忆：输掉的那条被收起，随时可以恢复。

默认两种都会做。在 `settings.json` 里改 `rem.operations` 可以只选一种，把 `rem.tick` 设为 `false` 可以关掉 REM 的定时运行。

模式选择决定记忆写入和维护的处理方式。所有模式下，搜索都先由本地程序检索并初排，
再由本地 `Horizon-Labs/multilingual-reranker-small` 模型重排最多 32 条候选记忆，
不会使用 Sno GPU 重排。把 `rerank.mode` 设为 `none`，即可保留程序初排、不使用重排模型。
模型正在加载、失败或超时时，也使用程序初排。其他记忆写入、REM 和自我学习的处理目标
仍由原有模式设置决定。

## 第三步：完成设置并验证

`sno setup --harness claude` 安装 hook 组、permission 规则和 skill，每一步打印一行结果。记忆设置无法读取时，保留原文件和备份以便恢复密钥；只有新配置才照记忆服务安装说明重新设置。

记忆服务按需启动。安装后第一个 hook 或 memory 命令会把它拉起来并等它健康。

subagent 和 git repository 之外的会话既不注入也不 capture。开了 `sandbox.enabled: true` 的会话
不支持：它的 memory 命令连不上本地记忆服务，要么关掉 sandbox，要么接受一行失败提示。

在一个 git repository 里开一个新的 Claude Code 会话，然后运行：

```bash
sno memory doctor --harness claude
```

输出四行：

```text
sidecar: healthy
hooks: SessionStart=present UserPromptSubmit=present Stop=present SessionEnd=present PreToolUse=present PostToolUse=present
permission rule: present
import receipts: "/absolute/path/to/repository"=present
```

import receipt 指向你刚打开的那个 repository；它的 Claude Code memory 笔记在第一次 session
start 时已经导入。

## 第四步：建立第一条有用 memory

优先保存每天都会有帮助的信息：

- 回复语言与语气；
- coding 与 review 偏好；
- 项目规则；
- package manager 规则；
- 常用工具或命令；
- agent 不应该重复做的动作。

在 repository 根目录显式存一条：

```bash
sno memory remember --harness claude "Prefer concise replies and tabs for indentation in this repository."
```

然后验证：

```bash
sno memory recall --harness claude "indentation"
```

在 Claude Code 会话里完成的对话会在会话安静 30 分钟或结束后，整段一起自动 capture；显式命令用于你想立刻存下
的事实。

不要把临时 debug 状态、测试输出或私有基础设施细节当作第一批 memory。

## 非交互式安装

`sno setup --harness claude` 不提问，可以写进脚本。`--json` 输出一个 JSON 值，代替逐行结果：

```bash
sno setup --harness claude --json
```

它不猜 credential、不打印 secret，也不暴露私有 endpoint。

## 已经安装

单独重跑 `sno setup --harness claude` 更新插件配置是幂等的：原位更新自己的 hook 组，别人的 hook 组留在原来的位置，只保留
自己的一条 permission 规则，重写 skill，其他一概不动。

要改 memory mode，手动修改 `settings.json`，并保留原记忆库和密钥。

正常 reinstall 会保留 memory library。

## 支持的运行面

Linux 命令行安装和 hook 失败路径有真实的验收记录。macOS 命令行和桌面版本地会话在拿到各自的
记录之前算未验证。云端、网页、经 SSH 的会话和 VS Code 扩展不在承诺范围内。

## 验收清单

以下条件全部满足，onboarding 才算完成：

- memory mode 记录在 `settings.json`，首发安装步骤选择 Local First；
- Local First 无需 LLM credential 即可完成；
- Agent Native 跑在已有的 Claude Code subscription 上，不收任何 key；
- REM Enhanced 用公开语言说明 Sno 与 Claude 各自负责的工作；
- install 命令只写自己的条目，`--dry-run` 什么都不改；
- 新会话之后 `doctor` 打印 `healthy`、六个 `present` 的 hook 和 `present` 的 permission 规则；
- 用户能创建并验证第一条 memory；
- 输出中没有 secret、私有 hostname、内部路径或部署说明。
