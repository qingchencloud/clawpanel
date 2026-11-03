// 已安装的飞书实现优先，不在保存渠道配置时偷偷迁移或启用第二个实现。
export function selectFeishuPlugin(official = {}, lark = {}) {
  const present = status => status.installed || status.builtin
  if (present(official) && official.enabled && present(lark) && lark.enabled) {
    throw new Error('飞书存在两个已启用的插件（feishu / openclaw-lark），请先在插件管理中保留一个，再保存配置。')
  }
  if (present(lark) && (!present(official) || !official.enabled)) {
    return { pluginId: 'openclaw-lark', packageName: '@larksuite/openclaw-lark@latest', status: lark }
  }
  return { pluginId: 'feishu', packageName: '@openclaw/feishu@latest', status: official }
}
