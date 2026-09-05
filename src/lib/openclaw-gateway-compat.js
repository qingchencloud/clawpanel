/**
 * OpenClaw Gateway 握手兼容层。
 *
 * - 2026.7.1 及更早的 challenge 只有 nonce，签名时间由客户端生成。
 * - 2026.8.1 起 challenge 同时提供 ts，设备签名必须复用该时间戳。
 * - operator 客户端继续声明 3..4 的协议范围，使旧 v3 与当前 v4 Gateway 都能协商。
 */
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
