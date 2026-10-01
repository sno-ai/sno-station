# Sno Memory for OpenClaw — 初次设置

这份说明描述 `@snoai/mem-claw` 的公开安装与首次设置流程。

## 开始设置

要求：

- PATH 上有 OpenClaw
- Node.js：22 系列需 22.22.3 及以上，24 系列需 24.15.0 及以上，或 25.9.0 及以上

推荐使用引导式安装器：

```bash
npx @snoai/mem-claw
```

也可以先通过 OpenClaw 安装，再打开同一个设置向导：

```bash
openclaw plugins install @snoai/mem-claw
npx @snoai/mem-claw --configure
```

npm 上发布的 package 是公开安装源。用户不需要源码 checkout、私有服务器或手工复制的
plugin 目录。

安装器只是在 `openclaw plugins install` 之上做加法：plugin 尚未安装时它会以子进程调用该命令，
之后只把用户选中的设置写进 OpenClaw 配置。

## 第一步：选 memory mode

向导先问 memory profile 和 embedder preset，再问 memory mode。provider 和 key 只在选定
mode 之后、且该 mode 需要时才会问。

默认 mode 是 Agent Native。

### Local First

Local First 适合完全本地运行：

- 规则式、原文式 capture；
- content hash 去重；
- 确定性的 profile merge 与 task 处理；
- 不生成由模型撰写的 reflection summary；
- 不需要 LLM credential。

默认 embedder 在本地运行。第一次使用时可能需要下载模型，缓存完成后不再依赖远程服务。

### Agent Native

Agent Native 使用 OpenClaw agent 自己的 model，内联处理 memory write。

设置时不收任何 key：Agent Native 一律借用 host agent 自己的模型。它只跑 extraction；
模型撰写的 reflection summary（LLM mode `extraction+reflection`）只在 REM Enhanced 下提供。

找到可用的 model access 后 Agent Native 立即启用，模型调用内联执行。

### REM Enhanced

REM Enhanced 让 Sno GPU 负责 LoRA 覆盖的 extraction 与 conflict call，其余需要模型
判断的 memory write 由 host agent model 处理。向导会问一个可选的 Sno base URL（留空用默认）
和必需的 Sno key；host model 调用沿用 agent 自己的 model 配置。

## 第二步：确认其他默认值

向导接着问 recall 深度（Default 或 Lean），以及在 OpenClaw memory slot 为空时是否
把本 plugin 放进去。

标准默认值如下：

| Setting | Default |
| --- | --- |
| Memory mode | Agent Native |
| Memory profile | `local-active`（主动 capture 与 recall） |
| Embedder | Local |
| Reranking | 本地轻量处理 |
| Recall depth | Default（Lean 便宜约 25%，分数低几个点） |
| Session handling | 本地 system session memory |
| Management tools | 关闭 |
| Cloud observability | 默认关闭，除非用户主动启用 |

每个模式的默认 routing 如下：

| Memory-writing call | Local First | Agent Native | REM Enhanced |
| --- | --- | --- | --- |
| Capture memories | 规则式、原文式 | Host model | Sno extraction model |
| Classify active tasks | Keyword rules | Host model | Host model |
| Merge profile sections | Deterministic merge | Host model | Host model |
| Match completed tasks | Token overlap | Host model | Host model |
| Resolve conflicts | 两条都保留 | Host model | Sno conflict model |
| Build reflection summary | 不生成 model reflection；仍保留 local session memory | 同 Local First | Host model |
| Resolve relative dates | 不调用模型 | Host model | Host model |

Agent Native 与 REM Enhanced 不会把任何 memory-writing call 永久关掉。单次 model
request 失败时，只对该次请求使用对应的 Local First 行为，不会偷偷切到另一个 model tier。

REM Enhanced 的模型调用目标由所选模式决定，不能按用途单独修改。

两个 REM operation 会按周期触发在整个 store 上运行，模型调用目标由所选模式决定：

- `rem-update`：把过程叙述改写成干净的当前态 memory，同时保留历史；
- `rem-replace`：在整个 store 上裁决矛盾，把落败的 memory 可逆地软关闭。

安装器默认两个都请求；只要其中一个时用 `--rem-operations rem-update` 或
`--rem-operations rem-replace`，把 `remEnhanced.trigger.tick` 设为 `false` 可关掉触发。这个设置只在第一次建立记忆存储时读取一次。

Mode selection 不承诺最终 retrieval 或 reranker 行为。

## 第三步：完成设置并重启

完成信息会写明：

- 选中的 memory profile、embedder、LLM mode；
- plugin 是否已分配到 OpenClaw memory slot；
- 该 mode 需要的环境变量，没有则写 `none`；
- 重启 OpenClaw gateway 的确切命令；
- 怎样重新运行设置。

向导收到的 key 会写进 plugin 的 onboarding env 文件（权限 0600）和 gateway 的 systemd user
drop-in；输入过程不回显。

重启后运行：

```text
/memory status
```

状态会显示 memory 数量、store 路径和 sidecar 进程 id。需要查看保存的 setup 时运行：

```bash
npx @snoai/mem-claw --status
```

## 第四步：建立第一条有用 memory

优先保存每天都会有帮助的信息：

- 回复语言与语气；
- coding 与 review 偏好；
- 项目规则；
- package manager 规则；
- 常用工具或命令；
- agent 不应该重复做的动作。

例如：

```text
Remember that I prefer concise replies and tabs for indentation.
```

然后验证：

```text
/memory stats
```

不要把临时 debug 状态、测试输出或私有基础设施细节当作第一批 memory。

## 非交互式安装

Package manager 或自动化 OpenClaw 安装可能没有交互式 terminal。非交互式安装使用公开默认值
并输出简短 handoff，最终状态与直接 `openclaw plugins install` 再重启完全相同。它会提醒用户
之后运行：

```bash
npx @snoai/mem-claw --configure
```

它不猜 credential、不打印 secret，也不暴露私有 endpoint。

## 已经安装

再次运行安装器不会覆盖已完成的设置；默认只显示状态。需要修改时明确运行：

```bash
npx @snoai/mem-claw --status
npx @snoai/mem-claw --configure
```

再次 `--configure` 不会重复索要上一次已经保存的 key。

正常 reinstall 会保留 memory library。

## 验收清单

以下条件全部满足，onboarding 才算完成：

- 先选 mode，再问 provider 细节；
- Local First 无需 LLM credential 即可完成；
- Agent Native 借用 host agent 的模型，不询问任何 key；
- REM Enhanced 用公开语言说明 Sno 与 host model 各自负责的工作；
- 完成信息写明重启命令和所需环境变量；
- 重启后 `/memory status` 可用，安装器 status 能读到保存的 setup；
- 用户能创建并验证第一条 memory；
- handoff 中没有 secret、私有 hostname、内部路径或部署说明。
