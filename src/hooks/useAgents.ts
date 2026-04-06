import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { agent } from '@/lib/ipc'
import { toast } from 'sonner'

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: agent.list,
  })
}

export function useAgentCreate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params: { name: string; model?: string }) => agent.create(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Agent 创建成功')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useAgentDelete() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => agent.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Agent 已删除')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useAgentUpdateModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, model }: { id: string; model: string }) => agent.updateModel(id, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (err: Error) => toast.error(err.message),
  })
}
