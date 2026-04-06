import { useLocation } from 'react-router-dom'

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
