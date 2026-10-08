# Sno Memory for OpenClaw — 初次设置

这份说明描述 `@snoai/mem-claw` 的首次设置流程。

## 第一步：设置共享的 memory 服务

要求：

- PATH 上有 OpenClaw
- Node.js：22 系列需 22.22.3 及以上，24 系列需 24.15.0 及以上，或 25.9.0 及以上

先按[共享 memory 设置](../../memory-setup.md)做一次。它会以 Local First 模式写入 `~/.sno/settings.json`，并下载 embedding 模型。已经有 memory 库时，不要重新运行其中写设置的那一段：它会换掉加密密钥，旧的 memory 就读不出来了。

## 第二步：安装插件

```bash
openclaw plugins install @snoai/mem-claw@1.2.3
```

`npx @snoai/mem-claw` 做的是同一次安装，它只有一个选项 `--profile <name>`，会原样传给 OpenClaw。插件会按共享设置记录的路径启动 memory 服务，没有单独的启动命令。

## 第三步：重启 OpenClaw 并检查

重启 OpenClaw 后运行：

```text
/memory status
```

状态会显示 memory 数量、存储路径和 sidecar 进程 id。

## 第四步：建立第一条有用的 memory

先写下每天都会用到的信息：

- 偏好的语言和语气；
- 编码和审查偏好；
- 项目规则；
- 包管理器规则；
- 常用的工具或命令；
- 不希望 agent 重复做的事。

例如：

```text
记住：我喜欢简洁的回复，缩进用 tab。
```

然后验证：

```text
/memory stats
```

不要把临时调试状态、测试输出或私有基础设施信息当作第一批 memory。

## 之后修改设置

所有插件读取同一个 `~/.sno/settings.json`。编辑它，保留原有的 `store.encryptionKey`，然后重启 OpenClaw。再次安装插件不会清除 memory 库。
