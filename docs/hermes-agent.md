# Hermes Agent 图文指南

Hermes Agent 是 ClawPanel 支持的第二个 AI Agent 引擎。它把会话、长期记忆、人格档案、工具调用和消息渠道放在同一个管理面板中，让 Agent 从一次性的聊天窗口，升级为可以持续运营和沉淀上下文的智能体系统。

## 核心价值

- **长期记忆可视化**：通过 Notes、User Profile、Soul 三份 Markdown 文件沉淀事实、偏好和人格。
- **会话可运营**：统一查看会话、消息流、运行状态和工具调用细节。
- **人格可维护**：把 Agent 的表达风格、价值观、用户偏好固化为可编辑资产。
- **渠道可扩展**：面向 QQ、Telegram、Discord 等外部渠道，集中管理连接能力。

## 界面预览

### Hermes Agent 控制台

![Hermes Agent 控制台](./h00.png)

控制台用于查看 Hermes Agent 的整体运行状态、入口能力和主要管理模块，适合作为日常运营的第一屏。

### Agent 长期记忆

![Hermes Agent 长期记忆](./h01.png)

Agent 记忆页围绕三类长期上下文组织：笔记记录事实，用户画像记录偏好，灵魂档案塑造人格。所有内容都以 Markdown 形式保存，便于审计、迁移和版本管理。

### 会话与消息流

![Hermes Agent 会话与消息流](./h02.png)

会话视图用于追踪 Agent 与用户之间的对话过程，帮助你观察消息上下文、响应质量和实际运行表现。

### 工具与运行细节

![Hermes Agent 工具与运行细节](./h03.png)

工具与运行细节用于定位 Agent 执行过程中的关键动作，适合排查问题、优化提示词和调整工具权限。

## 推荐使用流程

1. **先完成模型与 Gateway 配置**：确保 Hermes Agent 可以正常连接模型服务。
2. **初始化长期记忆**：在 Agent 记忆页补充 Notes、User Profile 和 Soul。
3. **进入会话验证效果**：通过对话确认人格、偏好和上下文是否按预期生效。
4. **接入消息渠道**：根据实际场景接入 QQ、Telegram、Discord 等外部渠道。
5. **持续迭代记忆资产**：把真实使用中沉淀下来的事实、偏好和规则整理回长期记忆。

## 可选：通过 MCP 接入 Parallel 搜索与网页提取

Hermes 的「运行与配置 → MCP 服务」支持 HTTP 服务。可添加 [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)，提供 `web_search` 搜索和 `web_fetch` 网页提取。匿名端点无需 Parallel 账号或 API Key，搜索使用 Fast 模式，适合轻量使用；免费服务有速率限制。

1. 在 ClawPanel 左侧选择 **Hermes Agent**，先按「运行与配置」页面完成引擎安装。
2. 打开该页面的 **MCP 服务**，在 `mcp_servers JSON 映射` 中合并下方 `parallel` 条目。如果已有其他服务，保留原条目，不要用示例覆盖整个映射。这里只填写服务映射，不要再包一层 `mcp_servers` 或 `mcpServers`。
3. 点击 **保存 MCP 服务**，重启 Hermes Gateway，让新会话加载工具。该配置只增加 MCP 服务，不切换模型渠道或原生 Web 搜索后端。模型渠道仍需按原流程配置。

可直接复制 [JSON 示例](examples/hermes-parallel-mcp.json)：

```json
{
  "parallel": {
    "url": "https://search.parallel.ai/mcp",
    "headers": {
      "User-Agent": "ClawPanel/0.22.1"
    },
    "connect_timeout": 30,
    "timeout": 60
  }
}
```

配置会写入当前 Hermes 的 `config.yaml`（默认 `~/.hermes/config.yaml`），连接超时和工具调用超时单位均为秒。无需添加 `Authorization`、`PARALLEL_API_KEY` 或 stdio 的 `command` / `args`，也无需额外安装搜索插件。

在安装 Hermes 的主机上运行 `hermes mcp test parallel` 可检查连接与工具发现；应能看到 `web_search` 和 `web_fetch`。这项检查只确认连接，不代表模型已完成一次工具调用。若工具未出现，检查 HTTP MCP 依赖是否已随引擎安装、服务是否启用，以及当前会话的工具集是否允许 `parallel`。收到限流响应时按服务返回的重试时间稍后再试，不要连续重启重试。

要停用时，仅从映射中移除 `parallel` 条目，保存并重启 Gateway，保留其他 MCP 服务。

## 与 OpenClaw 的关系

ClawPanel 采用多引擎架构：OpenClaw 适合已有 OpenClaw 生态用户的 Agent 管理和 Gateway 运维；Hermes Agent 则强化会话、记忆、人格和工具执行的长期运营体验。两者可以在同一个面板中统一管理。
