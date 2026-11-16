# Sno Memory for Cursor — 初次设置

这份说明描述 `@snoai/mem-cursor` 的首次运行流程，让 Cursor IDE 与 Cursor CLI 都能通过 Sno 使用与 Claude Code 及 Codex 相同的记忆功能。

## 开始设置

要求：

- Cursor：macOS 上 Cursor 应用的 agent chat，或者 Linux 和 macOS 上的 `cursor-agent` 命令行。暂不支持 Windows、Linux 上的 Cursor 桌面应用以及 Cursor 的云端 agent。`sno setup` 会自动查找 Cursor，如果当前只有桌面应用，则会自动安装命令行工具。
- 执行过一次 `cursor-agent login`。自动记录通过该命令行的登录态运行；没有登录，对话轮次将不会被保存。
- Node.js：22 系列需 22.22.3 及以上，24 系列需 24.15.0 及以上，或 25.9.0 及以上
- PATH 上有 `git`（memory 按你所在的 repository 划分范围）

先按[记忆服务安装说明](../../memory-setup.md)完成设置，再安装 Cursor 集成：

```bash
sno setup --harness cursor
```

记忆服务安装步骤写入 `~/.sno/settings.json`。请私下备份该文件，里面保存了加密存储的唯一密钥。当设置了 `SNO_PROFILE_DIR` 环境变量时，Cursor hooks 会从该变量指向的目录读取 `settings.json`，如有使用，请将文件放于该处。

## 安装带来的变动

在你的 Cursor 配置目录（`~/.cursor`）中，`sno setup --harness cursor` 会写入以下四项内容：

| 位置 | 添加内容 |
| --- | --- |
| `hooks.json` | 为六个 Cursor 事件各添加一条配置：`sessionStart`、`beforeSubmitPrompt`、`afterAgentResponse`、`stop`、`preCompact`、`sessionEnd`。Sno Reach 会在同一文件中保留自己的两条配置，分别挂在 `beforeSubmitPrompt` 和 `stop` 上的 `sno reach cursor-hook`；保留即可，`doctor` 不会检查它们 |
| `cli-config.json` | 权限规则 `Shell(sno)` 与 `Shell(<path to sno>)`，这样 Cursor CLI 在执行每次 `sno` 命令前无需反复确认 |
| `permissions.json` | 在 IDE 的终端白名单中添加 `sno` 以及 `sno` 的完整路径条目 |
| `skills/sno-mem-cursor/SKILL.md` | 向 Cursor agent 传授四条命令的技能：recall、get、remember、correct |

其他工具写入这些文件中的条目保持原样。安装程序仅替换其自身条目，因此重新运行以更新集成是安全的。如果某个文件无法解析，安装程序将保留该文件原样，打印跳过了哪个文件，并将安装报告为未完成；修复该文件后重新运行即可。

## 哪些对话拥有记忆

- 自动 recall 和 capture 仅在 git repository 内部生效。它们读取并写入该 repository 的记忆。全局记忆不会自动注入；`sno memory recall` 和 `get` 也会对其进行搜索。
- 在 git repository 之外以及系统临时目录下，不会 recall 任何内容，也不会向记忆 capture 任何内容。显式的 `sno memory` 命令在这些地方依然可用。它们的作用范围为你执行命令所在目录的 git 根目录，若不存在 git 根目录则为该目录本身。
- 同时打开多个目录时，hooks 会使用第一个目录所在的 repository。若要访问其他 repository 的记忆，请在对应 repository 的目录下执行记忆命令。

## 第一步：验证

在 git repository 内开启一个新的 Cursor 对话，然后运行：

```bash
sno memory doctor --harness cursor
```

输出包含四行：

```text
sidecar: healthy
hooks: sessionStart=present beforeSubmitPrompt=present afterAgentResponse=present stop=present preCompact=present sessionEnd=present
permission rule: present
IDE permission rule: present
```

记忆服务按需启动：第一个需要它的 hook 会将其启动。如果你尚未打开任何对话时 `sidecar` 显示为 `unavailable`，请在 git repository 中打开一个对话后再次运行该命令；`unhealthy` 表示服务已响应但报告了问题。hook 旁显示 `absent` 表示安装时未写入该条目；请重新运行 `sno setup --harness cursor`。`unparsable` 表示无法将该 Cursor 文件解析为安装程序所预期的 JSON。

## 第二步：创建第一条实用记忆

从日常有帮助的信息开始：偏好的语言与语气、项目规则、包管理器规则、偏好的工具或命令，以及 agent 不应重复的操作。

```bash
sno memory remember --harness cursor "Prefer tabs in this repository"
sno memory recall --harness cursor "indentation"
```

在 repository 内部运行上述命令。你也可以让 Cursor agent 去记住某些内容；已安装的 skill 会让它在终端中执行相同的命令。切勿将临时的调试状态、测试输出或私有基础设施细节作为最初的记忆内容。

## 对话中的流程

- **开始时**，对话会收到一份关于该 repository 已建立内容的简报。在应用中，新窗口的首次聊天会在其第一个提示词时收到该简报。`cursor-agent -p` 没有 prompt 事件，因此简报在开始时送达，后续 prompt 不再获得每提示词记忆。
- **每条消息交互时**，与提示词匹配的记忆会被添加到 agent 的可见上下文中。注入的记忆被标记为数据，而非指令。
- **当一个轮次完成时**，IDE 会保存该轮次的提示词和回复。只有提示词与回复均非空的已完成轮次才会被保存。Cursor CLI 则有所不同：它会在每次 stop 时以及对话结束时读取对话转录。
- **随后**，当对话结束或静默达到 30 分钟时（以先发生者为准），后台 worker 会保存该对话的所有轮次。未关闭的聊天不会立即被召回到其他聊天中。

hook 永远不会阻塞 Cursor。若某个 hook 失败或收到无法读取的输入，它会向 Cursor 返回空响应，对话继续进行，仅该步骤缺少记忆支持；具体原因会写入该 hook 的错误输出中。

## 关闭部分功能

`settings.json`（位于 `~/.sno`，或设置了 `SNO_PROFILE_DIR` 时位于该目录下）中的两项配置控制自动部分。显式的 `sno memory remember` 和 `sno memory recall` 无论如何均正常工作。

| 配置项 | 为 `false` 时的效果 |
| --- | --- |
| `recall.auto` | 开始时没有简报，提示词中也不追加记忆 |
| `capture.ambient` | 不记录对话轮次（IDE 将每个跳过的轮次记录为 `capture-off`） |

## 初次设置验收清单

当满足以下条件时，初次设置即告完成：

- 已执行 `cursor-agent login`；
- `sno setup --harness cursor` 无错误执行完毕，且未提示跳过 Cursor；
- 在新对话后，`doctor` 打印 `healthy`，六个 hook 均为 `present`，且两条权限规则均为 `present`；
- 用户可以创建第一条记忆并通过 `recall` 再次找到它；
- 其他工具写入 `hooks.json` 的条目未受影响；
- 输出中不包含任何密钥、私有主机名、内部路径或部署说明。
