import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { config, model } from '@/lib/ipc'
import { toast } from 'sonner'

export function useOpenClawConfig() {
  return useQuery({
    queryKey: ['config', 'openclaw'],
    queryFn: config.read,
  })
}

export function useOpenClawConfigWrite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: Record<string, unknown>) => config.write(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] })
      toast.success('配置已保存')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useModelTest() {
  return useMutation({
    mutationFn: model.test,
  })
}

export function useListRemoteModels() {
  return useMutation({
    mutationFn: model.listRemote,
  })
}
