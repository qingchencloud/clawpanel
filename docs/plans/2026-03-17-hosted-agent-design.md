# 托管 Agent（聊天页）详细设计

> 结论：采用方案一（复用晴辰助手能力）。

## 目标
- 聊天页发送按钮右侧新增“托管 Agent”入口
- 托管 Agent 通过 WSS 自动与当前会话 Agent 交互
- 上下文仅包含：初始提示词 + 与对面 Agent 的交流
- 继承当前会话工具权限
- 全局默认 + 会话级启用，切换会话/页面仍生效
- 输出直接插入当前聊天流并标记来源

## 入口与 UI 交互
### 入口按钮
- 位置：`src/pages/chat.js` 内聊天输入区域，发送按钮右侧
- 交互：点击打开托管 Agent 配置面板
- 状态：idle / running / waiting_reply / paused / error

### 配置面板
- 初始提示词（必填）
- 启用开关
- 运行模式：对面 Agent 回复后自动继续
- 停止策略：托管 Agent 自评停止
- 高级选项：最大步数 / 步间隔 / 重试次数
- 操作：保存并启用 / 暂停 / 立即停止

### 输出展示
- 直接插入当前聊天流
- 格式示例：
  - `[托管 Agent] 下一步指令: ...`
- 样式区分：弱化颜色 + 标签

## 运行循环与状态机
### 状态
- idle / running / waiting_reply / paused / error

### 触发
- 监听 `wsClient.onEvent`
- event=chat，state=final，sessionKey=当前会话

### 执行流程
1. 对面 Agent final 回复到达
2. 托管 Agent 生成下一步指令
3. 使用 `wsClient.chatSend` 发送
4. 进入 waiting_reply
5. 满足 stopPolicy 或 maxSteps 停止

## 上下文构建
- 仅包含：初始提示词 + 与对面 Agent 对话
- 截断策略：按 MAX_CONTEXT_TOKENS 或最近 N 条
- 不引入其他会话内容

## 数据结构与持久化
### 全局默认（clawpanel.json）
```json
{
  "hostedAgent": {
    "default": {
      "enabled": false,
      "prompt": "",
      "autoRunAfterTarget": true,
      "stopPolicy": "self",
      "maxSteps": 50,
      "stepDelayMs": 1200,
      "retryLimit": 2,
      "toolPolicy": "inherit"
    }
  }
}
```

### 会话级（localStorage）
Key: `clawpanel-hosted-agent-sessions`
```json
{
  "agent:main:main": {
    "enabled": true,
    "prompt": "任务目标",
    "autoRunAfterTarget": true,
    "stopPolicy": "self",
    "maxSteps": 50,
    "stepDelayMs": 1200,
    "retryLimit": 2,
    "toolPolicy": "inherit",
    "state": {
      "status": "running",
      "stepCount": 12,
      "lastRunAt": 1710000000000,
      "lastError": ""
    },
    "history": [
      { "role": "system", "content": "初始提示词" },
      { "role": "assistant", "content": "托管 Agent 生成的指令" },
      { "role": "target", "content": "对面 Agent 回复" }
    ]
  }
}
```

## assistant-core 抽取清单
新增：`src/lib/assistant-core.js`

### 抽取项（从 assistant.js）
- API 适配：OpenAI/Anthropic/Gemini
- SSE 流解析与重试
- 系统提示词构建
- 工具声明、权限过滤、执行与安全检查
- 上下文裁剪与会话数据工具

### 适配器注入
- `api.*` 工具桥接
- `confirm / ask_user` UI 适配器
- `storage` 适配器
- 图片存储适配器

### 保留在 assistant.js
- DOM 渲染与 UI 交互
- toast/modal
- 视图与事件绑定

## 风险与保护
- Gateway 断开：自动暂停
- 连续失败：触发 error 状态
- 最大步数：强制停止
- 避免重复触发：运行中忽略新触发

## 测试要点
- 启用后自动发送
- 对面回复后自动继续
- 切换会话/页面后仍生效
- 停止策略与最大步数生效
