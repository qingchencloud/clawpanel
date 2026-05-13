/**
 * ClawPanel Web Push Service Worker
 *
 * 接收来自 OpenClaw 内核（通过 web-push 协议）的推送，
 * 调 showNotification 弹出系统级通知（即使 ClawPanel 已关闭）。
 *
 * 点通知 → 尝试聚焦已打开的 ClawPanel 标签；都没开就打开一个新窗口。
 */

self.addEventListener('install', (event) => {
  // 立刻激活，不等老 SW 退出
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // 立刻接管所有已打开的客户端
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    if (event.data) {
      // 优先按 JSON 解析；失败时把整段文本当 body
      try {
        payload = event.data.json()
      } catch (_) {
        payload = { body: event.data.text() }
      }
    }
  } catch (_) {
    payload = {}
  }

  const title = payload.title || 'ClawPanel'
  const body = payload.body || ''
  const url = payload.url || payload.click_action || '/'

  const options = {
    body,
    icon: payload.icon || '/icon.png',
    badge: payload.badge || '/icon.png',
    tag: payload.tag || 'clawpanel',
    data: { url },
    requireInteraction: !!payload.requireInteraction,
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification?.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      // 已有 ClawPanel 标签 → 聚焦 + 跳到 targetUrl
      for (const client of clientsList) {
        if ('focus' in client) {
          try {
            client.postMessage({ type: 'push-navigate', url: targetUrl })
          } catch (_) {}
          return client.focus()
        }
      }
      // 没有任何 ClawPanel 窗口 → 开一个新窗口
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })
  )
})
