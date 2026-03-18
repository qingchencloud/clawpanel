export const DOCKER_TASK_TIMEOUT_MS = 10 * 60 * 1000

export function buildDockerDispatchTargets(targets = []) {
  if (!Array.isArray(targets)) return []
  return targets.map(target => ({
    containerId: target.id,
    containerName: target.name,
    nodeId: target.nodeId || null,
  }))
}

export function buildDockerInstanceSwitchContext({ containerId, name, port, gatewayPort, nodeId }) {
  if (!containerId) throw new Error('缺少容器 ID')
  if (!name) throw new Error('缺少容器名称')

  const panelPort = parseRequiredPort(port, '面板端口')
  const parsedGatewayPort = parseOptionalPort(gatewayPort, 18789)

  return {
    instanceId: `docker-${containerId.slice(0, 12)}`,
    reloadRoute: true,
    registration: {
      name,
      type: 'docker',
      endpoint: `http://127.0.0.1:${panelPort}`,
      gatewayPort: parsedGatewayPort,
      containerId,
      nodeId: nodeId || null,
      note: 'Added from Docker page',
    },
  }
}

function parseRequiredPort(value, label) {
  const port = Number.parseInt(value, 10)
  if (Number.isInteger(port) && port > 0) return port
  throw new Error(`${label}无效`)
}

function parseOptionalPort(value, fallback) {
  const port = Number.parseInt(value, 10)
  if (Number.isInteger(port) && port > 0) return port
  return fallback
}
