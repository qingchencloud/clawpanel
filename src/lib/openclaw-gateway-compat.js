/**
 * OpenClaw Gateway 握手兼容层。
 *
 * - 2026.7.1 及更早的 challenge 只有 nonce，签名时间由客户端生成。
 * - 2026.8.1 起 challenge 同时提供 ts，设备签名必须复用该时间戳。
 * - 新版 operator Gateway 要求 minProtocol=4；连接失败时由客户端显式回退到 3..4，
 *   保留旧 v3 Gateway 的兼容路径。
 */
export const OPENCLAW_PROTOCOL_PREFERRED_RANGE = Object.freeze({ min: 4, max: 4 })
export const OPENCLAW_PROTOCOL_RANGE = Object.freeze({ min: 3, max: 4 })

export function resolveConnectSignedAt(challengeTs, fallbackNow = Date.now()) {
  const value = typeof challengeTs === 'string' && challengeTs.trim()
    ? Number(challengeTs)
    : challengeTs
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value)
  }
  return Math.trunc(fallbackNow)
}

export function normalizeDeviceAuthMetadata(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function buildDeviceAuthPayloadV3({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAt,
  signatureToken,
  nonce,
  platform,
  deviceFamily,
}) {
  return [
    'v3',
    deviceId || '',
    clientId || '',
    clientMode || '',
    role || '',
    Array.isArray(scopes) ? scopes.join(',') : '',
    String(signedAt),
    signatureToken || '',
    nonce || '',
    normalizeDeviceAuthMetadata(platform),
    normalizeDeviceAuthMetadata(deviceFamily),
  ].join('|')
}

export function isProtocolIncompatReason(reason) {
  return /protocol\s+mismatch|unsupported\s+protocol|min(imum)?\s*protocol|max(imum)?\s*protocol/i.test(reason || '')
}

export function isDeviceAuthReason(reason) {
  return /device\s+(signature\s+invalid|auth(?:entication)?\s+(?:failed|invalid)|identity\s+required)|invalid\s+device\s+signature/i.test(reason || '')
}

export function isProtocolIncompatDetailCode(code) {
  return [
    'PROTOCOL_MISMATCH',
    'PROTOCOL_VERSION_MISMATCH',
    'UNSUPPORTED_PROTOCOL',
  ].includes(String(code || '').toUpperCase())
}

export function isDeviceAuthDetailCode(code) {
  return [
    'DEVICE_IDENTITY_REQUIRED',
    'CONTROL_UI_DEVICE_IDENTITY_REQUIRED',
    'DEVICE_AUTH_SIGNATURE_INVALID',
    'DEVICE_AUTH_NONCE_MISMATCH',
    'DEVICE_AUTH_NONCE_REQUIRED',
    'DEVICE_AUTH_PUBLIC_KEY_INVALID',
    'DEVICE_AUTH_INVALID',
  ].includes(String(code || '').toUpperCase())
}
