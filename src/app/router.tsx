import { createBrowserRouter, Outlet, Navigate } from 'react-router-dom'
import { PageContainer } from '@/components/layout/PageContainer'

// Layout wrapper
function Layout() {
  return (
    <PageContainer>
      <Outlet />
    </PageContainer>
  )
}

// Page stubs - import from the actual files
import { DashboardPage } from '@/pages/dashboard/DashboardPage'
import { ServicesPage } from '@/pages/services/ServicesPage'
import { ModelsPage } from '@/pages/models/ModelsPage'
import { ChatPage } from '@/pages/chat/ChatPage'
import { AgentsPage } from '@/pages/agents/AgentsPage'
import { GatewayPage } from '@/pages/gateway/GatewayPage'
import { SkillsPage } from '@/pages/skills/SkillsPage'
import { ExtensionsPage } from '@/pages/extensions/ExtensionsPage'
import { SetupPage } from '@/pages/setup/SetupPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/services', element: <ServicesPage /> },
      { path: '/models', element: <ModelsPage /> },
      { path: '/chat', element: <ChatPage /> },
      { path: '/agents', element: <AgentsPage /> },
      { path: '/gateway', element: <GatewayPage /> },
      { path: '/skills', element: <SkillsPage /> },
      { path: '/extensions', element: <ExtensionsPage /> },
      { path: '/setup', element: <SetupPage /> },
    ],
  },
])
