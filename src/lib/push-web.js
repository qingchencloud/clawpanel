/**
 * Web Push 推送通知封装（P1-0）
 *
 * 对接 OpenClaw 内核的 4 个 push.web.* RPC，让 ClawPanel 关掉也能弹系统通知。
 */
import { wsClient } from './ws-client.js'

const SW_URL = '/push-sw.js'
const SW_SCOPE = '/'
const STATE_KEY = 'clawpanel.push.subscribed'

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function pushPermission() {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export async function requestPushPermission() {
  if (!isPushSupported()) throw new Error('当前环境不支持 Web Push')
  return await Notification.requestPermission()
}

async function ensureServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('当前环境不支持 Service Worker')
  const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE)
  if (existing) return existing
  return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
}

// base64url → Uint8Array（PushManager.subscribe 需要二进制 VAPID 公钥）
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

// ArrayBuffer → base64url（订阅完后把 keys 编码发给内核）
function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 拿当前 PushSubscription（已订阅时返回对象，未订阅时 null）
 */
export async function getCurrentSubscription() {
  if (!isPushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE)
    if (!reg) return null
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

/**
 * 完整订阅流程：注册 SW → 拿 VAPID → PushManager.subscribe → 上报内核
 */
export async function subscribePush() {
  if (!isPushSupported()) throw new Error('当前环境不支持 Web Push')

  // 1) 权限
  const perm = pushPermission()
  if (perm === 'denied') {
    throw new Error('通知权限已被拒绝，请在浏览器/系统设置里手动放开')
  }
  if (perm !== 'granted') {
    const result = await requestPushPermission()
    if (result !== 'granted') throw new Error('用户拒绝了通知权限')
  }

  // 2) 注册 SW
  const reg = await ensureServiceWorker()

  // 3) 拿 VAPID 公钥（如果已订阅就跳过重新订阅）
  const existing = await reg.pushManager.getSubscription()
  if (existing) {
    // 已订阅；确保内核也有记录（兜底再发一次 subscribe）
    await reportToKernel(existing)
    localStorage.setItem(STATE_KEY, '1')
    return existing
  }

  const vapidResp = await wsClient.request('push.web.vapidPublicKey', {})
  const vapidPublicKey = vapidResp?.vapidPublicKey
  if (!vapidPublicKey) throw new Error('内核未返回 VAPID 公钥（可能未配置 web push）')

  // 4) PushManager.subscribe
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  })

  // 5) 上报内核入库
  await reportToKernel(subscription)
  localStorage.setItem(STATE_KEY, '1')
  return subscription
}

/**
 * 把 PushSubscription 转成内核期望的 { endpoint, keys: {p256dh, auth} } 并上报
 */
async function reportToKernel(subscription) {
  const json = subscription.toJSON()
  const endpoint = json.endpoint || subscription.endpoint
  const p256dhBuf = subscription.getKey ? subscription.getKey('p256dh') : null
  const authBuf = subscription.getKey ? subscription.getKey('auth') : null
  const p256dh = p256dhBuf ? arrayBufferToBase64Url(p256dhBuf) : json.keys?.p256dh
  const auth = authBuf ? arrayBufferToBase64Url(authBuf) : json.keys?.auth
  if (!endpoint || !p256dh || !auth) throw new Error('订阅信息不完整')
  return await wsClient.request('push.web.subscribe', {
    endpoint,
    keys: { p256dh, auth },
  })
}

/**
 * 取消订阅：本地 + 通知内核删除
 */
export async function unsubscribePush() {
  const sub = await getCurrentSubscription()
  if (!sub) {
    localStorage.removeItem(STATE_KEY)
    return { removed: 0 }
  }
  const endpoint = sub.endpoint
  try {
    await sub.unsubscribe()
  } catch {
    // 浏览器取消可能失败，但内核侧仍需清理
  }
  let kernelResp = { removed: 0 }
  try {
    kernelResp = await wsClient.request('push.web.unsubscribe', { endpoint })
  } catch {
    // 内核可能拒绝（已不存在），忽略
  }
  localStorage.removeItem(STATE_KEY)
  return kernelResp
}

/**
 * 让内核给所有已订阅的浏览器/系统广播一条测试通知
 */
export async function sendTestPush(title, body) {
  return await wsClient.request('push.web.test', {
    title: title || 'ClawPanel',
    body: body || '这是一条测试通知，证明推送链路通了 ✓',
  })
}

/**
 * 本地缓存的订阅状态（不可靠，仅用于 UI 立即显示，真实状态用 getCurrentSubscription）
 */
export function isLocallySubscribed() {
  return localStorage.getItem(STATE_KEY) === '1'
}
