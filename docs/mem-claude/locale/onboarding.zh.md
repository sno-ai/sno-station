# Sno Memory for Claude Code — 初次设置

这份说明描述 `@snoai/mem-claude` 的公开安装与首次设置流程。

## 开始设置

要求：

- PATH 上有 Claude Code
- Node.js：22 系列需 22.22.3 及以上，24 系列需 24.15.0 及以上，或 25.9.0 及以上
- PATH 上有 `git`（memory 按你所在的 repository 划分范围）

先按[共用记忆服务安装说明](../../memory-setup.md)完成设置，再安装 Claude Code 插件：

```bash
npm install -g @snoai/mem-claude@1.1.0
sno setup --harness claude
```

共用安装步骤写入 `<配置根目录>/settings.json`，插件安装命令配置 Claude Code。配置根目录是
`SNO_PROFILE_DIR`，未设置时为 `~/.sno`。请私下备份这个文件，里面有记忆库的唯一密钥。

## 第一步：选 memory mode

首发安装步骤在 `<配置根目录>/settings.json` 中选择 Local First；配置根目录是
`SNO_PROFILE_DIR`，未设置时为 `~/.sno`。以后若手动修改 mode，必须保留原来的
`store.path` 和 `store.encryptionKey`；换掉密钥就无法读取旧记忆。请私下备份 `settings.json`。

### Local First

Local First 适合完全本地运行：

- 规则式、原文式地 capture 你的每一轮对话；
- 确定性的 profile merge 与 task 处理；
- 不生成由模型撰写的 reflection summary；
- 不需要 LLM credential。

默认 embedder 在本地运行。第一次使用时可能需要下载模型，缓存完成后不再依赖远程服务。

### Agent Native

Agent Native 把你自己的 Claude Code 当作 memory 模型。

capture worker 用 `claude -p` 起一个单轮、关掉 hooks、没有工具、不读设置、不保存会话的子进程，
跑在你已有的 Claude Code subscription 上。不收 API key，也不存 key。所有需要模型判断的 memory
决定都经过这个子进程。

### REM Enhanced

REM Enhanced 让 Sno GPU 负责 LoRA 覆盖的 extraction 与 conflict call，其余需要模型判断的
memory 决定由你的 Claude Code 处理。REM Enhanced 需要在 `settings.json` 的 `snoGpu.apiKey` 中配置 Sno GPU 密钥。

## 第二步：确认其他默认值

记忆插件的标准默认值如下：

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Scope | 当前 repository，加上处处可读的 `global` scope |
| Embedder | Local |
| Ambient capture | 开（每一轮完成的对话都 capture） |
| Auto-recall | 开（session 开始和每个 prompt） |
| Session handling | 本地 system session memory |
| Management tools | 关闭 |
| Cloud observability | 关闭 |

每个模式的默认 routing 如下：

| Memory-writing call | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | 规则式、原文式 | 你的 Claude Code | Sno extraction model |
| Classify active tasks | Keyword rules | 你的 Claude Code | 你的 Claude Code |
| Merge profile sections | Deterministic merge | 你的 Claude Code | 你的 Claude Code |
| Match completed tasks | Token overlap | 你的 Claude Code | 你的 Claude Code |
| Resolve conflicts | 两条都保留 | 你的 Claude Code | Sno conflict model |
| Build reflection summary | 不生成 model reflection；仍保留 local session memory | 同左 | 同左 |
| Resolve relative dates | 不调用模型 | 你的 Claude Code | 你的 Claude Code |

Agent Native 与 REM Enhanced 不会把任何 memory-writing call 永久关掉。单次 model
request 失败时，只对该次请求使用对应的 Local First 行为，不会偷偷切到另一个 model tier。

REM Enhanced 的模型调用目标由所选模式决定，不能按用途单独修改。
上表的模型调用目标由所选模式固定。

两个 REM operation 会按周期触发在整个 store 上运行，模型调用目标由所选模式决定：

- `rem-update`：把过程叙述改写成干净的当前态 memory，同时保留历史；
- `rem-replace`：在整个 store 上裁决矛盾，把落败的 memory 可逆地软关闭。

默认两个都请求。在 `settings.json` 中改 `rem.operations` 可只选一个，把 `rem.tick`
设为 `false` 可关掉触发。

Mode selection 不承诺最终 retrieval 或 reranker 行为。

## 第三步：完成设置并验证

`sno setup --harness claude` 安装 hook 组、permission 规则和 skill，每一步打印一行结果。记忆设置无法读取时，保留原文件和备份以便恢复密钥；只有新配置才照共用安装说明重新设置。

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

在 Claude Code 会话里完成的每一轮对话会在 `Stop` hook 触发后自动 capture；显式命令用于你想立刻存下
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
