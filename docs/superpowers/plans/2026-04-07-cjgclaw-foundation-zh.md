# CJGClaw 基础架构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 从零开始搭建 CJGClaw 前端 —— React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui + React Router v7 + Zustand + TanStack Query v5 + Framer Motion。将现有的 vanilla JS SPA 重写为全类型化、组件驱动的架构。

**架构：** 完整的前端重写。新的 `src/` 目录包含 React 入口、路由、Provider、布局外壳（侧边栏 + 头部 + 页面容器）、类型化 IPC 层、Zustand 状态管理、TanStack Query hooks，以及将在计划 3 中完善的占位页面。Vite 开发服务器端口 1420，WebSocket 代理到 Gateway 端口 28790。

**技术栈：** React 19, TypeScript 5, Vite 6, Tailwind CSS v4, shadcn/ui (Radix UI), TanStack Query v5, Zustand v5, Framer Motion v11, React Router v7

---

## 文件结构

```
src/
├── main.tsx                         # React 入口
├── App.tsx                         # 根组件，Provider 包裹
├── router.tsx                      # React Router v7 配置
├── index.css                       # Tailwind + CSS Variables 入口
│
├── app/
│   ├── providers.tsx                # QueryClientProvider, ThemeProvider, RouterProvider
│   ├── router.tsx                  # 所有页面的路由定义
│   └── App.tsx                     # 根布局: 侧边栏 + Outlet
│
├── pages/                          # 占位页面（在计划 3 中完善）
│   ├── dashboard/
│   │   └── DashboardPage.tsx
│   ├── services/
│   │   └── ServicesPage.tsx
│   ├── models/
│   │   └── ModelsPage.tsx
│   ├── chat/
│   │   └── ChatPage.tsx
│   ├── agents/
│   │   └── AgentsPage.tsx
│   ├── gateway/
│   │   └── GatewayPage.tsx
│   ├── skills/
│   │   └── SkillsPage.tsx
│   ├── extensions/
│   │   └── ExtensionsPage.tsx
│   └── setup/
│       └── SetupPage.tsx
│
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx             # 深青色侧边栏，可折叠
│   │   ├── Header.tsx              # 面包屑 + 页面标题 + 用户操作
│   │   └── PageContainer.tsx       # 带内边距和滚动的包装器
│   └── ui/                         # shadcn/ui 组件
│       ├── button.tsx
│       ├── card.tsx
│       ├── badge.tsx
│       ├── skeleton.tsx
│       ├── toast.tsx
│       └── alert-banner.tsx
│
├── hooks/
│   ├── useGateway.ts               # Gateway 状态 / 启动 / 停止
│   ├── useAgents.ts                # Agent CRUD via TanStack Query
│   └── useModels.ts                # 模型配置 via TanStack Query
│
├── lib/
│   ├── ipc.ts                      # 类型安全的 Tauri invoke 包装（按域分组）
│   ├── ws.ts                       # WebSocket 客户端 hook（替换 ws-client.js）
│   ├── theme.ts                    # CSS Variables + data-theme 切换
│   └── utils.ts                    # cn(), formatDate() 等工具函数
│
├── stores/
│   └── ui-store.ts                 # Zustand store: 侧边栏折叠状态、当前页面
│
├── types/
│   ├── openclaw.ts                 # OpenClaw 配置/agent/模型类型
│   ├── gateway.ts                  # Gateway 状态类型
│   └── ipc.ts                      # IPC 命令请求/响应类型
│
└── styles/
    └── globals.css                 # Tailwind @theme 块 + CSS Variables

vite.config.ts                      # Vite 配置（TypeScript）
tsconfig.json                       # TypeScript 配置
tailwind.config.ts                  # Tailwind v4 配置，含 @theme
components.json                     # shadcn/ui 配置
```

---

## 任务 1：初始化 React 19 + TypeScript + Vite 项目

**涉及文件：**
- 创建: `src/main.tsx`
- 创建: `vite.config.ts`
- 创建: `tsconfig.json`
- 创建: `tsconfig.app.json`
- 创建: `tsconfig.node.json`
- 创建: `package.json`
- 修改: `src/index.css`（新建）
- 创建: `index.html`
- 创建: `tailwind.config.ts`
- 创建: `components.json`
- 创建: `postcss.config.js`

- [ ] **步骤 1：创建 package.json，包含所有依赖**

```json
{
  "name": "cjgclaw",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.74.0",
    "@tauri-apps/api": "^2.5.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "framer-motion": "^11.15.0",
    "lucide-react": "^0.468.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.5.0",
    "tailwind-merge": "^2.6.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.4.0",
    "autoprefixer": "^10.4.20",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.7.0",
    "vite": "^6.3.0"
  }
}
```

- [ ] **步骤 2：创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
```

- [ ] **步骤 3：创建 tsconfig.json**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

- [ ] **步骤 4：创建 tsconfig.app.json**

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **步骤 5：创建 tsconfig.node.json**

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **步骤 6：创建 postcss.config.js**

```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
```

注意：Tailwind v4 使用 `@tailwindcss/postcss` 而不是旧的 `tailwindcss` PostCSS 插件。

- [ ] **步骤 7：创建 index.html**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CJGClaw</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **步骤 8：安装依赖**

运行: `cd /Users/guitaoli/ailab/clawpanel && npm install`
预期：所有包安装成功

- [ ] **步骤 9：提交**

```bash
git add package.json vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json postcss.config.js index.html
git commit -m "feat: scaffold React 19 + TypeScript + Vite project"
```

---

## 任务 2：配置 Tailwind CSS v4 与 CJGClaw 设计系统

**涉及文件：**
- 创建: `src/index.css`
- 创建: `tailwind.config.ts`

- [ ] **步骤 1：创建 src/index.css，包含 Tailwind v4 @theme 和设计令牌**

```css
@import "tailwindcss";

@theme {
  /* === Primary (Teal) === */
  --color-primary-50: #E8F5F0;
  --color-primary-100: #C5E8DA;
  --color-primary-200: #9DD6BC;
  --color-primary-300: #6DC4A0;
  --color-primary-400: #5BBC9E;
  --color-primary-500: #2C8E65;
  --color-primary-600: #236B50;
  --color-primary-700: #1A523D;
  --color-primary-800: #12392B;
  --color-primary-900: #1A2E28;

  /* === Semantic === */
  --color-success: #22C55E;
  --color-success-light: #DCFCE7;
  --color-warning: #F59E0B;
  --color-warning-light: #FEF3C7;
  --color-error: #EF4444;
  --color-error-light: #FEE2E2;
  --color-info: #3B82F6;
  --color-info-light: #DBEAFE;

  /* === Neutral === */
  --color-gray-50: #F8FAFB;
  --color-gray-100: #F1F5F3;
  --color-gray-200: #E2E8E5;
  --color-gray-300: #CBD5D0;
  --color-gray-400: #94A3A0;
  --color-gray-500: #64748B;
  --color-gray-600: #475569;
  --color-gray-700: #334155;
  --color-gray-800: #1E293B;
  --color-gray-900: #0F172A;

  /* === Surface === */
  --color-surface: #FFFFFF;
  --color-surface-raised: #F8FAFB;
  --color-surface-overlay: #F1F5F3;
  --color-surface-sidebar: #1A2E28;

  /* === Text === */
  --color-text-primary: #0F172A;
  --color-text-secondary: #475569;
  --color-text-tertiary: #94A3A0;
  --color-text-inverse: #F8FAFB;

  /* === Border === */
  --color-border: #E2E8E5;
  --color-border-hover: #CBD5D0;

  /* === Typography === */
  --font-sans: 'Geist Sans', 'Noto Sans SC', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  /* === Spacing === */
  --sidebar-width: 240px;
  --sidebar-collapsed: 64px;
  --header-height: 56px;

  /* === Radius === */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
}

/* === Base styles === */
@layer base {
  *, *::before, *::after {
    box-sizing: border-box;
  }

  html {
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  body {
    margin: 0;
    padding: 0;
    background: var(--color-surface);
    color: var(--color-text-primary);
  }

  code, pre, .font-mono {
    font-family: var(--font-mono);
  }
}

/* === Dark theme === */
[data-theme="dark"] {
  --color-surface: #0F172A;
  --color-surface-raised: #1E293B;
  --color-surface-overlay: #334155;
  --color-surface-sidebar: #0B1120;
  --color-text-primary: #F8FAFB;
  --color-text-secondary: #94A3A0;
  --color-border: #334155;
  --color-primary-500: #5BBC9E;
}

/* === Gateway status pulse animation === */
@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
  100% { box-shadow: 0 0 0 12px rgba(34, 197, 94, 0); }
}

.pulse-ring {
  animation: pulse-ring 1.5s cubic-bezier(0.455, 0.03, 0.515, 0.955) infinite;
}

/* === Cursor blink === */
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.cursor-blink::after {
  content: '▋';
  animation: blink 1s step-end infinite;
  color: var(--color-primary-500);
}
```

- [ ] **步骤 2：创建 tailwind.config.ts**

```typescript
import type { Config } from 'tailwindcss'

export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
} satisfies Config
```

注意：Tailwind v4 不再使用 config.js 中的 theme 对象。所有主题值都放在 CSS @theme 中。配置文件只需 `content` 和 `darkMode`。

- [ ] **步骤 3：创建 src/main.tsx**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **步骤 4：创建 src/App.tsx**

```tsx
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './app/router'
import { Toaster } from '@/components/ui/toast'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  )
}
```

- [ ] **步骤 5：提交**

```bash
git add src/index.css tailwind.config.ts src/main.tsx src/App.tsx
git commit -m "feat: set up Tailwind v4 with CJGClaw design tokens"
```

---

## 任务 3：配置 shadcn/ui

**涉及文件：**
- 创建: `components.json`
- 创建: `src/lib/utils.ts`
- 创建: `src/components/ui/button.tsx`
- 创建: `src/components/ui/card.tsx`
- 创建: `src/components/ui/badge.tsx`
- 创建: `src/components/ui/skeleton.tsx`
- 创建: `src/components/ui/toast.tsx` (基于 sonner)
- 创建: `src/components/ui/alert-banner.tsx`

- [ ] **步骤 1：创建 components.json**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/index.css",
    "baseColor": "gray",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **步骤 2：创建 src/lib/utils.ts**

```typescript
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
}
```

- [ ] **步骤 3：创建 src/components/ui/button.tsx**

```typescript
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97]',
  {
    variants: {
      variant: {
        default: 'bg-primary-500 text-white hover:bg-primary-600 shadow-sm',
        secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200',
        danger: 'bg-error text-white hover:bg-red-600',
        ghost: 'hover:bg-gray-100',
        outline: 'border border-border hover:bg-gray-50',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        default: 'h-9 px-4',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
```

- [ ] **步骤 4：创建 src/components/ui/card.tsx**

```typescript
import * as React from 'react'
import { cn } from '@/lib/utils'

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-xl border border-border bg-surface shadow-card transition-shadow hover:shadow-card-hover',
        className,
      )}
      {...props}
    />
  ),
)
Card.displayName = 'Card'

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-5', className)} {...props} />
  ),
)
CardHeader.displayName = 'CardHeader'

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  ),
)
CardTitle.displayName = 'CardTitle'

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-text-secondary', className)} {...props} />
  ),
)
CardDescription.displayName = 'CardDescription'

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-5 pt-0', className)} {...props} />
  ),
)
CardContent.displayName = 'CardContent'

export { Card, CardHeader, CardTitle, CardDescription, CardContent }
```

- [ ] **步骤 5：创建 src/components/ui/badge.tsx**

```typescript
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary-100 text-primary-700',
        success: 'bg-success-light text-success',
        warning: 'bg-warning-light text-warning',
        error: 'bg-error-light text-error',
        info: 'bg-info-light text-info',
        secondary: 'bg-gray-100 text-gray-600',
        outline: 'border border-border text-text-secondary',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
```

- [ ] **步骤 6：创建 src/components/ui/skeleton.tsx**

```typescript
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-lg bg-gray-200', className)}
      {...props}
    />
  )
}

export { Skeleton }
```

- [ ] **步骤 7：创建 src/components/ui/toast.tsx（使用 sonner）**

先安装 sonner: `npm install sonner`

```typescript
import { Toaster as Sonner } from 'sonner'

function Toaster() {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: 'group toast group-[.toaster]:bg-surface group-[.toaster]:text-text-primary group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          success: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-success',
          error: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-error',
          warning: 'group-[.toaster]:border-l-4 group-[.toaster]:border-l-warning',
        },
      }}
    />
  )
}

export { Toaster }
```

- [ ] **步骤 8：创建 src/components/ui/alert-banner.tsx**

```typescript
import { cn } from '@/lib/utils'

interface AlertBannerProps {
  variant: 'warning' | 'error' | 'info'
  message: string
  action?: React.ReactNode
  onDismiss?: () => void
  className?: string
}

const variantStyles = {
  warning: 'bg-warning-light border-warning text-warning',
  error: 'bg-error-light border-error text-error',
  info: 'bg-info-light border-info text-info',
}

export function AlertBanner({ variant, message, action, onDismiss, className }: AlertBannerProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-l-4 px-4 py-3 text-sm',
        variantStyles[variant],
        className,
      )}
    >
      <span>{message}</span>
      <div className="flex items-center gap-2">
        {action}
        {onDismiss && (
          <button onClick={onDismiss} className="opacity-70 hover:opacity-100">
            ✕
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **步骤 9：提交**

```bash
git add components.json src/lib/utils.ts src/components/ui/
git commit -m "feat: configure shadcn/ui components"
```

---

## 任务 4：构建布局外壳（侧边栏 + 头部 + 页面容器）

**涉及文件：**
- 创建: `src/components/layout/Sidebar.tsx`
- 创建: `src/components/layout/Header.tsx`
- 创建: `src/components/layout/PageContainer.tsx`

- [ ] **步骤 1：创建 src/components/layout/Sidebar.tsx**

```typescript
import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard,
  MessageSquare,
  Boxes,
  Bot,
  Server,
  Network,
  Puzzle,
  Wrench,
  ChevronLeft,
  ChevronRight,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui-store'

const NAV_ITEMS = [
  { path: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { path: '/chat', label: '聊天', icon: MessageSquare },
  { path: '/models', label: '模型', icon: Boxes },
  { path: '/agents', label: 'Agent', icon: Bot },
  { path: '/services', label: '服务', icon: Server },
  { path: '/gateway', label: '网关', icon: Network },
  { path: '/skills', label: 'Skills', icon: Puzzle },
  { path: '/extensions', label: '扩展', icon: Wrench },
]

export function Sidebar() {
  const location = useLocation()
  const collapsed = useUIStore((s) => s.sidebarCollapsed)
  const setCollapsed = useUIStore((s) => s.setSidebarCollapsed)

  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 240 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="flex h-screen flex-col"
      style={{ background: 'var(--color-surface-sidebar)' }}
    >
      {/* Logo */}
      <div className="flex h-14 items-center gap-3 border-b border-white/10 px-4">
        <div className="h-8 w-8 flex-shrink-0 rounded-lg bg-primary-500" />
        <AnimatePresence>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-lg font-semibold text-text-inverse"
            >
              CJGClaw
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Nav items */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const active = location.pathname === path
          return (
            <Link
              key={path}
              to={path}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary-500/20 text-primary-400'
                  : 'text-white/60 hover:bg-white/10 hover:text-white',
              )}
            >
              <Icon className="h-5 w-5 flex-shrink-0" />
              <AnimatePresence>
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    {label}
                  </motion.span>
                )}
              </AnimatePresence>
            </Link>
          )
        })}
      </nav>

      {/* Settings */}
      <div className="border-t border-white/10 px-2 py-3">
        <Link
          to="/settings"
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/60 hover:bg-white/10 hover:text-white',
          )}
        >
          <Settings className="h-5 w-5 flex-shrink-0" />
          <AnimatePresence>
            {!collapsed && (
              <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                设置
              </motion.span>
            )}
          </AnimatePresence>
        </Link>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex h-10 items-center justify-center border-t border-white/10 text-white/40 hover:text-white"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </motion.aside>
  )
}
```

- [ ] **步骤 2：创建 src/components/layout/Header.tsx**

```typescript
import { useLocation } from 'react-router-dom'
import { useUIStore } from '@/stores/ui-store'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': '仪表盘',
  '/chat': '聊天',
  '/models': '模型配置',
  '/agents': 'Agent 管理',
  '/services': '服务管理',
  '/gateway': '网关配置',
  '/skills': 'Skills 管理',
  '/extensions': '扩展工具',
  '/setup': '初始化向导',
}

export function Header() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] ?? 'CJGClaw'

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
      <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
      <div className="flex items-center gap-3">
        <span className="text-sm text-text-tertiary">v1.0.0</span>
      </div>
    </header>
  )
}
```

- [ ] **步骤 3：创建 src/components/layout/PageContainer.tsx**

```typescript
import { motion } from 'framer-motion'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

const pageVariants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
}

const pageTransition = {
  duration: 0.2,
  ease: 'easeOut',
}

export function PageContainer() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <motion.div
            variants={pageVariants}
            initial="initial"
            animate="enter"
            exit="exit"
            transition={pageTransition}
          >
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **步骤 4：创建 src/stores/ui-store.ts**

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
  gatewayOfflineDismissed: boolean
  setGatewayOfflineDismissed: (v: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      gatewayOfflineDismissed: false,
      setGatewayOfflineDismissed: (v) => set({ gatewayOfflineDismissed: v }),
    }),
    { name: 'cjgclaw-ui' },
  ),
)
```

- [ ] **步骤 5：提交**

```bash
git add src/components/layout/ src/stores/ui-store.ts
git commit -m "feat: build layout shell (Sidebar, Header, PageContainer)"
```

---

## 任务 5：配置 React Router v7

**涉及文件：**
- 创建: `src/app/router.tsx`
- 创建: `src/pages/dashboard/DashboardPage.tsx`
- 创建: `src/pages/services/ServicesPage.tsx`
- 创建: `src/pages/models/ModelsPage.tsx`
- 创建: `src/pages/chat/ChatPage.tsx`
- 创建: `src/pages/agents/AgentsPage.tsx`
- 创建: `src/pages/gateway/GatewayPage.tsx`
- 创建: `src/pages/skills/SkillsPage.tsx`
- 创建: `src/pages/extensions/ExtensionsPage.tsx`
- 创建: `src/pages/setup/SetupPage.tsx`

- [ ] **步骤 1：创建 src/app/router.tsx**

```typescript
import { createRouter, createRoute, createRootRoute, Outlet } from '@tanstack/react-router'
import { PageContainer } from '@/components/layout/PageContainer'

// Root layout route
const rootRoute = createRootRoute({
  component: () => (
    <PageContainer>
      <Outlet />
    </PageContainer>
  ),
})

// Lazy-loaded page imports
import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { ServicesPage } from '@/pages/services/ServicesPage'
import { ModelsPage } from '@/pages/models/ModelsPage'
import { ChatPage } from '@/pages/chat/ChatPage'
import { AgentsPage } from '@/pages/agents/AgentsPage'
import { GatewayPage } from '@/pages/gateway/GatewayPage'
import { SkillsPage } from '@/pages/skills/SkillsPage'
import { ExtensionsPage } from '@/pages/extensions/ExtensionsPage'
import { SetupPage } from '@/pages/setup/SetupPage'

// Page routes
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/dashboard', component: DashboardPage })
const servicesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/services', component: ServicesPage })
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/models', component: ModelsPage })
const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chat', component: ChatPage })
const agentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/agents', component: AgentsPage })
const gatewayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/gateway', component: GatewayPage })
const skillsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/skills', component: SkillsPage })
const extensionsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/extensions', component: ExtensionsPage })
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupPage })

const rootRouteTree = rootRoute.addChildren([
  dashboardRoute,
  servicesRoute,
  modelsRoute,
  chatRoute,
  agentsRoute,
  gatewayRoute,
  skillsRoute,
  extensionsRoute,
  setupRoute,
])

export const router = createRouter({ routeTree: rootRouteTree })
```

注意：React Router v7 使用 `@tanstack/react-router`。需要安装: `npm install @tanstack/react-router`。

或者，如果使用 react-router-dom v7（不是 tanstack），用这个更简单的方案：

```typescript
// src/app/router.tsx (react-router-dom v7)
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router-dom'
import { PageContainer } from '@/components/layout/PageContainer'

function Layout() {
  return (
    <PageContainer>
      <Outlet />
    </PageContainer>
  )
}

export function router() {
  return createBrowserRouter([
    {
      element: <Layout />,
      children: [
        { path: '/', element: <Navigate to="/dashboard" replace /> },
        { path: '/dashboard', lazy: () => import('@/pages/dashboard/DashboardPage') },
        // ... etc
      ],
    },
  ])
}
```

选择其中一种方案并安装: `npm install @tanstack/react-router`（或 `react-router-dom@^7`）。

- [ ] **步骤 2：创建占位页面（为计划 3 预留）**

创建 `src/pages/dashboard/DashboardPage.tsx`:
```typescript
export function DashboardPage() {
  return <div className="text-text-primary">仪表盘</div>
}
```

创建 `src/pages/services/ServicesPage.tsx`:
```typescript
export function ServicesPage() {
  return <div className="text-text-primary">服务管理</div>
}
```

创建 `src/pages/models/ModelsPage.tsx`:
```typescript
export function ModelsPage() {
  return <div className="text-text-primary">模型配置</div>
}
```

创建 `src/pages/chat/ChatPage.tsx`:
```typescript
export function ChatPage() {
  return <div className="text-text-primary">聊天</div>
}
```

创建 `src/pages/agents/AgentsPage.tsx`:
```typescript
export function AgentsPage() {
  return <div className="text-text-primary">Agent 管理</div>
}
```

创建 `src/pages/gateway/GatewayPage.tsx`:
```typescript
export function GatewayPage() {
  return <div className="text-text-primary">网关配置</div>
}
```

创建 `src/pages/skills/SkillsPage.tsx`:
```typescript
export function SkillsPage() {
  return <div className="text-text-primary">Skills 管理</div>
}
```

创建 `src/pages/extensions/ExtensionsPage.tsx`:
```typescript
export function ExtensionsPage() {
  return <div className="text-text-primary">扩展工具</div>
}
```

创建 `src/pages/setup/SetupPage.tsx`:
```typescript
export function SetupPage() {
  return <div className="text-text-primary">初始化向导</div>
}
```

- [ ] **步骤 3：更新 App.tsx 使用路由**

```tsx
import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { router } from './app/router'
import { Toaster } from '@/components/ui/toast'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  )
}
```

- [ ] **步骤 4：验证构建**

运行: `npm run build`
预期：TypeScript 编译通过，Vite 生成 dist 输出

- [ ] **步骤 5：提交**

```bash
git add src/app/router.tsx src/pages/**/
git commit -m "feat: set up React Router v7 with all page routes"
```

---

## 任务 6：构建类型化 IPC 层

**涉及文件：**
- 创建: `src/types/openclaw.ts`
- 创建: `src/types/gateway.ts`
- 创建: `src/types/ipc.ts`
- 创建: `src/lib/ipc.ts`

- [ ] **步骤 1：创建 src/types/openclaw.ts**

```typescript
export interface Agent {
  id: string
  name: string
  model?: string
  identity?: { name: string; emoji?: string }
  workspace?: string
  createdAt?: string
}

export interface ModelConfig {
  provider: string
  models: string[]
  apiKey?: string
  baseUrl?: string
  enabled?: boolean
}

export interface OpenClawConfig {
  agents?: Record<string, Agent>
  models?: ModelConfig[]
  gateway?: {
    port?: number
    token?: string
  }
  extensions?: Record<string, unknown>
  skills?: Record<string, unknown>
}

export interface VersionInfo {
  current: string | null
  latest: string | null
  recommended: string | null
  update_available: boolean
  panel_version: string
}
```

- [ ] **步骤 2：创建 src/types/gateway.ts**

```typescript
export interface GatewayStatus {
  running: boolean
  port: number
  pid?: number
  startedAt?: string
}

export interface ServiceStatus {
  label: string
  pid: number | null
  running: boolean
  description: string
  cli_installed: boolean
}

export interface GuardianStatus {
  auto_restart_count: number
  max_auto_restarts: number
  manual_hold: boolean
  last_seen_running: string | null
  running_since: string | null
  give_up: boolean
}
```

- [ ] **步骤 3：创建 src/types/ipc.ts**

```typescript
// IPC 命令请求/响应类型联合

// sandbox
export interface SandboxInitResult { initialized: boolean; version: string }
export interface SandboxStatus { installed: boolean; version: string; dir: string }

// gateway
export interface GatewayStartResult { success: boolean }
export interface GatewayStopResult { success: boolean }
export interface GatewayReloadResult { success: boolean }

// config
export type ReadConfigResult = Record<string, unknown>
export interface WriteConfigResult { success: boolean }

// agent
export type ListAgentsResult = import('./openclaw').Agent[]
export interface AddAgentParams { name: string; model?: string }
export interface DeleteAgentParams { id: string }
export interface UpdateAgentModelParams { id: string; model: string }
export interface UpdateAgentIdentityParams { id: string; name?: string; emoji?: string }

// model
export interface TestModelParams { baseUrl: string; model: string; apiKey?: string; messages?: unknown[] }
export interface TestModelResult { success: boolean; latency_ms: number; error?: string }
export interface ListRemoteModelsParams { baseUrl: string; apiKey: string }
export interface ListRemoteModelsResult { models: string[] }

// skills
export interface SkillInfo { name: string; version?: string; description?: string; installed: boolean }
export interface SkillsListResult { skills: SkillInfo[] }
export interface SkillsSearchResult { results: Array<{ slug: string; name: string; description: string }> }

// extensions
export interface CftunnelStatus { running: boolean; tunnel_url?: string }
export interface ClawappStatus { installed: boolean; version?: string }
```

- [ ] **步骤 4：创建 src/lib/ipc.ts**

```typescript
import { invoke } from '@tauri-apps/api/core'

// ── Sandbox ────────────────────────────────────────────────
export const sandbox = {
  init: () => invoke<{ initialized: boolean; version: string }>('sandbox_init'),
  status: () => invoke<{ installed: boolean; version: string; dir: string }>('sandbox_status'),
}

// ── Gateway ────────────────────────────────────────────────
export const gateway = {
  start: () => invoke<void>('gateway_start'),
  stop: () => invoke<void>('gateway_stop'),
  restart: () => invoke<void>('gateway_restart'),
  reload: () => invoke<void>('gateway_reload'),
  status: () => invoke<{ running: boolean; port: number; pid?: number }>('gateway_status'),
}

// ── Config ────────────────────────────────────────────────
export const config = {
  read: () => invoke<Record<string, unknown>>('read_openclaw_config'),
  write: (cfg: Record<string, unknown>) => invoke<void>('write_openclaw_config', { config: cfg }),
  readMcp: () => invoke<Record<string, unknown>>('read_mcp_config'),
  writeMcp: (cfg: Record<string, unknown>) => invoke<void>('write_mcp_config', { config: cfg }),
  getVersionInfo: () => invoke<import('@/types/openclaw').VersionInfo>('get_version_info'),
  getStatusSummary: () => invoke<Record<string, unknown>>('get_status_summary'),
}

// ── Agent ─────────────────────────────────────────────────
export const agent = {
  list: () => invoke<import('@/types/openclaw').Agent[]>('list_agents'),
  create: (params: { name: string; model?: string }) =>
    invoke<import('@/types/openclaw').Agent>('add_agent', params),
  delete: (id: string) => invoke<string>('delete_agent', { id }),
  updateIdentity: (id: string, name?: string, emoji?: string) =>
    invoke<string>('update_agent_identity', { id, name, emoji }),
  updateModel: (id: string, model: string) =>
    invoke<string>('update_agent_model', { id, model }),
  backup: (id: string) => invoke<string>('backup_agent', { id }),
}

// ── Model ──────────────────────────────────────────────────
export const model = {
  test: (params: { baseUrl: string; model: string; apiKey?: string; messages?: unknown[] }) =>
    invoke<{ success: boolean; latency_ms: number; error?: string }>('test_model', params),
  listRemote: (params: { baseUrl: string; apiKey: string }) =>
    invoke<{ models: string[] }>('list_remote_models', params),
}

// ── Skills ────────────────────────────────────────────────
export const skills = {
  list: () => invoke<{ skills: Array<{ name: string; version?: string; description?: string; installed: boolean }> }>('skills_list'),
  info: (name: string) => invoke<Record<string, unknown>>('skills_info', { name }),
  check: () => invoke<Record<string, unknown>>('skills_check'),
  uninstall: (name: string) => invoke<Record<string, unknown>>('skills_uninstall', { name }),
  skillhubSearch: (query: string) => invoke<{ results: Array<{ slug: string; name: string; description: string }> }>('skills_skillhub_search', { query }),
  skillhubInstall: (slug: string) => invoke<Record<string, unknown>>('skills_skillhub_install', { slug }),
  clawhubSearch: (query: string) => invoke<{ results: Array<{ slug: string; name: string; description: string }> }>('skills_clawhub_search', { query }),
  clawhubInstall: (slug: string) => invoke<Record<string, unknown>>('skills_clawhub_install', { slug }),
}

// ── Extensions ─────────────────────────────────────────────
export const extensions = {
  cftunnelStatus: () => invoke<{ running: boolean; tunnel_url?: string }>('get_cftunnel_status'),
  cftunnelAction: (action: 'start' | 'stop') => invoke<void>('cftunnel_action', { action }),
  clawappStatus: () => invoke<{ installed: boolean; version?: string }>('get_clawapp_status'),
  installCftunnel: () => invoke<string>('install_cftunnel'),
  installClawapp: () => invoke<string>('install_clawapp'),
}

// ── Service ───────────────────────────────────────────────
export const service = {
  list: () => invoke<Array<{ label: string; pid: number | null; running: boolean; description: string }>>('get_services_status'),
  start: (label: string) => invoke<void>('start_service', { label }),
  stop: (label: string) => invoke<void>('stop_service', { label }),
  restart: (label: string) => invoke<void>('restart_service', { label }),
  guardianStatus: () => invoke<import('@/types/gateway').GuardianStatus>('guardian_status'),
}
```

- [ ] **步骤 5：提交**

```bash
git add src/types/ src/lib/ipc.ts
git commit -m "feat: build typed IPC layer with domain-grouped commands"
```

---

## 任务 7：构建 TanStack Query Hooks

**涉及文件：**
- 创建: `src/hooks/useGateway.ts`
- 创建: `src/hooks/useAgents.ts`
- 创建: `src/hooks/useModels.ts`
- 创建: `src/hooks/useWebSocket.ts`

- [ ] **步骤 1：创建 src/hooks/useGateway.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { gateway, service } from '@/lib/ipc'

export function useGatewayStatus() {
  return useQuery({
    queryKey: ['gateway', 'status'],
    queryFn: gateway.status,
    refetchInterval: 5000,
  })
}

export function useGatewayStart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: gateway.start,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateway'] }),
  })
}

export function useGatewayStop() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: gateway.stop,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateway'] }),
  })
}

export function useGatewayRestart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: gateway.restart,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateway'] }),
  })
}

export function useGuardianStatus() {
  return useQuery({
    queryKey: ['gateway', 'guardian'],
    queryFn: service.guardianStatus,
    refetchInterval: 15000,
  })
}
```

- [ ] **步骤 2：创建 src/hooks/useAgents.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { agent } from '@/lib/ipc'
import { toast } from 'sonner'

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: agent.list,
  })
}

export function useAgentCreate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { name: string; model?: string }) => agent.create(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Agent 创建成功')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useAgentDelete() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => agent.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Agent 已删除')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useAgentUpdateModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, model }: { id: string; model: string }) => agent.updateModel(id, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (err: Error) => toast.error(err.message),
  })
}
```

- [ ] **步骤 3：创建 src/hooks/useModels.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { config, model } from '@/lib/ipc'
import { toast } from 'sonner'

export function useOpenClawConfig() {
  return useQuery({
    queryKey: ['config', 'openclaw'],
    queryFn: config.read,
  })
}

export function useOpenClawConfigWrite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: Record<string, unknown>) => config.write(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      toast.success('配置已保存')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useModelTest() {
  return useMutation({
    mutationFn: model.test,
  })
}

export function useListRemoteModels() {
  return useMutation({
    mutationFn: model.listRemote,
  })
}
```

- [ ] **步骤 4：创建 src/hooks/useWebSocket.ts**

```typescript
import { useEffect, useRef, useState, useCallback } from 'react'
import { wsClient } from '@/lib/ws'

interface UseWebSocketOptions {
  onMessage?: (msg: unknown) => void
  onStatusChange?: (status: string) => void
  onReady?: () => void
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [gatewayReady, setGatewayReady] = useState(false)
  const unsubs = useRef<Array<() => void>>([])

  const connect = useCallback(async (host: string, token: string) => {
    setConnecting(true)
    try {
      wsClient.onStatusChange((status) => {
        setConnected(status === 'connected')
        setConnecting(status === 'connecting')
        options.onStatusChange?.(status)
      })
      wsClient.onReady(() => {
        setGatewayReady(true)
        options.onReady?.()
      })
      wsClient.onEvent((event) => {
        options.onMessage?.(event)
      })
      await wsClient.connect(host, token)
    } finally {
      setConnecting(false)
    }
  }, [options])

  const disconnect = useCallback(() => {
    wsClient.disconnect()
    setConnected(false)
    setGatewayReady(false)
  }, [])

  useEffect(() => {
    return () => {
      // cleanup subscriptions
      for (const unsub of unsubs.current) unsub()
    }
  }, [])

  return { connected, connecting, gatewayReady, connect, disconnect }
}
```

注意：WebSocket hook 依赖 `src/lib/ws.ts`，该文件将在计划 3（Chat 页面）中实现。目前使用 stub：

```typescript
// src/lib/ws.ts (stub for Plan 1)
export const wsClient = {
  connect: async () => {},
  disconnect: () => {},
  onStatusChange: (fn: (status: string) => void) => fn('disconnected'),
  onReady: (fn: () => void) => {},
  onEvent: (fn: (event: unknown) => void) => {},
  chatSend: async () => ({}),
  chatHistory: async () => ({ messages: [] }),
  chatAbort: () => {},
}
```

- [ ] **步骤 5：提交**

```bash
git add src/hooks/ src/lib/ws.ts
git commit -m "feat: build TanStack Query hooks and WebSocket hook"
```

---

## 任务 8：Gateway 离线 Banner

**涉及文件：**
- 创建: `src/components/layout/GatewayBanner.tsx`

- [ ] **步骤 1：创建 src/components/layout/GatewayBanner.tsx**

```typescript
import { AlertBanner } from '@/components/ui/alert-banner'
import { useGatewayStatus, useGatewayStart } from '@/hooks/useGateway'
import { useUIStore } from '@/stores/ui-store'
import { Button } from '@/components/ui/button'

export function GatewayBanner() {
  const { data: status } = useGatewayStatus()
  const start = useGatewayStart()
  const dismissed = useUIStore((s) => s.gatewayOfflineDismissed)
  const setDismissed = useUIStore((s) => s.setGatewayOfflineDismissed)

  if (!status?.running && !dismissed) {
    return (
      <AlertBanner
        variant="warning"
        message="Gateway 未运行，部分功能不可用"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => start.mutate()}
            loading={start.isPending}
          >
            启动
          </Button>
        }
        onDismiss={() => setDismissed(true)}
      />
    )
  }

  return null
}
```

- [ ] **步骤 2：更新 Header 以包含 GatewayBanner**

修改 `src/components/layout/Header.tsx` 添加 banner：

```typescript
import { GatewayBanner } from './GatewayBanner'

export function Header() {
  const location = useLocation()
  const title = PAGE_TITLES[location.pathname] ?? 'CJGClaw'

  return (
    <div>
      <GatewayBanner />
      <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-6">
        <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-text-tertiary">v1.0.0</span>
        </div>
      </header>
    </div>
  )
}
```

- [ ] **步骤 3：提交**

```bash
git add src/components/layout/GatewayBanner.tsx src/components/layout/Header.tsx
git commit -m "feat: add Gateway offline banner with start action"
```

---

## 计划总结

| 任务 | 文件 | 描述 |
|------|-------|------|
| 1 | package.json, vite.config.ts, tsconfig files, index.html | 初始化 React 19 + TS + Vite 项目 |
| 2 | src/index.css, tailwind.config.ts, src/main.tsx, src/App.tsx | Tailwind v4 + CSS Variables 设计令牌 |
| 3 | components.json, utils.ts, 6 个 shadcn 组件 | shadcn/ui 组件库 |
| 4 | Sidebar, Header, PageContainer, ui-store | 带 Framer Motion 动画的布局外壳 |
| 5 | router.tsx, 9 个占位页面 | React Router v7 路由 |
| 6 | types/*.ts, lib/ipc.ts | 类型化 IPC 层 |
| 7 | hooks/*.ts | TanStack Query hooks |
| 8 | GatewayBanner.tsx | Gateway 状态 Banner |

完成此计划后，应用将拥有可用的布局外壳、路由、类型化 IPC 和 TanStack Query —— 为计划 3（所有页面）做好准备。
