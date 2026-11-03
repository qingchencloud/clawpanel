// 可信资格工具共用的协议探针分类。只识别已核实请求，不模拟其他服务的能力。
// body：原始 UTF-8 字符串（推荐），或 POST 已解析对象；本地 GET 空体仅 ''/null/undefined，catalog 另接受{}。
// models：本 fixture 明确声明的模型 ID 数组或 Set；详情路径按 encodeURI(model) 精确比较。
// provider 是被探测的协议名，不表示支持该协议；仅 OpenAI catalog200，其余已核探针404。
export function classifyHermesMetadataRequest(method, path, body, models) {
  const result = (provider, status = 404) => ({ kind: 'metadata', status, provider })
  const declared = Array.isArray(models) || models instanceof Set ? [...models] : []
  const validModels = declared.filter(model => typeof model === 'string' && model.length > 0)
  if (method === 'GET' && path === '/v1/models') {
    if (body === '' || body === null || body === undefined) return result('openai-catalog', 200)
    try {
      const value = typeof body === 'string' ? JSON.parse(body) : body
      if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === 0) return result('openai-catalog', 200)
    } catch { /* 非空或非 JSON catalog 请求留给未知请求门禁。 */ }
    return null
  }
  if (method === 'GET' && (body === '' || body === null || body === undefined)) {
    const routes = new Map([['/api/v1/models', 'lm-studio'], ['/api/tags', 'ollama'], ['/v1/props', 'llamacpp'], ['/props', 'llamacpp'], ['/version', 'vllm']])
    if (routes.has(path)) return result(routes.get(path))
    for (const model of validModels) {
      try { if (!/[?#\r\n]/.test(path) && path === '/v1/models/' + encodeURI(model)) return result('openai') } catch { /* 非法 Unicode 模型不是已核路由。 */ }
    }
  }
  if (method === 'POST' && path === '/api/show') {
    try {
      const value = typeof body === 'string' ? JSON.parse(body) : body
      if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
      const keys = Reflect.ownKeys(value), name = Object.getOwnPropertyDescriptor(value, 'name')
      if (keys.length === 1 && keys[0] === 'name' && name?.enumerable && Object.hasOwn(name, 'value') && typeof name.value === 'string' && validModels.includes(name.value)) return result('ollama')
    } catch { /* 非 JSON、额外字段或 accessor 均留给调用方的未知请求红灯。 */ }
  }
  return null
}
