# 内核兼容复核

复核日期：2026-11-18。这里把“已适配”定义为：面板固定版本、协议/配置适配代码和本仓库验收证据一致。上游有新版本不自动视为已适配。

| 内核 | 面板固定版本 | 上游当前版本 | 结论 |
|---|---|---|---|
| OpenClaw 官方 | 2026.11.5 | 2026.11.5 | Linux x64、Node 24.16.0：精确 npm 包安装、面板写配置、Gateway 启动、配对握手、首聊和历史回读、停止均通过。聊天服务仍在启动时，只按明确拒绝回执重试同一幂等请求 |
| OpenClaw 汉化 | 2026.11.5-zh.1 | 2026.11.5-zh.1 | 独立安装汉化包，核对包版本和 CLI 的上游内核版本。Linux x64 生产 Web API 完成配对、首聊、历史和停止。面板直接启动汉化 Gateway 时，从已选包根目录加载随包模板 |
| DeepSeek Harness | 0.2.2-rc.1（预览 0.2.1-alpha.4） | 0.2.2-rc.1 | Windows x64、Node 24.22.1 的生产 Web API 通过全部 11 个阶段：全新受管安装、同步模型、启动工作台、真实 DSH 会话从回环模拟模型取得完整回复、回读历史、停止并回收进程 |
| OpenCode | 1.19.6 | 1.19.6 | Windows x64、Linux x64 生产 Web API 均通过受管安装、工作台、同步模型、会话完整回复与停止；Windows x64 与 baseline 两种原生包独立回读版本成功 |
| Pi | 1.5.2 | 1.5.2 | Windows x64 生产 Web API 已完成受管安装、模型同步、真实 Pi RPC、回环模型回复、会话与进程清理；另有流式聊天、切换、审批和历史恢复验收 |
| Hermes Agent | 0.21.5（v2026.9.24） | v0.23.2 | 固定版在 Linux x64、Node 24.16 的隔离环境通过安装、版本校验、配置、会话回复和退出清理。新版 Windows 与 Linux 安装器分别拒绝面板传入的 `-ForceCommit` 和 `--force-commit`，Windows 安装阶段也已改变，维持现有推荐版本 |

上述聊天验收使用真实引擎和本地模拟模型服务。桌面系统服务仍需按操作系统验收；微信原生资格仍固定在 2026.10.4 宿主，详见 [微信原生验收脚本](../scripts/test-weixin-windows-qualification.mjs)。Pi 的桌面 GUI、第三方模型与真机范围见 [Pi 集成说明](pi-integration.md)。

版本核对命令：

```text
npm view openclaw version
npm view @qingchencloud/openclaw-zh version
npm view @deepseek-ai/dsh version
npm view opencode-ai version
npm view @earendil-works/pi-coding-agent version
```
