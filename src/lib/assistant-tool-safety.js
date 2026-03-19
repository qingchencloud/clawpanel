export const ASSISTANT_INTERACTIVE_TOOLS = new Set(['ask_user'])
export const ASSISTANT_DANGEROUS_TOOLS = new Set(['run_command', 'write_file', 'skills_install_dep', 'skills_clawhub_install'])

const ASSISTANT_CRITICAL_PATTERNS = [
  /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?[\/~]/i,
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\//i,
  /format\s+[a-zA-Z]:/i,
  /mkfs\./i,
  /dd\s+.*of=\/dev\//i,
  />\s*\/dev\/[sh]d/i,
  /DROP\s+(DATABASE|TABLE|SCHEMA)/i,
  /TRUNCATE\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;?\s*$/i,
  /:(){ :\|:& };:/,
  /shutdown|reboot|init\s+[06]/i,
  /chmod\s+(-R\s+)?777\s+\//i,
  /chown\s+(-R\s+)?.*\s+\//i,
  /curl\s+.*\|\s*(sudo\s+)?bash/i,
  /wget\s+.*\|\s*(sudo\s+)?bash/i,
  /npm\s+publish/i,
  /git\s+push\s+.*--force-with-lease/i,
  /rmdir\s+\/s\s+\/q/i,
  /rd\s+\/s\s+\/q/i,
  /del\s+\/s\s+\/q/i,
  /diskpart/i,
  /bcdedit/i,
  /reg\s+delete/i,
]

export function isAssistantCriticalCommand(command) {
  if (!command) return false
  return ASSISTANT_CRITICAL_PATTERNS.some(p => p.test(command))
}

export function buildAssistantToolConfirmText(toolCall, critical = false) {
  const name = toolCall?.function?.name || ''
  let args = {}
  try { args = JSON.parse(toolCall?.function?.arguments || '{}') } catch { args = {} }

  let desc = ''
  if (name === 'run_command') {
    desc = `执行命令:\n\n${args.command || ''}${args.cwd ? '\n\n工作目录: ' + args.cwd : ''}`
  } else if (name === 'write_file') {
    const preview = (args.content || '').slice(0, 200)
    desc = `写入文件:\n${args.path || ''}\n\n内容预览:\n${preview}${(args.content || '').length > 200 ? '\n...(已截断)' : ''}`
  }

  const prefix = critical
    ? '⛔ 安全围栏拦截 — 此命令被识别为极端危险操作！\n\n'
    : ''

  return `${prefix}AI 请求执行以下操作:\n\n${desc}\n\n是否允许？`
}

export function resolveAssistantToolApproval(toolName, args, mode) {
  const critical = toolName === 'run_command' && isAssistantCriticalCommand(args?.command)
  if (critical) return { needsConfirm: true, critical, deniedText: '用户拒绝了此危险操作' }
  if (mode?.confirmDanger && ASSISTANT_DANGEROUS_TOOLS.has(toolName)) {
    return { needsConfirm: true, critical: false, deniedText: '用户拒绝了此操作' }
  }
  return { needsConfirm: false, critical: false, deniedText: '' }
}
