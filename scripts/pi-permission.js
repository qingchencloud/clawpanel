/** 由受管 Pi 显式加载；默认关闭项目扩展，写入/命令逐次确认。工作目录不是 OS 沙箱。 */
export const PI_PERMISSION_SOURCE = `
import fs from 'node:fs'
import path from 'node:path'
export default function (pi) {
  pi.on('tool_call', async (event, ctx) => {
    const workspace = fs.realpathSync(process.cwd())
    const privateRoot = process.env.CLAWPANEL_PI_PRIVATE_ROOT
    const target = event.input?.path
    if (typeof target === 'string') {
      let resolved = path.resolve(workspace, target)
      let parent = resolved
      while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent)
      resolved = path.join(fs.realpathSync(parent), path.relative(parent, resolved))
      const relative = path.relative(workspace, resolved)
      const privateRelative = privateRoot ? path.relative(privateRoot, resolved) : '..'
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
          || (privateRoot && privateRelative !== '..' && !privateRelative.startsWith('..' + path.sep) && !path.isAbsolute(privateRelative))) {
        return { block: true, reason: 'ClawPanel: path outside workspace or inside private configuration' }
      }
    }
    if (!['edit', 'write', 'bash', 'powershell'].includes(event.toolName)) return
    if (process.env.CLAWPANEL_PI_ALLOW_TOOLS !== '1') return { block: true, reason: 'ClawPanel: write/command tools are disabled' }
    const confirmed = await ctx.ui.confirm('ClawPanel · ' + event.toolName, JSON.stringify(event.input, null, 2))
    if (!confirmed) return { block: true, reason: 'ClawPanel: user cancelled tool execution' }
  })
}
`
