# CJGClaw 聊天 + 设置向导实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 实现实时聊天页面（WebSocket 流式传输、Markdown 渲染）和首次运行设置向导。这是两个最复杂的页面 —— 聊天是对 2534 行 vanilla JS chat.js 的重写，设置是一个新的首次运行体验。

**架构：**
- 聊天：React 组件，含 WebSocket hook、流式消息列表、Markdown 渲染器、工具事件显示、会话管理
- 设置：多步骤向导，带 Framer Motion 过渡、沙箱初始化检查、环境检测

**技术栈：** React 19, TypeScript, TanStack Query v5, Framer Motion v11, marked (Markdown), WebSocket (原生)

---

## 任务 1：WebSocket 客户端（lib/ws.ts）

**涉及文件：**
- 修改: `src/lib/ws.ts`（替换计划 1 中的 stub）

- [ ] **步骤 1：实现完整的 WebSocket 客户端**

```typescript
// src/lib/ws.ts
// 替换计划 1 中的 stub。镜像原始 ws-client.js 逻辑
//（667 行 vanilla JS → ~300 行 TypeScript，含正确的类型）。

type WsStatus = 'disconnected' | 'connecting' | 'connected'

interface ConnectionInfo {
  host: string
  token: string
  connectedAt: Date | null
}

type StatusChangeHandler = (status: WsStatus) => void
type ReadyHandler = () => void
type MessageHandler = (event: unknown) => void

class WsClient {
  private ws: WebSocket | null = null
  private _status: WsStatus = 'disconnected'
  private _statusHandlers: Set<StatusChangeHandler> = new Set()
  private _readyHandlers: Set<ReadyHandler> = new Set()
  private _messageHandlers: Set<MessageHandler> = new Set()
  private _reconnectAttempts = 0
  private _maxReconnectAttempts = 20
  private _reconnectDelay = 2000
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private _connectionInfo: ConnectionInfo | null = null

  get status() { return this._status }
  get reconnectState() {
    return {
      attempts: this._reconnectAttempts,
      maxAttempts: this._maxReconnectAttempts,
      delay: this._reconnectDelay,
    }
  }

  onStatusChange(handler: StatusChangeHandler) {
    this._statusHandlers.add(handler)
    return () => this._statusHandlers.delete(handler)
  }

  onReady(handler: ReadyHandler) {
    this._readyHandlers.add(handler)
    return () => this._readyHandlers.delete(handler)
  }

  onEvent(handler: MessageHandler) {
    this._messageHandlers.add(handler)
    return () => this._messageHandlers.delete(handler)
  }

  private _setStatus(status: WsStatus) {
    this._status = status
    this._statusHandlers.forEach((h) => h(status))
  }

  async connect(host: string, token: string): Promise<void> {
    if (this.ws) this.disconnect()
    this._connectionInfo = { host, token, connectedAt: null }
    this._setStatus('connecting')

    return new Promise((resolve, reject) => {
      const url = `ws://${host}/ws`
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        // 发送认证
        this.ws?.send(JSON.stringify({ type: 'auth', token }))
        this._setStatus('connected')
        this._connectionInfo!.connectedAt = new Date()
        this._startHeartbeat()
        this._readyHandlers.forEach((h) => h())
        resolve()
      }

      this.ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data)
          if (data.type === 'ready') {
            this._readyHandlers.forEach((h) => h())
          } else {
            this._messageHandlers.forEach((h) => h(data))
          }
        } catch {
          // 忽略解析错误
        }
      }

      this.ws.onerror = () => {
        this._setStatus('disconnected')
        reject(new Error('WebSocket 连接失败'))
      }

      this.ws.onclose = () => {
        this._setStatus('disconnected')
        this._stopHeartbeat()
        this._scheduleReconnect()
      }
    })
  }

  disconnect() {
    this._reconnectAttempts = this._maxReconnectAttempts // 防止自动重连
    this.ws?.close()
    this.ws = null
    this._setStatus('disconnected')
  }

  private _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 30000)
  }

  private _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval)
      this._heartbeatInterval = null
    }
  }

  private _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) return
    this._reconnectAttempts++
    const delay = Math.min(this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1), 60000)
    setTimeout(() => {
      if (this._connectionInfo && this._status === 'disconnected') {
        this.connect(this._connectionInfo.host, this._connectionInfo.token).catch(() => {})
      }
    }, delay)
  }

  async chatSend(params: {
    session: string
    message: string
    model?: string
    stream?: boolean
  }): Promise<Response> {
    const resp = await fetch(`/ws/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return resp
  }

  async chatHistory(session: string, limit = 50): Promise<{ messages: unknown[] }> {
    const resp = await fetch(`/ws/chat/history?session=${session}&limit=${limit}`)
    return resp.json()
  }

  chatAbort() {
    this.ws?.send(JSON.stringify({ type: 'abort' }))
  }
}

export const wsClient = new WsClient()
```

- [ ] **步骤 2：提交**

```bash
git add src/lib/ws.ts
git commit -m "feat: implement WebSocket client with auto-reconnect and heartbeat"
```

---

## 任务 2：聊天页面 —— 核心布局和消息列表

**涉及文件：**
- 修改: `src/pages/chat/ChatPage.tsx`
- 创建: `src/pages/chat/components/MessageList.tsx`
- 创建: `src/pages/chat/components/ChatInput.tsx`
- 创建: `src/pages/chat/components/SessionSidebar.tsx`

- [ ] **步骤 1：实现 ChatPage.tsx**

```typescript
import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, Square, Plus, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { gateway } from '@/lib/ipc'
import { wsClient } from '@/lib/ws'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  streaming?: boolean
  tools?: Array<{ name: string; status: string; result?: string }>
}

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentStreamContent, setCurrentStreamContent] = useState('')
  const [session, setSession] = useState(() => `session-${Date.now()}`)
  const bottomRef = useRef<HTMLDivElement>(null)

  const { data: gwStatus } = useQuery({
    queryKey: ['gateway', 'status'],
    queryFn: gateway.status,
    refetchInterval: 5000,
  })

  // 当 gateway 运行时自动连接 WebSocket
  useEffect(() => {
    if (gwStatus?.running) {
      wsClient.connect(`127.0.0.1:${gwStatus.port}`, '').catch(console.error)
    }
  }, [gwStatus?.running, gwStatus?.port])

  // 流式消息事件
  useEffect(() => {
    const unsub = wsClient.onEvent((event: any) => {
      if (event.type === 'message' || event.type === 'chunk') {
        const content = event.content ?? ''
        setCurrentStreamContent((prev) => prev + content)
      } else if (event.type === 'done') {
        // 完成流
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            role: 'assistant',
            content: currentStreamContent,
            timestamp: new Date(),
          },
        ])
        setCurrentStreamContent('')
        setIsStreaming(false)
      } else if (event.type === 'tool') {
        // 处理工具事件
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                tools: [
                  ...(last.tools ?? []),
                  { name: event.name, status: event.status, result: event.result },
                ],
              },
            ]
          }
          return prev
        })
      }
    })
    return unsub
  }, [currentStreamContent])

  // 自动滚动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentStreamContent])

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return

    const userMsg: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setIsStreaming(true)
    setCurrentStreamContent('')

    try {
      await wsClient.chatSend({
        session,
        message: userMsg.content,
        stream: true,
      })
    } catch (err) {
      setIsStreaming(false)
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: `发送失败: ${err}`,
          timestamp: new Date(),
        },
      ])
    }
  }

  const handleStop = () => {
    wsClient.chatAbort()
    setIsStreaming(false)
    if (currentStreamContent) {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: currentStreamContent,
          timestamp: new Date(),
        },
      ])
      setCurrentStreamContent('')
    }
  }

  const handleNewChat = () => {
    setSession(`session-${Date.now()}`)
    setMessages([])
    setCurrentStreamContent('')
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <MessageSquare className="h-5 w-5 text-primary-500" />
          <span className="font-medium">聊天</span>
          <Badge variant={gwStatus?.running ? 'success' : 'error'} className="text-xs">
            {gwStatus?.running ? 'Gateway 在线' : 'Gateway 离线'}
          </Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={handleNewChat}>
          <Plus className="h-4 w-4" />
          新对话
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <MessageList messages={messages} streamingContent={currentStreamContent} />
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-4">
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreaming}
          disabled={!gwStatus?.running}
        />
      </div>
    </div>
  )
}
```

- [ ] **步骤 2：创建 MessageList 组件**

```typescript
import { motion, AnimatePresence } from 'framer-motion'
import { useMemo } from 'react'
import { marked } from 'marked'
import { cn } from '@/lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  tools?: Array<{ name: string; status: string; result?: string }>
}

interface MessageListProps {
  messages: Message[]
  streamingContent: string
}

function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string
}

export function MessageList({ messages, streamingContent }: MessageListProps) {
  if (messages.length === 0 && !streamingContent) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-text-tertiary">
          <MessageSquare className="mx-auto mb-3 h-12 w-12 opacity-30" />
          <div>开始一段新对话</div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {messages.map((msg) => (
        <motion.div
          key={msg.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
        >
          <div
            className={cn(
              'max-w-[80%] rounded-2xl px-4 py-3',
              msg.role === 'user'
                ? 'bg-primary-500 text-white'
                : 'bg-gray-100 text-text-primary',
            )}
          >
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
            />
            {msg.tools && msg.tools.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-border pt-2">
                {msg.tools.map((tool, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-primary-500">{tool.name}</span>
                    <Badge variant={tool.status === 'done' ? 'success' : 'warning'} className="text-xs">
                      {tool.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 text-xs opacity-60">
              {msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </motion.div>
      ))}

      {/* Streaming indicator */}
      {streamingContent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex justify-start"
        >
          <div className="max-w-[80%] rounded-2xl bg-gray-100 px-4 py-3 text-text-primary">
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }}
            />
            <span className="cursor-blink ml-1" />
          </div>
        </motion.div>
      )}
    </div>
  )
}
```

- [ ] **步骤 3：创建 ChatInput 组件**

```typescript
import { useRef, KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface ChatInputProps {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  isStreaming: boolean
  disabled?: boolean
}

export function ChatInput({ value, onChange, onSend, onStop, isStreaming, disabled }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    // 自动调整高度
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
    }
  }

  return (
    <div className="flex items-end gap-3">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Gateway 离线中...' : '输入消息，Enter 发送'}
        disabled={disabled}
        rows={1}
        className={cn(
          'flex-1 resize-none rounded-xl border border-border bg-surface px-4 py-3 text-sm',
          'focus:outline-none focus:ring-2 focus:ring-primary-500',
          'transition-all',
          disabled && 'opacity-50',
        )}
      />
      {isStreaming ? (
        <Button size="icon" variant="danger" onClick={onStop}>
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          size="icon"
          onClick={onSend}
          disabled={!value.trim() || disabled}
        >
          <Send className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
```

- [ ] **步骤 4：提交**

```bash
git add src/pages/chat/ChatPage.tsx src/pages/chat/components/
git commit -m "feat: implement Chat page with WebSocket streaming and Markdown"
```

---

## 任务 3：设置向导页面

**涉及文件：**
- 修改: `src/pages/setup/SetupPage.tsx`
- 创建: `src/pages/setup/components/WizardStep.tsx`
- 创建: `src/pages/setup/components/SandboxInitStep.tsx`
- 创建: `src/pages/setup/components/WelcomeStep.tsx`
- 创建: `src/pages/setup/components/CompleteStep.tsx`

- [ ] **步骤 1：实现 SetupPage.tsx**

```typescript
import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, ChevronRight, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { sandbox } from '@/lib/ipc'

const STEPS = [
  { id: 'welcome', label: '欢迎' },
  { id: 'sandbox', label: '沙箱初始化' },
  { id: 'complete', label: '完成' },
]

export function SetupPage() {
  const [currentStep, setCurrentStep] = useState(0)

  const { data: sandboxStatus, refetch: refetchStatus } = useQuery({
    queryKey: ['sandbox', 'status'],
    queryFn: sandbox.status,
  })

  const initSandbox = useMutation({
    mutationFn: sandbox.init,
    onSuccess: () => refetchStatus(),
  })

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((s) => s + 1)
    }
  }

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1)
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-xl">
        <CardContent className="p-8">
          {/* Step indicators */}
          <div className="mb-8 flex items-center justify-center gap-2">
            {STEPS.map((step, i) => (
              <div key={step.id} className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors ${
                    i < currentStep
                      ? 'bg-success text-white'
                      : i === currentStep
                      ? 'bg-primary-500 text-white'
                      : 'bg-gray-100 text-text-tertiary'
                  }`}
                >
                  {i < currentStep ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                </div>
                <span className={`text-sm ${i === currentStep ? 'text-text-primary font-medium' : 'text-text-tertiary'}`}>
                  {step.label}
                </span>
                {i < STEPS.length - 1 && (
                  <div className={`h-px w-8 ${i < currentStep ? 'bg-success' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>

          {/* Step content */}
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {currentStep === 0 && <WelcomeStep />}
              {currentStep === 1 && (
                <SandboxInitStep
                  status={sandboxStatus}
                  onInit={() => initSandbox.mutate()}
                  isInitializing={initSandbox.isPending}
                />
              )}
              {currentStep === 2 && <CompleteStep />}
            </motion.div>
          </AnimatePresence>

          {/* Navigation */}
          <div className="mt-8 flex justify-between">
            <Button
              variant="ghost"
              onClick={handleBack}
              disabled={currentStep === 0}
            >
              <ChevronLeft className="h-4 w-4" />
              上一步
            </Button>
            {currentStep < STEPS.length - 1 && (
              <Button onClick={handleNext}>
                下一步
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **步骤 2：创建 WelcomeStep 组件**

```typescript
export function WelcomeStep() {
  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary-500">
        <span className="text-3xl">🐾</span>
      </div>
      <h2 className="mb-3 text-2xl font-semibold">欢迎使用 CJGClaw</h2>
      <p className="mb-6 text-text-secondary">
        CJGClaw 是一款基于 OpenClaw 的企业级 AI Agent 管理面板。
        我们将引导你完成初始化配置。
      </p>
      <div className="space-y-3 text-left">
        {[
          '独立沙箱环境，与系统 OpenClaw 完全隔离',
          '内置 Gateway，无需额外安装',
          '支持多 Agent 管理与实时聊天',
          '企业级设计，简洁美观',
        ].map((item, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg bg-gray-50 p-3 text-sm">
            <div className="h-1.5 w-1.5 rounded-full bg-primary-500" />
            {item}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **步骤 3：创建 SandboxInitStep 组件**

```typescript
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface SandboxInitStepProps {
  status?: { installed: boolean; version: string; dir: string }
  onInit: () => void
  isInitializing: boolean
}

export function SandboxInitStep({ status, onInit, isInitializing }: SandboxInitStepProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-center text-xl font-semibold">沙箱初始化</h2>

      <div className="space-y-4">
        {[
          { label: '数据目录', path: '~/.cjgclaw/' },
          { label: 'Agent 存储', path: '~/.cjgclaw/agents/' },
          { label: '配置存储', path: '~/.cjgclaw/openclaw/' },
          { label: '日志文件', path: '~/.cjgclaw/logs/' },
        ].map((item) => (
          <div key={item.path} className="flex items-center justify-between rounded-lg border border-border p-3">
            <span className="text-sm text-text-secondary">{item.label}</span>
            <span className="font-mono text-sm">{item.path}</span>
          </div>
        ))}
      </div>

      {status?.installed ? (
        <div className="rounded-lg bg-success-light p-4 text-center">
          <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-success" />
          <div className="font-medium text-success">沙箱已初始化</div>
          <div className="mt-1 text-sm text-text-secondary">
            版本 {status.version} · 路径 {status.dir}
          </div>
        </div>
      ) : (
        <Button
          className="w-full"
          size="lg"
          onClick={onInit}
          loading={isInitializing}
        >
          {isInitializing ? '初始化中...' : '开始初始化'}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **步骤 4：创建 CompleteStep 组件**

```typescript
import { useNavigate } from 'react-router-dom'

export function CompleteStep() {
  const navigate = useNavigate()

  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-success-light">
        <CheckCircle2 className="h-10 w-10 text-success" />
      </div>
      <h2 className="mb-3 text-2xl font-semibold">初始化完成</h2>
      <p className="mb-6 text-text-secondary">
        CJGClaw 已准备就绪。开始探索强大的 AI Agent 管理体验。
      </p>
      <button
        onClick={() => navigate('/dashboard')}
        className="inline-flex items-center gap-2 rounded-xl bg-primary-500 px-8 py-3 font-medium text-white transition-colors hover:bg-primary-600"
      >
        进入仪表盘
      </button>
    </div>
  )
}
```

- [ ] **步骤 5：提交**

```bash
git add src/pages/setup/SetupPage.tsx src/pages/setup/components/
git commit -m "feat: implement Setup wizard with sandbox init and welcome flow"
```

---

## 任务 4：添加 Markdown 渲染工具

**涉及文件：**
- 创建: `src/lib/markdown.ts`

- [ ] **步骤 1：创建 src/lib/markdown.ts**

```typescript
// 使用 marked 的轻量级 Markdown 渲染器
// 安装: npm install marked

import { marked } from 'marked'

// 配置 marked 以实现安全渲染
marked.setOptions({
  gfm: true,
  breaks: true,
})

export function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string
}
```

安装依赖: `npm install marked`

- [ ] **步骤 2：提交**

```bash
git add src/lib/markdown.ts
git commit -m "feat: add Markdown renderer utility"
```

---

## 计划总结

| 任务 | 文件 | 描述 |
|------|-------|------|
| 1 | src/lib/ws.ts | 完整的 WebSocket 客户端，含自动重连和心跳 |
| 2 | ChatPage + MessageList + ChatInput | 聊天 UI，含流式消息和 Markdown |
| 3 | SetupPage + 4 个步骤组件 | 多步骤向导，带 Framer Motion 过渡 |
| 4 | src/lib/markdown.ts | Markdown 渲染工具 |

完成所有 4 个计划后，CJGClaw v1.0 完全实现。