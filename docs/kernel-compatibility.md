# 内核兼容复核

复核日期：2026-11-18。这里把“已适配”定义为：面板固定版本、协议/配置适配代码和本仓库验收证据一致。上游有新版本不自动视为已适配。

| 内核 | 面板固定版本 | 上游当前版本 | 结论 |
|---|---|---|---|
| OpenClaw 官方 | 2026.11.5 | 2026.11.5 | Linux x64、Node 24.16.0：精确 npm 包安装、面板写配置、Gateway 启动、配对握手、首聊和历史回读、停止均通过。聊天服务仍在启动时，只按明确拒绝回执重试同一幂等请求 |
| OpenClaw 汉化 | 2026.11.5-zh.1 | 2026.11.5-zh.1 | 独立安装汉化包，核对包版本和 CLI 的上游内核版本。Linux x64 生产 Web API 完成配对、首聊、历史和停止。面板直接启动汉化 Gateway 时，从已选包根目录加载随包模板 |
| DeepSeek Harness | 0.2.2-rc.1（预览 0.2.1-alpha.4） | 0.2.2-rc.1 | Windows x64、Node 24.22.1 的生产 Web API 通过全部 11 个阶段，覆盖安装、模型同步、会话、历史和进程回收。Chromium 148 从面板内嵌工作台输入消息、点击发送，页面显示了回环模型的完整回复 |
| OpenCode | 1.19.6 | 1.19.6 | Windows x64、Linux x64 生产 Web API 均通过受管安装、工作台、同步模型、会话完整回复与停止；Windows x64 与 baseline 两种原生包独立回读版本成功 |
| Pi | 1.5.2 | 1.5.2 | Windows x64 生产 Web API 通过受管安装、模型同步、RPC、回复与进程清理。Windows Tauri 工作台两次通过新建会话、切换模型、发送与分段显示回复、刷新恢复。回环模型每次均只收到一条发给所选模型的请求 |
| Hermes Agent | 0.21.5（v2026.9.24） | v0.23.2 | 固定版在 Linux x64、Node 24.16 的隔离环境通过安装、版本校验、配置、会话回复和退出清理。新版 Windows 与 Linux 安装器分别拒绝面板传入的 `-ForceCommit` 和 `--force-commit`，Windows 安装阶段也已改变，维持现有推荐版本 |

上述聊天验收使用真实引擎和本地模拟模型服务。桌面系统服务仍需按操作系统验收。微信原生资格仍固定在 2026.10.4 宿主，详见 [微信原生验收脚本](../scripts/test-weixin-windows-qualification.mjs)。Pi 的 Windows 桌面工作台已验证，桌面安装升级、审批与取消操作、其他系统真机和第三方模型联调范围见 [Pi 集成说明](pi-integration.md)。

Linux amd64 发行镜像已验证微信渠道插件安装。面板在 OpenClaw 2026.11.5 上安装已核实的 npm 包 `@tencent-weixin/openclaw-weixin@2.4.9`，回读版本、启用和允许状态，CLI 插件清单显示 `loaded` 并注册了 `openclaw-weixin` 渠道。新版 2.4.10、扫码登录与真实账号收发仍需单独验收。

版本核对命令：

```text
npm view openclaw version
npm view @qingchencloud/openclaw-zh version
npm view @deepseek-ai/dsh version
npm view opencode-ai version
npm view @earendil-works/pi-coding-agent version
```
