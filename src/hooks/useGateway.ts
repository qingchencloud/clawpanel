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
