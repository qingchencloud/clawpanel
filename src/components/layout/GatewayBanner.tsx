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
            disabled={start.isPending}
          >
            {start.isPending ? '启动中...' : '启动'}
          </Button>
        }
        onDismiss={() => setDismissed(true)}
      />
    )
  }

  return null
}
