# ClawPanel 文档导航

ClawPanel 提供桌面端和 Web 端，统一管理 OpenClaw、Hermes Agent、DeepSeek Harness、OpenCode，以及实验版 Pi。引擎独立安装，切换引擎不等于迁移会话、记忆或工具权限。

## 第一次使用

1. 从 [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest) 下载桌面安装包，或按下方部署指南安装 Web 服务。
2. 在左侧选择引擎，完成该引擎的环境检测和安装。
3. 在「通用 → 模型渠道」保存地址、密钥和模型，**显式同步**到所选引擎。
4. 进入引擎自己的聊天页或工作台，验证一次完整对话；配置回读成功与真实模型调用成功是两项检查。

## 使用与部署

| 你要做什么 | 文档 |
|---|---|
| 了解各引擎差异、首次配置模型、排查同步问题 | [多引擎与模型渠道](engines-and-models.md) |
| 安装和使用 Pi，了解工具审批与实验版边界 | [Pi 使用指南](pi-integration.md) / [English](pi-integration.en.md) |
| 查看 Pi 与 OpenClaw 操控对标的已实现项和缺口 | [Pi 对标复查](pi-openclaw-parity-review.md) |
| 使用 Hermes 会话、记忆及渠道管理 | [Hermes Agent 图文指南](hermes-agent.md) |
| 安装、更新和卸载 OpenCode，进入内嵌工作台 | [OpenCode 使用指南](opencode.md) |
| 在无桌面的 Linux 服务器部署 | [Linux 部署](linux-deploy.md) |
| 使用仓库 Dockerfile / Compose，持久化和升级 | [Docker 部署](docker-deploy.md) |
| 在 ARM64 板子部署 Web 端 | [Armbian / ARM 部署](armbian-deploy.md) |
| 配置钉钉消息渠道 | [钉钉接入](dingtalk-integration.md) |

## 维护与反馈

- [项目介绍与常见问题](https://github.com/qingchencloud/clawpanel/blob/main/README.md)
- [贡献、测试与发版流程](https://github.com/qingchencloud/clawpanel/blob/main/CONTRIBUTING.md)
- [安全政策](https://github.com/qingchencloud/clawpanel/blob/main/SECURITY.md)
- [更新日志](https://github.com/qingchencloud/clawpanel/blob/main/CHANGELOG.md)
- [提交问题](https://github.com/qingchencloud/clawpanel/issues)：注明面板版本、引擎版本、桌面/Web、操作系统、具体页面和脱敏错误日志。

带日期的兼容性记录描述当时的验收结果，不代表任意未来上游版本都已兼容。推荐版本以该面板版本附带的策略及配置页为准。
