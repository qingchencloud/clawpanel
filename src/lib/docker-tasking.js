export const DOCKER_TASK_TIMEOUT_MS = 10 * 60 * 1000

export function buildDockerDispatchTargets(containers = []) {
  return containers.map(container => ({
    containerId: container.id,
    containerName: container.name,
    nodeId: container.nodeId,
  }))
}

export function buildDockerInstanceSwitchContext(container = {}) {
  const containerId = String(container.containerId || container.id || '')
  const port = Number(container.port)
  const gatewayPort = Number(container.gatewayPort)
  const instanceId = `docker-${containerId.slice(0, 12)}`

  return {
    instanceId,
    reloadRoute: true,
    registration: {
      name: container.name,
      type: 'docker',
      endpoint: `http://127.0.0.1:${port}`,
      gatewayPort,
      containerId,
      nodeId: container.nodeId,
      note: 'Added from Docker page',
    },
  }
}
