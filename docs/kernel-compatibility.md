# 内核兼容复核

复核日期：2026-11-17。这里把“已适配”定义为：面板固定版本、协议/配置适配代码和本仓库验收证据一致。上游有新版本不自动视为已适配。

| 内核 | 面板固定版本 | 上游当前版本 | 结论 |
|---|---|---|---|
| OpenClaw 官方 | 2026.11.4 | 2026.11.4 | 已补新版 operator 握手：优先 v4，协议拒绝时回退 3..4；当前机器 Node.js 24.15.0 低于该版本要求的 24.16.0，未在本机完成安装验收 |
| OpenClaw 汉化 | 2026.11.4-zh.2 | 2026.11.4-zh.2 | 与官方同一 Node.js 要求；微信原生资格仍固定使用单独验收过的 2026.10.4 宿主 |
| DeepSeek Harness | 0.2.2-rc.1（预览 0.2.1-alpha.4） | 0.2.2-rc.1 | 已完成版本回读和 Web 启动隔离 smoke；Node.js 要求已收紧为 >=24.9.0 |
| OpenCode | 1.19.2 | 1.19.5 | 配置转换和代理契约已覆盖；1.19.5 Windows x64 与 baseline 包在同一机器独立 preflight 均返回 EFTYPE，确认是上游原生包回归，暂不晋级 |
| Pi | 1.5.2 | 1.5.2 | 已完成隔离运行时的流式聊天、模型切换、审批、取消、历史恢复和项目隔离验收 |
| Hermes Agent | 0.21.5（v2026.9.24） | 同一源码 tag | 当前固定 pin 与上游源码 tag 一致，无待升级版本 |

因此，按受管运行时族计，当前仍有 **1 个版本族因上游阻断而未晋级**（OpenCode 1.19.5）；OpenClaw 官方/汉化已切换到 2026.11.4 发布线，DSH 已切换到 0.2.2-rc.1，Pi 已完成 1.5.2 适配，Hermes 没有版本漂移。当前已落地的代码适配是 OpenClaw v4/v3 自适应握手、DSH 0.2.2 的 Node.js/LLM 依赖路径适配、Pi 1.5.2 RPC 验收和 Windows PowerShell 5 UTF-8 BOM 兼容。

版本核对命令：

```text
npm view openclaw version
npm view @qingchencloud/openclaw-zh version
npm view @deepseek-ai/dsh version
npm view opencode-ai version
npm view @earendil-works/pi-coding-agent version
```
