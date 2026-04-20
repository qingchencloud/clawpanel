/**
 * 模型调用运行时错误诊断
 *
 * 针对常见本地部署场景（vLLM / llama.cpp / Ollama / LM Studio 等）
 * 把晦涩的服务端报错转成用户可操作的修复指引。
 *
 * 与 error-diagnosis.js 的区别：
 * - error-diagnosis.js 针对 npm install / upgrade 等安装期错误
 * - 本文件针对模型调用运行时错误（400/422/不支持 tools 等）
 */

/**
 * 识别并增强模型调用错误消息。保留原文 + 附加诊断和修复建议。
 *
 * @param {string|Error|unknown} err - 原始错误（字符串或 Error）
 * @returns {string} 增强后的错误消息（可能是原文，也可能带了修复指引）
 */
export function enhanceModelCallError(err) {
  const msg = typeof err === 'string' ? err : (err?.message || String(err))
  const s = msg.toLowerCase()

  // ── vLLM: 工具调用需要启动参数 ──
  // 典型错误消息示例：
  //   `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`
  //   `--enable-auto-tool-choice must be set`
  if (
    s.includes('enable-auto-tool-choice') ||
    s.includes('tool-call-parser') ||
    (s.includes('tool choice') && s.includes('requires'))
  ) {
    return (
      msg +
      '\n\n' +
      '💡 这是 vLLM 服务端配置限制（不是 ClawPanel / OpenClaw 的 bug）：\n' +
      'vLLM 默认禁用工具调用，必须在启动时显式开启。请以如下方式重启 vLLM：\n\n' +
      '  vllm serve <your-model> \\\n' +
      '    --enable-auto-tool-choice \\\n' +
      '    --tool-call-parser hermes\n\n' +
      '不同模型系列建议的 parser：\n' +
      '  • Qwen2.5 / Qwen3 / Hermes 系列 → --tool-call-parser hermes\n' +
      '  • Mistral / Mixtral 系列 → --tool-call-parser mistral\n' +
      '  • Llama 3 / 3.1 / 3.2 系列 → --tool-call-parser llama3_json\n\n' +
      '或者在助手右上角切换到「聊天」模式（不带工具）临时规避。'
    )
  }

  // ── llama.cpp / LM Studio: 旧版本不支持工具调用 ──
  if (
    (s.includes('grammar') && s.includes('tools')) ||
    (s.includes('llama') && s.includes('tools') && s.includes('not supported'))
  ) {
    return (
      msg +
      '\n\n' +
      '💡 当前 llama.cpp / LM Studio 版本可能不支持原生工具调用。\n' +
      '请升级到支持 --chat-template-kwargs 的新版本，\n' +
      '或在助手右上角切换到「聊天」模式（不带工具）临时规避。'
    )
  }

  // ── Ollama: 该模型不支持 tools ──
  // 典型错误：`registry.ollama.ai/library/llama2:latest does not support tools`
  if (
    s.includes('does not support tools') ||
    (s.includes('model') && s.includes('does not support') && s.includes('tool'))
  ) {
    return (
      msg +
      '\n\n' +
      '💡 当前 Ollama 模型不支持工具调用。\n' +
      '请换成支持 tools 的模型，推荐：\n' +
      '  • qwen2.5（各 size）\n' +
      '  • llama3.1 / llama3.2\n' +
      '  • mistral-nemo / mixtral\n\n' +
      '或在助手右上角切换到「聊天」模式（不带工具）临时规避。'
    )
  }

  // ── 模型 ID 不存在 / 404 ──
  // 尽量避免误伤：只有错误文本同时含 "model" 和明确的 not-found 信号才匹配
  if (
    s.includes('model') &&
    (s.includes('not found') || s.includes('does not exist') || s.includes('no such model'))
  ) {
    return (
      msg +
      '\n\n' +
      '💡 服务端找不到指定的模型 ID。\n' +
      '请到模型配置页确认：\n' +
      '  1. 模型 ID 是否与服务端实际加载的一致（大小写敏感）\n' +
      '  2. 服务端是否已加载该模型（vLLM/Ollama 都需要预加载）'
    )
  }

  // ── 上下文过长 ──
  if (
    s.includes('context length') ||
    s.includes('maximum context') ||
    s.includes('token limit') ||
    (s.includes('too many tokens') && s.includes('context'))
  ) {
    return (
      msg +
      '\n\n' +
      '💡 消息长度超过模型的上下文窗口。\n' +
      '可以：\n' +
      '  1. 在助手里点「新会话」开启新对话\n' +
      '  2. 换一个更大窗口的模型\n' +
      '  3. vLLM 启动时用 --max-model-len 指定更大窗口'
    )
  }

  return msg
}
