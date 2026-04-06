# CJGClaw Management Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all 7 management pages (Dashboard, Services, Models, Agents, Gateway, Skills, Extensions) in React 19 with the CJGClaw design system — replacing the existing vanilla JS pages. Each page uses TanStack Query hooks from Plan 1 and Framer Motion animations.

**Architecture:** Each page is a React component with local state via TanStack Query + Zustand. Pages follow the CJGClaw design spec: teal primary (#2C8E65), dark sidebar (#1A2E28), Geist Sans + Noto Sans SC fonts, 240px sidebar, skeleton loading, error inline cards, status badge pulses.

**Tech Stack:** React 19, TypeScript, TanStack Query v5, Zustand, Framer Motion v11, shadcn/ui, Lucide icons

---

### Task 1: Dashboard Page

**Files:**
- Modify: `src/pages/dashboard/DashboardPage.tsx`
- Create: `src/pages/dashboard/components/StatsGrid.tsx`
- Create: `src/pages/dashboard/components/QuickActions.tsx`
- Create: `src/pages/dashboard/components/RecentActivity.tsx`

- [ ] **Step 1: Implement DashboardPage.tsx with skeleton loading**

```typescript
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Activity, Bot, Server, Zap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { gateway } from '@/lib/ipc'
import { agent } from '@/lib/ipc'

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
}
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
}

export function DashboardPage() {
  const { data: gwStatus, isLoading: gwLoading } = useQuery({
    queryKey: ['gateway', 'status'],
    queryFn: gateway.status,
    refetchInterval: 5000,
  })

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: agent.list,
  })

  const { data: config } = useQuery({
    queryKey: ['config', 'summary'],
    queryFn: () => gateway.status(),
  })

  const isLoading = gwLoading || agentsLoading

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-6"
    >
      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <motion.div variants={item}>
          <StatsCard
            title="Gateway 状态"
            value={gwStatus?.running ? '运行中' : '已停止'}
            icon={Server}
            variant={gwStatus?.running ? 'success' : 'error'}
            pulse={gwStatus?.running}
            isLoading={isLoading}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatsCard
            title="Agent 数量"
            value={agents?.length ?? 0}
            icon={Bot}
            isLoading={isLoading}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatsCard
            title="端口"
            value={gwStatus?.port ?? 28790}
            icon={Activity}
            isLoading={isLoading}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatsCard
            title="版本"
            value="v1.0.0"
            icon={Zap}
            isLoading={false}
          />
        </motion.div>
      </div>

      {/* Quick Actions */}
      <motion.div variants={item}>
        <QuickActions gatewayRunning={gwStatus?.running ?? false} />
      </motion.div>

      {/* Agent Overview */}
      <motion.div variants={item}>
        <AgentsOverview agents={agents ?? []} isLoading={isLoading} />
      </motion.div>
    </motion.div>
  )
}
```

- [ ] **Step 2: Create StatsCard component**

```typescript
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface StatsCardProps {
  title: string
  value: string | number
  icon: React.ElementType
  variant?: 'default' | 'success' | 'error'
  pulse?: boolean
  isLoading?: boolean
}

const variantStyles = {
  default: 'text-text-primary',
  success: 'text-success',
  error: 'text-error',
}

const variantBadgeStyles = {
  default: 'bg-gray-100 text-gray-600',
  success: 'bg-success-light text-success',
  error: 'bg-error-light text-error',
}

export function StatsCard({ title, value, icon: Icon, variant = 'default', pulse, isLoading }: StatsCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-5">
          <Skeleton className="h-4 w-20 mb-3" />
          <Skeleton className="h-8 w-16" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="hover:shadow-card-hover transition-shadow">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">{title}</span>
          <Icon className={cn('h-4 w-4', variantStyles[variant])} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className={cn('text-2xl font-semibold', variantStyles[variant])}>{value}</span>
          {pulse && <span className="pulse-ring h-2 w-2 rounded-full bg-success" />}
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: Create QuickActions component**

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Square, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { gateway } from '@/lib/ipc'
import { toast } from 'sonner'

export function QuickActions({ gatewayRunning }: { gatewayRunning: boolean }) {
  const qc = useQueryClient()

  const startGw = useMutation({
    mutationFn: gateway.start,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gateway'] })
      toast.success('Gateway 已启动')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const stopGw = useMutation({
    mutationFn: gateway.stop,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gateway'] })
      toast.success('Gateway 已停止')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const restartGw = useMutation({
    mutationFn: gateway.restart,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gateway'] })
      toast.success('Gateway 已重启')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="flex flex-wrap gap-3">
      {gatewayRunning ? (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => stopGw.mutate()}
            loading={stopGw.isPending}
          >
            <Square className="h-4 w-4" />
            停止
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => restartGw.mutate()}
            loading={restartGw.isPending}
          >
            <RefreshCw className="h-4 w-4" />
            重启
          </Button>
        </>
      ) : (
        <Button
          variant="default"
          size="sm"
          onClick={() => startGw.mutate()}
          loading={startGw.isPending}
        >
          <Play className="h-4 w-4" />
          启动
        </Button>
      )}
      <Button variant="outline" size="sm">
        <RotateCcw className="h-4 w-4" />
        创建备份
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Create AgentsOverview component**

```typescript
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

export function AgentsOverview({ agents, isLoading }: { agents: Array<{ id: string; name: string; model?: string }>; isLoading: boolean }) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent 概览</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent 概览</CardTitle>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <div className="py-8 text-center text-text-tertiary">
            暂无 Agent
          </div>
        ) : (
          <div className="space-y-2">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-border p-3 hover:bg-surface-raised transition-colors">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold text-sm">
                    {a.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <div className="font-medium text-sm">{a.name}</div>
                    <div className="text-xs text-text-tertiary">{a.id}</div>
                  </div>
                </div>
                {a.model && <Badge variant="secondary">{a.model}</Badge>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/dashboard/DashboardPage.tsx src/pages/dashboard/components/
git commit -m "feat: implement Dashboard page with stats grid, quick actions, agent overview"
```

---

### Task 2: Services Page

**Files:**
- Modify: `src/pages/services/ServicesPage.tsx`
- Create: `src/pages/services/components/ServiceList.tsx`

- [ ] **Step 1: Implement ServicesPage.tsx**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { service } from '@/lib/ipc'
import { toast } from 'sonner'

export function ServicesPage() {
  const qc = useQueryClient()
  const { data: services, isLoading } = useQuery({
    queryKey: ['services'],
    queryFn: service.list,
    refetchInterval: 10000,
  })

  const startService = useMutation({
    mutationFn: service.start,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] })
      toast.success('服务已启动')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const stopService = useMutation({
    mutationFn: service.stop,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] })
      toast.success('服务已停止')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const restartService = useMutation({
    mutationFn: service.restart,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] })
      toast.success('服务已重启')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">服务管理</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries({ queryKey: ['services'] })}
        >
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {services?.map((svc) => (
            <Card key={svc.label}>
              <CardContent className="flex items-center justify-between p-5">
                <div className="flex items-center gap-4">
                  <div className={`h-3 w-3 rounded-full ${svc.running ? 'bg-success pulse-ring' : 'bg-gray-300'}`} />
                  <div>
                    <div className="font-medium">{svc.label}</div>
                    <div className="text-sm text-text-secondary">{svc.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={svc.running ? 'success' : 'secondary'}>
                    {svc.running ? '运行中' : '已停止'}
                  </Badge>
                  {svc.running ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => stopService.mutate(svc.label)}
                    >
                      停止
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => startService.mutate(svc.label)}
                    >
                      启动
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => restartService.mutate(svc.label)}
                  >
                    重启
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </motion.div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/services/ServicesPage.tsx
git commit -m "feat: implement Services page with service list and controls"
```

---

### Task 3: Models Page

**Files:**
- Modify: `src/pages/models/ModelsPage.tsx`
- Create: `src/pages/models/components/ModelCard.tsx`
- Create: `src/pages/models/components/ModelTestDialog.tsx`

- [ ] **Step 1: Implement ModelsPage.tsx**

```typescript
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Plus, TestTube } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { config, model } from '@/lib/ipc'
import { toast } from 'sonner'

export function ModelsPage() {
  const qc = useQueryClient()
  const [testDialogOpen, setTestDialogOpen] = useState(false)
  const [testingModel, setTestingModel] = useState<{ provider: string; model: string } | null>(null)

  const { data: cfg, isLoading } = useQuery({
    queryKey: ['config', 'openclaw'],
    queryFn: config.read,
  })

  const testModel = useMutation({
    mutationFn: model.test,
    onSuccess: (result) => {
      if (result.success) {
        toast.success(`连接成功，延迟 ${result.latency_ms}ms`)
      } else {
        toast.error(result.error ?? '测试失败')
      }
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setTestDialogOpen(false)
      setTestingModel(null)
    },
  })

  const models: Array<{ provider: string; models: string[] }> = cfg?.models ?? []

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">模型配置</h2>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : models.length === 0 ? (
        <Card className="py-12 text-center">
          <div className="text-text-tertiary mb-4">暂无模型配置</div>
          <Button>
            <Plus className="h-4 w-4" />
            添加模型
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((prov) =>
            prov.models.map((m) => (
              <Card key={`${prov.provider}-${m}`} className="hover:shadow-card-hover transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <Badge variant="info">{prov.provider}</Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setTestingModel({ provider: prov.provider, model: m })
                        setTestDialogOpen(true)
                      }}
                    >
                      <TestTube className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="font-medium">{m}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="success">已启用</Badge>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </motion.div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/models/ModelsPage.tsx
git commit -m "feat: implement Models page with provider cards and test connectivity"
```

---

### Task 4: Agents Page (CRUD)

**Files:**
- Modify: `src/pages/agents/AgentsPage.tsx`

- [ ] **Step 1: Implement AgentsPage.tsx with full CRUD**

```typescript
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Trash2, Pencil } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useAgentCreate, useAgentDelete, useAgentUpdateModel, useAgents } from '@/hooks/useAgents'
import { toast } from 'sonner'
import { agent } from '@/lib/ipc'

export function AgentsPage() {
  const qc = useQueryClient()
  const { data: agents, isLoading } = useAgents()
  const createAgent = useAgentCreate()
  const deleteAgent = useAgentDelete()
  const updateModel = useAgentUpdateModel()

  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editModel, setEditModel] = useState('')

  const handleCreate = () => {
    if (!newName.trim()) return
    createAgent.mutate({ name: newName.trim() })
    setNewName('')
  }

  const handleEdit = (id: string, currentModel: string) => {
    setEditingId(id)
    setEditModel(currentModel ?? '')
  }

  const handleSaveEdit = () => {
    if (!editingId) return
    updateModel.mutate({ id: editingId, model: editModel })
    setEditingId(null)
  }

  const handleDelete = (id: string) => {
    if (!confirm('确定删除此 Agent？')) return
    deleteAgent.mutate(id)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Agent 管理</h2>
        <Button onClick={() => createAgent.mutate({ name: `agent-${Date.now()}` })}>
          <Plus className="h-4 w-4" />
          新建 Agent
        </Button>
      </div>

      {/* Create form */}
      <Card>
        <CardContent className="p-5">
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Agent 名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <Button onClick={handleCreate} loading={createAgent.isPending}>
              创建
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Agent list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {agents?.map((a) => (
              <motion.div
                key={a.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <Card className="hover:shadow-card-hover transition-shadow">
                  <CardContent className="flex items-center justify-between p-5">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 font-semibold">
                        {a.name[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-text-tertiary font-mono">{a.id}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {editingId === a.id ? (
                        <>
                          <input
                            type="text"
                            value={editModel}
                            onChange={(e) => setEditModel(e.target.value)}
                            className="rounded border border-border px-2 py-1 text-sm"
                          />
                          <Button size="sm" onClick={handleSaveEdit}>保存</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                        </>
                      ) : (
                        <>
                          <Badge variant="secondary">{a.model ?? '未设置模型'}</Badge>
                          <Button variant="ghost" size="icon" onClick={() => handleEdit(a.id, a.model ?? '')}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(a.id)}
                        className="text-error hover:text-error"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/agents/AgentsPage.tsx
git commit -m "feat: implement Agents page with create/edit/delete CRUD"
```

---

### Task 5: Gateway Page

**Files:**
- Modify: `src/pages/gateway/GatewayPage.tsx`

- [ ] **Step 1: Implement GatewayPage.tsx**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Play, Square, RefreshCw, Settings } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useGatewayStatus, useGatewayStart, useGatewayStop, useGatewayRestart, useGuardianStatus } from '@/hooks/useGateway'
import { toast } from 'sonner'

export function GatewayPage() {
  const qc = useQueryClient()
  const { data: status, isLoading } = useGatewayStatus()
  const { data: guardian } = useGuardianStatus()
  const start = useGatewayStart()
  const stop = useGatewayStop()
  const restart = useGatewayRestart()

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>网关状态</CardTitle>
            <Badge variant={status?.running ? 'success' : 'error'}>
              {status?.running ? '运行中' : '已停止'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-20" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-sm text-text-secondary">端口</div>
                  <div className="text-lg font-mono">{status?.port ?? 28790}</div>
                </div>
                <div>
                  <div className="text-sm text-text-secondary">PID</div>
                  <div className="text-lg font-mono">{status?.pid ?? '-'}</div>
                </div>
                <div>
                  <div className="text-sm text-text-secondary">自动重启</div>
                  <div className="text-lg">{guardian?.auto_restart_count ?? 0} / {guardian?.max_auto_restarts ?? 3}</div>
                </div>
                <div>
                  <div className="text-sm text-text-secondary">手动保持</div>
                  <div className="text-lg">{guardian?.manual_hold ? '是' : '否'}</div>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                {status?.running ? (
                  <>
                    <Button onClick={() => stop.mutate()} loading={stop.isPending}>
                      <Square className="h-4 w-4" />
                      停止
                    </Button>
                    <Button variant="outline" onClick={() => restart.mutate()} loading={restart.isPending}>
                      <RefreshCw className="h-4 w-4" />
                      重启
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => start.mutate()} loading={start.isPending}>
                    <Play className="h-4 w-4" />
                    启动
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Guardian Status */}
      {guardian && (
        <Card>
          <CardHeader>
            <CardTitle>守护状态</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">自动重启次数</span>
                <span>{guardian.auto_restart_count} / {guardian.max_auto_restarts}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">手动保持</span>
                <span>{guardian.manual_hold ? '是' : '否'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">放弃恢复</span>
                <Badge variant={guardian.give_up ? 'error' : 'success'}>
                  {guardian.give_up ? '是' : '否'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/gateway/GatewayPage.tsx
git commit -m "feat: implement Gateway page with status monitor and controls"
```

---

### Task 6: Skills Page

**Files:**
- Modify: `src/pages/skills/SkillsPage.tsx`

- [ ] **Step 1: Implement SkillsPage.tsx**

```typescript
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Trash2, Download, RefreshCw, Info } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { skills } from '@/lib/ipc'
import { toast } from 'sonner'

export function SkillsPage() {
  const qc = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ slug: string; name: string; description: string }>>([])
  const [searching, setSearching] = useState(false)

  const { data: skillsData, isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: skills.list,
  })

  const uninstallSkill = useMutation({
    mutationFn: skills.uninstall,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success('已卸载')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const skillhubSearch = useMutation({
    mutationFn: skills.skillhubSearch,
    onSuccess: (data) => setSearchResults(data.results),
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setSearching(false),
  })

  const skillhubInstall = useMutation({
    mutationFn: skills.skillhubInstall,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      toast.success('安装成功')
      setSearchResults([])
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const handleSearch = () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    skillhubSearch.mutate(searchQuery)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Skills 管理</h2>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-5">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
              <input
                type="text"
                placeholder="搜索 SkillHub..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="w-full rounded-lg border border-border py-2 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <Button onClick={handleSearch} loading={searching}>
              搜索
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>搜索结果</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {searchResults.map((r) => (
              <div key={r.slug} className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-sm text-text-secondary">{r.description}</div>
                </div>
                <Button
                  size="sm"
                  onClick={() => skillhubInstall.mutate(r.slug)}
                  loading={skillhubInstall.isPending}
                >
                  <Download className="h-4 w-4" />
                  安装
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Installed Skills */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>已安装</CardTitle>
            <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ['skills'] })}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
            </div>
          ) : skillsData?.skills?.length === 0 ? (
            <div className="py-8 text-center text-text-tertiary">
              暂无已安装的 Skills
            </div>
          ) : (
            <div className="space-y-2">
              {skillsData?.skills?.map((s) => (
                <div key={s.name} className="flex items-center justify-between rounded-lg border border-border p-3 hover:bg-surface-raised">
                  <div className="flex items-center gap-3">
                    <Info className="h-4 w-4 text-text-tertiary" />
                    <div>
                      <div className="font-medium text-sm">{s.name}</div>
                      {s.description && <div className="text-xs text-text-secondary">{s.description}</div>}
                    </div>
                    {s.version && <Badge variant="secondary">v{s.version}</Badge>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => uninstallSkill.mutate(s.name)}
                    className="text-error hover:text-error"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/skills/SkillsPage.tsx
git commit -m "feat: implement Skills page with search and install"
```

---

### Task 7: Extensions Page

**Files:**
- Modify: `src/pages/extensions/ExtensionsPage.tsx`

- [ ] **Step 1: Implement ExtensionsPage.tsx**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Play, Square, Terminal, Bot, Download, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { extensions } from '@/lib/ipc'
import { toast } from 'sonner'

export function ExtensionsPage() {
  const qc = useQueryClient()

  const { data: tunnelStatus, isLoading: tunnelLoading } = useQuery({
    queryKey: ['extensions', 'cftunnel'],
    queryFn: extensions.cftunnelStatus,
    refetchInterval: 5000,
  })

  const { data: clawappStatus, isLoading: clawappLoading } = useQuery({
    queryKey: ['extensions', 'clawapp'],
    queryFn: extensions.clawappStatus,
  })

  const tunnelAction = useMutation({
    mutationFn: extensions.cftunnelAction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions'] })
      toast.success('操作成功')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const installCftunnel = useMutation({
    mutationFn: extensions.installCftunnel,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions'] })
      toast.success('安装完成')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const installClawapp = useMutation({
    mutationFn: extensions.installClawapp,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions'] })
      toast.success('安装完成')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const isLoading = tunnelLoading || clawappLoading

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">扩展工具</h2>
        <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ['extensions'] })}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>

      {/* CfTunnel */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Terminal className="h-5 w-5" />
              <CardTitle>CfTunnel</CardTitle>
            </div>
            <Badge variant={tunnelStatus?.running ? 'success' : 'secondary'}>
              {tunnelStatus?.running ? '运行中' : '已停止'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <div className="space-y-4">
              {tunnelStatus?.tunnel_url && (
                <div className="rounded-lg bg-gray-50 p-3 font-mono text-sm break-all">
                  {tunnelStatus.tunnel_url}
                </div>
              )}
              <div className="flex gap-3">
                {tunnelStatus?.running ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => tunnelAction.mutate('stop')}
                    loading={tunnelAction.isPending}
                  >
                    <Square className="h-4 w-4" />
                    停止
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => tunnelAction.mutate('start')}
                    loading={tunnelAction.isPending}
                  >
                    <Play className="h-4 w-4" />
                    启动
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ClawApp */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bot className="h-5 w-5" />
              <CardTitle>ClawApp</CardTitle>
            </div>
            <Badge variant={clawappStatus?.installed ? 'success' : 'secondary'}>
              {clawappStatus?.installed ? `v${clawappStatus.version ?? ''}` : '未安装'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {clawappLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <div className="flex items-center justify-between">
              <div className="text-sm text-text-secondary">
                ClawApp 内网穿透客户端
              </div>
              {!clawappStatus?.installed && (
                <Button
                  size="sm"
                  onClick={() => installClawapp.mutate()}
                  loading={installClawapp.isPending}
                >
                  <Download className="h-4 w-4" />
                  安装
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/extensions/ExtensionsPage.tsx
git commit -m "feat: implement Extensions page with cftunnel and clawapp controls"
```

---

## Plan Summary

| Task | Pages | Description |
|------|-------|-------------|
| 1 | Dashboard | Stats grid, quick actions, agent overview |
| 2 | Services | Service list with start/stop/restart |
| 3 | Models | Model cards with provider grouping and test |
| 4 | Agents | Full CRUD with create/edit/delete |
| 5 | Gateway | Status monitor and guardian info |
| 6 | Skills | Installed list + SkillHub search/install |
| 7 | Extensions | CfTunnel and ClawApp controls |

After this plan, all 7 management pages are functional. Plan 4 covers Chat + Setup wizard.