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
