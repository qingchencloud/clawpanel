# CJGClaw 技术设计文档

> 状态：已确认 | 版本：1.0 | 日期：2026-04-06

## 1. 项目概述

### 1.1 背景

基于 ClawPanel 进行商用二次开发，产品名称为 **CJGClaw**，目标为面向企业团队提供稳定、美观、易用的 OpenClaw AI Agent 管理面板。

### 1.2 核心原则

- **企业级商用**：许可证合规，完全自研，仅调用 OpenClaw CLI 接口
- **沙箱隔离**：捆绑指定版本 OpenClaw，数据与配置存储在 `~/.cjgclaw/`，不与系统环境冲突
- **可扩展架构**：桌面优先，架构预留 Web/移动端扩展能力
- **UI 优先**：现代简洁设计，主色调 `#2C8E65`，适合领导级演示

### 1.3 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Tauri v2 (Rust + WebView) |
| 前端框架 | React 19 + TypeScript |
| UI 组件库 | shadcn/ui (Radix UI 底层) |
| CSS 框架 | Tailwind CSS v4 |
| 服务端状态 | TanStack Query v5 |
| 客户端状态 | Zustand |
| 动效 | Framer Motion |
| 路由 | React Router v7 |
| 构建工具 | Vite |

---

## 2. 架构总览

### 2.1 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                    CJGClaw 前端                         │
│              React 19 + TypeScript                      │
│                                                         │
│  Pages (7个)  ──►  Hooks (数据)  ──►  IPC (invoke)    │
│  Components     ──►  Zustand (UI状态)                  │
│  shadcn/ui      ──►  Framer Motion (动效)              │
└──────────────────────────┬──────────────────────────────┘
                           │ Tauri IPC (invoke)
┌──────────────────────────▼──────────────────────────────┐
│                   CJGClaw Rust 后端                     │
│                  (src-tauri/src/)                      │
│                                                         │
│  sandbox.rs   — 沙箱初始化、捆绑 OpenClaw 路径管理     │
│  openclaw.rs  — CLI 调用封装（绝对路径）               │
│  gateway.rs   — Gateway 进程启停管理                   │
│  config.rs    — openclaw.json / cjgclaw.json 读写      │
│  agent.rs     — Agent CRUD                             │
│                                                         │
│  bundled/openclaw/  — 捆绑的 OpenClaw CLI (只读)      │
└──────────────────────────┬──────────────────────────────┘
                           │ Shell / HTTP
┌──────────────────────────▼──────────────────────────────┐
│                   OpenClaw Gateway                       │
│              (端口 28790，沙箱隔离)                       │
└─────────────────────────────────────────────────────────┘
```

### 2.2 沙箱隔离方案

参考 QClaw 架构（`/Applications/QClaw.app` + `~/.qclaw/`）：

**App Bundle 内捆绑 OpenClaw：**

```
/Applications/CJGClaw.app/Contents/Resources/openclaw/
├── node_modules/openclaw/     # OpenClaw npm 包（锁定版本）
├── config/                    # 默认配置模板
│   ├── openclaw.json
│   ├── extensions/
│   └── skills/
└── package.json               # {"dependencies": {"openclaw": "2026.x.x"}}
```

**用户数据目录：**

```
~/.cjgclaw/
├── cjgclaw.json           # 核心配置（端口映射、捆绑路径、PID）
├── openclaw.json         # OpenClaw 运行时配置
├── .installed            # 版本标记
├── agents/              # Agent 数据
├── memory/              # 记忆文件（SQLite / 文件）
├── identity/device.json # 设备身份密钥 (Ed25519)
├── backups/             # 配置备份
├── logs/                # 日志文件
└── cron/                # 定时任务
```

**CLI 调用方式：**
- 所有调用通过绝对路径：`$BUNDLE_RESOURCES/openclaw/node_modules/openclaw/openclaw.mjs`
- 不使用系统 PATH 中的 `openclaw` 命令
- Tauri Rust 端通过 `sandbox.rs` 中的 `openclaw_path()` 获取路径

### 2.3 端口分配

| 端口 | 用途 |
|------|------|
| `28789` | QClaw（避免冲突） |
| `28790` | CJGClaw Gateway |
| `18789` | 系统 OpenClaw（避免冲突） |

---

## 3. 前端架构

### 3.1 目录结构

```
src/
├── app/
│   ├── App.tsx                    # 根组件
│   ├── providers.tsx              # ThemeProvider / QueryClientProvider
│   └── router.tsx                 # 路由配置
│
├── pages/                         # 页面（按功能域）
│   ├── dashboard/
│   │   ├── DashboardPage.tsx
│   │   └── components/
│   ├── services/
│   ├── models/
│   ├── chat/
│   ├── agents/
│   ├── gateway/
│   └── setup/                     # 首次安装向导
│
├── components/
│   ├── ui/                        # shadcn/ui 组件
│   ├── layout/                    # Sidebar, Header, PageContainer
│   └── shared/                    # StatusBadge, ModelCard, AgentCard
│
├── hooks/                         # 自定义 Hooks（核心抽象层）
│   ├── useIpc.ts                 # 通用 IPC 调用
│   ├── useGateway.ts             # Gateway 状态 / 启停
│   ├── useWebSocket.ts           # WebSocket 连接管理
│   ├── useAgents.ts              # Agent CRUD
│   └── useModels.ts              # 模型配置
│
├── lib/
│   ├── ipc.ts                     # 类型安全的 invoke 封装（按领域分组）
│   ├── ws.ts                      # WebSocket 客户端
│   ├── theme.ts                   # 主题管理（#2C8E65 主色）
│   └── utils.ts                   # cn() / formatDate() 等工具
│
├── types/
│   ├── openclaw.ts                # OpenClaw 配置 / Agent / 模型类型
│   ├── gateway.ts                 # Gateway 状态类型
│   └── ipc.ts                     # IPC 命令与响应类型映射
│
└── styles/
    └── globals.css                # Tailwind 入口 + CSS Variables
```

### 3.2 IPC 封装（lib/ipc.ts）

```typescript
// 所有 Tauri invoke 调用的唯一入口，按领域分组
export const ipc = {
  sandbox: {
    init: () => invoke<InitResult>('sandbox_init'),
    status: () => invoke<SandboxStatus>('sandbox_status'),
  },
  config: {
    read: () => invoke<OpenClawConfig>('config_read'),
    write: (cfg: OpenClawConfig) => invoke<void>('config_write', { cfg }),
  },
  gateway: {
    start: () => invoke<void>('gateway_start'),
    stop: () => invoke<void>('gateway_stop'),
    restart: () => invoke<void>('gateway_restart'),
    status: () => invoke<GatewayStatus>('gateway_status'),
    reload: () => invoke<void>('gateway_reload'),
  },
  agent: {
    list: () => invoke<Agent[]>('agent_list'),
    create: (name: string, model: string) => invoke<Agent>('agent_create', { name, model }),
    delete: (id: string) => invoke<void>('agent_delete', { id }),
    updateIdentity: (id: string, identity: Identity) => invoke<void>('agent_update_identity', { id, identity }),
    updateModel: (id: string, model: string) => invoke<void>('agent_update_model', { id, model }),
  },
  model: {
    list: () => invoke<ModelConfig[]>('model_list'),
    test: (params: ModelTestParams) => invoke<ModelTestResult>('model_test', params),
  },
}
```

### 3.3 Hooks 层示例

```typescript
// hooks/use-gateway.ts
export function useGateway() {
  const query = useQuery({
    queryKey: ['gateway', 'status'],
    queryFn: ipc.gateway.status,
    refetchInterval: 5000,
  })

  const startMutation = useMutation({
    mutationFn: ipc.gateway.start,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gateway'] }),
  })

  const stopMutation = useMutation({
    mutationFn: ipc.gateway.stop,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gateway'] }),
  })

  return {
    status: query.data,
    isLoading: query.isLoading,
    isRunning: query.data?.running ?? false,
    start: startMutation.mutate,
    stop: stopMutation.mutate,
  }
}
```

### 3.4 UI 设计规范

**主色调：**

```css
@theme {
  --color-primary: #2C8E65;
  --color-primary-hover: #236B50;
  --color-primary-light: #E8F5F0;
  --color-secondary: #5BBC9E;
  --color-bg-dark: #1A2E28;
}
```

**动效规范：**

| 场景 | 方案 |
|------|------|
| 页面切换 | Framer Motion `AnimatePresence` + 滑入 200ms |
| 卡片 Hover | `hover:-translate-y-0.5` + 阴影加深 |
| 加载状态 | Skeleton 骨架屏 |
| 状态徽章 | 颜色变化 + 微缩放动画 |
| 计数器 | `react-countup` 数字滚动动画 |

---

## 4. Rust 后端架构

### 4.1 目录结构

```
src-tauri/src/
├── main.rs                    # 入口
├── lib.rs                     # run() — Builder + 命令注册
├── commands/
│   ├── mod.rs                # 公共工具 (cjgclaw_dir / openclaw_path / gateway_port)
│   ├── sandbox.rs           # 沙箱初始化 / 状态
│   ├── openclaw.rs         # CLI 调用封装
│   ├── gateway.rs          # Gateway 进程管理
│   ├── config.rs           # 配置读写
│   └── agent.rs            # Agent CRUD
└── models/
    └── types.rs            # Rust 结构体
```

### 4.2 沙箱初始化流程

1. 创建 `~/.cjgclaw/` 目录结构（agents/memory/identity/logs/backups/cron）
2. 生成设备身份密钥（Ed25519，如不存在）
3. 创建 `cjgclaw.json`（端口 28790、捆绑路径、平台信息）
4. 写入 `.installed` 版本标记

### 4.3 OpenClaw CLI 调用

所有调用通过绝对路径：
```
node $BUNDLE_RESOURCES/openclaw/node_modules/openclaw/openclaw.mjs <args>
```

环境变量注入 `CJGCLAW_DIR` 指向 `~/.cjgclaw/`，确保 OpenClaw 使用沙箱目录。

---

## 5. MVP 功能范围

### 5.1 包含（v1.0）

| 页面 | 功能 |
|------|------|
| 仪表盘 | Gateway 状态、Agent 概览、快捷操作卡片 |
| 服务管理 | Gateway 启停、状态监控、版本信息 |
| 模型配置 | 服务商列表、模型 CRUD、连通性测试 |
| 实时聊天 | WebSocket 流式对话、Markdown 渲染 |
| Agent 管理 | Agent CRUD、身份编辑、模型绑定 |
| 网关配置 | 端口、Token、访问权限 |
| 初始向导 | 沙箱初始化、环境检测、安装引导 |

### 5.2 延后（v2+）

AI 助手、消息渠道、定时任务、用量统计、Skills 管理、扩展工具、自动更新、审计日志、多语言

---

## 6. 可扩展性设计

| 扩展点 | 当前 | 后续扩展方式 |
|--------|------|-------------|
| 新增页面 | `pages/` 下加目录 + 注册路由 | 零改动 |
| 新增 IPC 命令 | `ipc.ts` 加方法 + Rust 加命令 | 类型自动同步 |
| Web 模式 | 无 | 添加 `serve.ts` + `ipc-web.ts` |
| 移动端 | 无 | Tauri 移动端，同一套 React 代码 |
| 多语言 | 硬编码中文 | `react-i18next` |
| 消息渠道 | 无 | `commands/channel.rs` + `hooks/useChannels.ts` |
