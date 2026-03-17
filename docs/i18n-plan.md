# ClawPanel i18n 国际化方案

> 本文档是 ClawPanel 多语言国际化的完整技术方案和实施指南。
> 任何后续会话开始 i18n 工作时，请先阅读本文档。

## 一、现状评估

- **硬编码中文行数**：3508 行（分布在 25+ 个 JS 文件中）
- **预估翻译字符串数**：约 1500+ 个
- **技术栈**：纯 Vanilla JS（无 React/Vue），Tauri v2 桌面应用
- **当前语言**：仅中文

### 文件中文行数分布（Top 15）

| 行数 | 文件 | 模块 |
|------|------|------|
| 838 | assistant.js | AI 助手（含内嵌知识库） |
| 312 | docker.js | Docker 集群管理 |
| 243 | models.js | 模型配置 |
| 183 | chat.js | 实时聊天 |
| 156 | chat-debug.js | 系统诊断 |
| 148 | openclaw-kb.js | 知识库文本 |
| 142 | setup.js | 初始安装引导 |
| 136 | channels.js | 消息渠道 |
| 136 | main.js | 主入口/路由/横幅 |
| 120 | services.js | 服务管理 |
| 105 | about.js | 关于页面 |
| 93 | cron.js | 定时任务 |
| 88 | dashboard.js | 仪表盘 |
| 72 | extensions.js | 扩展工具 |
| 68 | gateway.js | 网关配置 |

## 二、技术架构

### 核心模块：`src/lib/i18n.js`

```js
// 使用方式
import { t, setLocale, getLocale } from '../lib/i18n.js'

// 简单翻译
t('common.save')           // → "保存" / "Save"
t('common.cancel')         // → "取消" / "Cancel"

// 带参数插值
t('chat.messageCount', { count: 5 })  // → "5 条消息" / "5 messages"

// 嵌套 key
t('dashboard.gateway.running')  // → "运行中" / "Running"

// 切换语言
setLocale('en')  // 存 localStorage，触发页面重渲染
```

### 语言检测优先级

1. `localStorage` 中存储的用户选择 (`clawpanel-locale`)
2. 浏览器 `navigator.language`（`zh-CN` → `zh-CN`，`en-US` → `en`）
3. 默认值：`zh-CN`

### 缺失翻译 fallback

1. 查找当前语言包
2. 查找 `zh-CN` 兜底（中文作为最完整的语言）
3. 返回 key 本身（如 `common.save`）
4. 开发模式下 console.warn 提示缺失翻译

## 三、语言包结构

```
src/locales/
  zh-CN.json    — 中文简体（默认，最完整）
  en.json       — English
  zh-TW.json    — 中文繁体（未来）
  ja.json       — 日本語（未来）
  ko.json       — 한국어（未来）
```

### JSON 格式规范

按模块/页面分组，使用扁平化嵌套结构：

```json
{
  "common": {
    "save": "保存",
    "cancel": "取消",
    "delete": "删除",
    "confirm": "确定",
    "close": "关闭",
    "loading": "加载中...",
    "error": "错误",
    "success": "成功",
    "warning": "警告",
    "retry": "重试",
    "refresh": "刷新",
    "edit": "编辑",
    "create": "创建",
    "back": "返回",
    "next": "下一步",
    "search": "搜索",
    "copy": "复制",
    "download": "下载",
    "upload": "上传",
    "enable": "启用",
    "disable": "禁用",
    "start": "启动",
    "stop": "停止",
    "restart": "重启",
    "status": "状态",
    "running": "运行中",
    "stopped": "已停止",
    "unknown": "未知",
    "noData": "暂无数据",
    "operationFailed": "操作失败: {error}",
    "confirmDelete": "确定删除 {name}？",
    "savedSuccessfully": "已保存"
  },
  "sidebar": {
    "dashboard": "仪表盘",
    "assistant": "晴辰助手",
    "chat": "实时聊天",
    "services": "服务管理",
    "logs": "日志查看",
    "models": "模型配置",
    "agents": "Agent 管理",
    "memory": "记忆文件",
    "channels": "消息渠道",
    "gateway": "网关配置",
    "skills": "Skills 工具",
    "docker": "Docker 集群",
    "cron": "定时任务",
    "extensions": "扩展工具",
    "about": "关于",
    "setup": "初始设置",
    "chatDebug": "系统诊断"
  },
  "dashboard": { ... },
  "chat": { ... },
  "models": { ... },
  ...
}
```

## 四、迁移步骤（每个页面）

### Step 1: 提取中文字符串

使用正则或手动扫描，将所有中文文本提取到对应的语言包 key 下。

**需要翻译的内容**：
- UI 文本（按钮文字、标题、描述、提示）
- toast 消息
- 错误消息
- placeholder 文本
- confirm 对话框文本
- tooltip 文本

**不需要翻译的内容**：
- 代码注释（保持中文）
- console.log 调试信息
- 技术标识符（如 `Gateway`、`Agent`、`OpenClaw`）
- API 错误消息（后端返回的）
- 知识库内容 `openclaw-kb.js`（这个特殊处理，按语言版本分文件）

### Step 2: 替换代码中的硬编码

```js
// Before
toast('保存成功', 'success')

// After
toast(t('common.savedSuccessfully'), 'success')
```

```js
// Before (HTML 模板)
`<button class="btn">${icon('save', 14)} 保存</button>`

// After
`<button class="btn">${icon('save', 14)} ${t('common.save')}</button>`
```

### Step 3: 编写英文翻译

逐 key 翻译到 `en.json`。

### Step 4: 测试

切换语言，检查每个页面的显示是否正常。

## 五、迁移顺序

### 第一批（基础 + 框架层，约 80 个字符串）
1. `src/lib/i18n.js` — 创建核心模块
2. `src/locales/zh-CN.json` — 初始化中文包
3. `src/locales/en.json` — 初始化英文包
4. `src/components/sidebar.js` — 导航菜单（~20 个）
5. `src/components/modal.js` — 公共弹窗（~10 个）
6. `src/components/toast.js` — 提示组件
7. `src/pages/about.js` — 关于页面 + 语言切换 UI（~30 个）

### 第二批（核心页面，约 250 个字符串）
8. `src/pages/dashboard.js` — 仪表盘（~50 个）
9. `src/pages/setup.js` — 初始设置（~80 个）
10. `src/pages/chat.js` — 实时聊天（~100 个）
11. `src/main.js` — 主入口/横幅（~20 个）

### 第三批（配置页面，约 350 个字符串）
12. `src/pages/models.js` — 模型配置（~120 个）
13. `src/pages/channels.js` — 消息渠道（~80 个）
14. `src/pages/services.js` — 服务管理（~70 个）
15. `src/pages/gateway.js` — 网关配置（~40 个）
16. `src/pages/agents.js` — Agent 管理（~40 个）

### 第四批（功能页面，约 250 个字符串）
17. `src/pages/cron.js` — 定时任务（~50 个）
18. `src/pages/memory.js` — 记忆管理（~30 个）
19. `src/pages/extensions.js` — 扩展工具（~40 个）
20. `src/pages/logs.js` — 日志查看（~20 个）
21. `src/pages/skills.js` — Skills 工具（~60 个）
22. `src/pages/chat-debug.js` — 系统诊断（~50 个）

### 第五批（大型页面 + 特殊处理，约 600 个字符串）
23. `src/pages/docker.js` — Docker 管理（~150 个）
24. `src/pages/assistant.js` — AI 助手（~400 个，含系统提示词）
25. `src/lib/openclaw-kb.js` — 知识库（按语言分文件）
26. `src/lib/error-diagnosis.js` — 错误诊断（~30 个）
27. `src/components/engagement.js` — 推荐弹窗（~15 个）

### 第六批（官网 + 文档）
28. `docs/index.html` — 官网英文版
29. `README.md` → `README_en.md`
30. `CONTRIBUTING.md` → `CONTRIBUTING_en.md`

## 六、语言切换 UI 设计

### 位置
1. **关于页面底部** — 语言选择下拉框
2. **侧边栏底部** — 语言图标 + 当前语言缩写（如 `中` / `EN`）

### 交互
- 选择语言 → 存入 localStorage → 页面自动刷新
- 首次访问自动检测浏览器语言

## 七、注意事项

### 技术品牌词不翻译
以下词保持原样，不翻译：
- `OpenClaw`
- `ClawPanel`
- `Gateway`
- `Agent`（Agent 管理不翻译为"代理"）
- `MCP`
- `Skills`
- `Docker`
- `Tauri`

### 参数插值语法
使用 `{param}` 语法：
```json
{
  "chat.sessions": "{count} sessions",
  "models.providers": "Based on {count} providers"
}
```

### 复数形式
英文需要处理复数，但 MVP 阶段可以用简单方式：
```json
{
  "chat.messageCount": "{count} message(s)"
}
```

### Rust 后端
后端错误消息暂不国际化（工作量大且用户较少直接看到），保持中文。

## 八、验证清单

每批迁移完成后检查：
- [ ] 中文模式下所有功能正常
- [ ] 英文模式下所有功能正常
- [ ] 语言切换后页面正确刷新
- [ ] 没有遗漏的硬编码中文
- [ ] 参数插值正确显示
- [ ] 长英文文本不溢出布局
- [ ] toast/modal/confirm 文本正确
