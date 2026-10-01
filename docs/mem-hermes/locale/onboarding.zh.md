# Hermes Agent 的 Sno Memory — 初次设置

Hermes 使用 Python 插件连接 Sno 的共用记忆服务；记忆服务本身由 npm 安装。首发安装不需要
Sno CLI。

## 安装

先准备 Hermes Agent、Git，以及 Node.js 22.22.3+、24.15.0+ 或 25.9.0+（分别对应
22、24、25 系列）。完成[共用记忆服务安装](../../memory-setup.md)，它会安装记忆服务，并在
`~/.sno/settings.json` 写入本地记忆库设置和加密密钥。

然后安装 Hermes 插件并选用它：

```bash
hermes plugins install sno-ai/sno-station/apps/mem-hermes/sno-mem-hermes --enable
hermes config set memory.provider sno-mem-hermes
```

Python 插件来自本仓库，不需要另发一个 Python 包。共用安装步骤会准备它使用的 npm 记忆
服务和本地模型。首发选择 Local First 模式，不需要模型 API 密钥。

请私下备份 `~/.sno/settings.json` 和记忆库。已有记忆库时不要重跑共用设置中的生成配置
步骤；新密钥无法读取旧记忆。

## 确认安装

```bash
hermes plugins list
hermes plugins doctor sno-mem-hermes --ci
hermes config get memory.provider
```

插件应显示为启用，检查命令不报错，选用的提供者应是 `sno-mem-hermes`。在一个项目目录里
打开 Hermes，叫它记住一条简单的项目事实。结束会话后，在同一目录开新会话，请它说出那条
事实。记忆服务会在插件需要时自行启动，不用另开一个服务命令。

如果你已有记忆库，只安装插件，不要替换现有的 `settings.json`、记忆库路径或加密密钥。
`SNO_PROFILE_DIR` 可指定另一份配置。更新或卸载插件不会删除已存的记忆。

四个记忆工具和日常行为见[英文使用说明](../usage-guide.md)。上面的公开 Git 安装命令须在
源码上传 GitHub 后再验证；此前的干净机器测试是从本地源码安装同一个插件。
