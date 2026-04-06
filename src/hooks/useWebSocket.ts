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
