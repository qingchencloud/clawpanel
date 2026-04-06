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
