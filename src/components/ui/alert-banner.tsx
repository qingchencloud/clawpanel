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
