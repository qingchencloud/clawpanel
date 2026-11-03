/** 本地海报绘图；只使用原生投影、受控二维码和打包素材。 */
import messages from '../locales/modules/engagement.js'

export const POSTER_ASSETS = Object.freeze({
  warm: new URL('../assets/invitation-poster/warm.webp', import.meta.url).href,
  dark: new URL('../assets/invitation-poster/dark.webp', import.meta.url).href,
  paper: new URL('../assets/invitation-poster/paper.webp', import.meta.url).href,
  logo: new URL('../assets/invitation-poster/logo.png', import.meta.url).href,
})
export function posterText(key, language, values = {}) {
  const value = messages[`poster${key}`]?.[language === 'en' ? 'en' : 'zh-CN'] || ''
  return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`))
}
const integer = (value, max, min = 1) => Number.isSafeInteger(value) && value >= min && value <= max
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
export function posterCredits(value) {
  if (typeof value !== 'string' || !/^\d{1,13}$/.test(value) || BigInt(value) > 1000000000000n) return null
  const amount = BigInt(value), fraction = String(amount % 10000n).padStart(4, '0').replace(/0+$/, '')
  return `${amount / 10000n}${fraction ? `.${fraction}` : ''}`
}
export function validateInvitationPoster(bundle, expected) {
  try {
    if (!expected || bundle?.epoch !== expected.epoch || bundle.memberId !== expected.memberId || !/^[A-Za-z0-9_-]{43}$/.test(bundle.revision)) return false
    const origin = new URL(bundle.origin), approved = new URL(expected.origin), view = bundle.view, referral = view?.promotion?.referral
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== approved.origin || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) return false
    if (view?.available !== true || view.status !== 'active' || referral?.available !== true || referral.status !== 'active') return false
    const link = new URL(view.invite_url), query = [...link.searchParams.entries()]
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(view.invite_code) || link.origin !== origin.origin || link.pathname !== '/member' || link.username || link.password || link.hash || query.length !== 1 || query[0][0] !== 'invite' || query[0][1] !== view.invite_code) return false
    if (view.qr_url !== '/api/v1/member/invitation-poster/qr.png' || typeof bundle.qrDataUrl !== 'string' || bundle.qrDataUrl.length > 3000000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(bundle.qrDataUrl)) return false
    if (!validDate(view.server_time) || !validDate(referral.starts_at) || !validDate(referral.ends_at) || Date.parse(referral.starts_at) > Date.parse(view.server_time) || Date.parse(referral.ends_at) <= Date.parse(view.server_time)) return false
    if (typeof referral.campaign_id !== 'string' || !referral.campaign_id || typeof referral.rules_version !== 'string' || !referral.rules_version) return false
    if (posterCredits(referral.inviter_amount_micro_cny) === null || posterCredits(referral.invitee_amount_micro_cny) === null || !integer(referral.valid_hours, 8760) || !integer(referral.qualification_days, 365) || !integer(referral.successful_requests_required, 10000) || !integer(referral.distinct_utc_dates_required, 365) || !integer(referral.observation_seconds, 2592000, 0)) return false
    if (referral.per_member_daily_referral_limit != null && !integer(referral.per_member_daily_referral_limit, 1000000, 0)) return false
    if (referral.reward_expiry_from_issuance != null && typeof referral.reward_expiry_from_issuance !== 'boolean') return false
    const copy = view.promotion.copy
    for (const [key, limit] of [['title_zh', 80], ['title_en', 80], ['subtitle_zh', 240], ['subtitle_en', 240]]) if (typeof copy?.[key] !== 'string' || Array.from(copy[key]).length > limit || /[\u0000-\u001f\u007f]/.test(copy[key])) return false
    const trial = view.promotion.registration
    if (trial?.available === true && (posterCredits(trial.amount_micro_cny) === null || !integer(trial.valid_hours, 8760))) return false
    return true
  } catch { return false }
}
function duration(seconds, language) {
  for (const [key, divisor] of [['Days', 86400], ['Hours', 3600], ['Minutes', 60], ['Seconds', 1]]) if (seconds % divisor === 0) {
    const count = seconds / divisor
    return language === 'en' ? new Intl.NumberFormat('en', { style: 'unit', unit: key.slice(0, -1).toLowerCase(), unitDisplay: 'long' }).format(count) : posterText(`Duration${key}`, language, { count })
  }
  return ''
}
export function invitationPosterSummary(bundle, language) {
  const view = bundle.view, referral = view.promotion.referral, trial = view.promotion.registration
  const rows = [
    posterText('Conditions', language, { days: referral.qualification_days, requests: referral.successful_requests_required, dates: referral.distinct_utc_dates_required }),
    posterText('Review', language, { duration: duration(referral.observation_seconds, language) }),
    posterText(referral.reward_expiry_from_issuance === true ? 'ExpiryIssued' : 'ExpiryReview', language, { hours: referral.valid_hours }),
  ]
  if (referral.per_member_daily_referral_limit > 0) rows.push(posterText('Limit', language, { count: referral.per_member_daily_referral_limit }))
  if (trial?.available === true) rows.push(posterCredits(trial.amount_micro_cny) === '0' ? posterText('TrialZero', language) : posterText('Trial', language, { amount: posterCredits(trial.amount_micro_cny), hours: trial.valid_hours }))
  rows.push(posterText('Until', language, { date: new Date(referral.ends_at).toLocaleString(language === 'en' ? 'en' : 'zh-CN') }))
  return rows
}
const pictures = new Map()
function image(source, cache = false) {
  if (cache && pictures.has(source)) return pictures.get(source)
  const work = new Promise((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => { img.onload = null; img.onerror = null; img.src = ''; reject(new Error('poster_image_unavailable')) }, 10000)
    img.onload = () => { clearTimeout(timer); img.onload = null; img.onerror = null; resolve(img) }
    img.onerror = () => { clearTimeout(timer); img.onload = null; img.onerror = null; reject(new Error('poster_image_unavailable')) }
    img.src = source
  })
  if (cache) pictures.set(source, work.catch(error => { pictures.delete(source); throw error }))
  return cache ? pictures.get(source) : work
}
function round(ctx, x, y, width, height, radius, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill() }
function font(ctx, size, weight = 500) { ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif` }
function wrappedLines(ctx, text, width) {
  const rows = []; let row = ''
  const flush = () => { rows.push(row.trimEnd()); row = '' }
  // 英文按词换行；中日韩文字和超长单词/URL才逐字拆开。
  for (const token of String(text).match(/\n|[^\S\n]+|[^\s]+/gu) || []) {
    if (token === '\n') { flush(); continue }
    if (/^\s+$/u.test(token)) { if (row) row += token; continue }
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token) && ctx.measureText(token).width <= width) {
      if (row && ctx.measureText(row + token).width > width) flush()
      row += token
    } else {
      for (const char of Array.from(token)) {
        if (row && ctx.measureText(row + char).width > width) flush()
        row += char
      }
    }
  }
  if (row) rows.push(row.trimEnd())
  return rows
}
function textBlock(ctx, text, width, size, lineHeight, weight = 500) {
  font(ctx, size, weight)
  const rows = wrappedLines(ctx, text, width)
  return { rows, size, lineHeight, weight, height: rows.length * lineHeight }
}
function paintBlock(ctx, block, x, top, color) {
  font(ctx, block.size, block.weight); ctx.fillStyle = color
  block.rows.forEach((value, index) => ctx.fillText(value, x, top + block.size + block.lineHeight * index))
  return top + block.height
}
function layoutHeight(layout) {
  const ruleHeight = layout.rules.reduce((height, block) => height + block.height, 0) + Math.max(0, layout.rules.length - 1) * layout.ruleGap
  return layout.heading.height + (layout.description ? 16 + layout.description.height : 0) + 26 + layout.rewardHeight + layout.afterReward + ruleHeight + layout.beforeQr + layout.qrHeight + 20 + layout.address.height
}
function expandShortLayout(ctx, layout, title, language) {
  // 短文案把空间用于奖励、扫码和文字层级，不把空白搬到画布底部。
  const adopt = change => {
    const candidate = { ...layout, ...change }
    if (layoutHeight(candidate) <= 1178) Object.assign(layout, candidate)
  }
  adopt({ rewardHeight: 248, amountSize: 96 })
  adopt({ qrSize: 240, qrHeight: 284 })
  adopt({ qrSize: 264, qrHeight: 308 })
  for (let size = layout.heading.size + 4; size <= (language === 'en' ? 76 : 80); size += 4) {
    const heading = textBlock(ctx, title, 925, size, Math.ceil(size * 1.16), 760)
    if (layoutHeight({ ...layout, heading }) > 1178) break
    layout.heading = heading
  }
  for (let extra = 1; extra <= 7; extra++) {
    const rules = layout.rules.map(block => ({ ...block, lineHeight: Math.ceil(block.size * 1.36) + extra, height: block.rows.length * (Math.ceil(block.size * 1.36) + extra) }))
    if (layoutHeight({ ...layout, rules }) > 1178) break
    layout.rules = rules
  }
  adopt({ ruleGap: 14 }); adopt({ afterReward: 40 }); adopt({ beforeQr: 42 })
  layout.height = layoutHeight(layout)
  return layout
}
function contentLayout(ctx, title, subtitle, summary, link, language) {
  // 先测量全部内容；普通文案使用大字号，合法长文案逐阶收紧，不省略标题或条款。
  const presets = [
    [64, 60, 30, 30, 216, 88], [60, 56, 28, 30, 216, 88],
    [56, 52, 26, 28, 208, 88], [52, 48, 24, 28, 208, 86],
    [48, 46, 23, 26, 200, 84], [44, 42, 22, 25, 196, 82],
    [40, 38, 21, 24, 192, 80], [38, 36, 20, 22, 188, 78],
    [34, 32, 18, 22, 188, 78],
  ]
  for (const [zh, en, subtitleSize, ruleSize, rewardHeight, amountSize] of presets) {
    const titleSize = language === 'en' ? en : zh
    const heading = textBlock(ctx, title, 925, titleSize, Math.ceil(titleSize * 1.16), 760)
    const description = subtitle.trim() ? textBlock(ctx, subtitle, 922, subtitleSize, Math.ceil(subtitleSize * 1.38), 450) : null
    const compact = subtitleSize === 18
    const rules = summary.map(row => textBlock(ctx, row, 922, ruleSize, Math.ceil(ruleSize * (compact ? 1.24 : 1.36)), 450))
    const address = textBlock(ctx, link, 924, 16, 22, 450)
    const layout = { heading, description, rules, address, rewardHeight, amountSize, ruleGap: compact ? 7 : 9, afterReward: compact ? 24 : 30, beforeQr: compact ? 28 : 32, qrHeight: 224, qrSize: 180 }
    if (layoutHeight(layout) <= 1178) return ruleSize === 30 ? expandShortLayout(ctx, layout, title, language) : layout
  }
  throw new Error('poster_content_unavailable')
}
export async function renderInvitationPoster(canvas, bundle, { template, language, isCurrent = () => true }) {
  if (!Object.hasOwn(POSTER_ASSETS, template) || template === 'logo') throw new Error('poster_template_invalid')
  const [background, qr, logo] = await Promise.all([image(POSTER_ASSETS[template], true), image(bundle.qrDataUrl), image(POSTER_ASSETS.logo, true)])
  if (!isCurrent()) return false
  if (qr.naturalWidth !== 512 || qr.naturalHeight !== 512) throw new Error('poster_qr_invalid')
  const ctx = canvas.getContext('2d'), view = bundle.view, referral = view.promotion.referral, copy = view.promotion.copy, dark = template === 'dark'
  const ink = dark ? '#fff9f2' : '#24211e', muted = dark ? '#ddd4ca' : '#665b51', orange = dark ? '#ffb17e' : '#bb4414'
  canvas.width = 1080; canvas.height = 1440; ctx.clearRect(0, 0, 1080, 1440); ctx.drawImage(background, 0, 0, 1080, 1440)
  round(ctx, 44, 36, 992, 1380, 30, dark ? 'rgba(18,18,19,.82)' : 'rgba(255,253,248,.91)')
  ctx.drawImage(logo, 78, 70, 50, 50); ctx.fillStyle = ink; font(ctx, 34, 740); ctx.fillText('ClawPanel', 143, 108)
  ctx.fillStyle = orange; font(ctx, 22, 650); ctx.fillText(posterText('Fresh', language), 78, 168)
  const suffix = language === 'en' ? 'en' : 'zh', title = copy[`title_${suffix}`], subtitle = copy[`subtitle_${suffix}`]
  const layout = contentLayout(ctx, title.trim() ? title : posterText('Join', language), subtitle, invitationPosterSummary(bundle, language), view.invite_url, language)
  let y = paintBlock(ctx, layout.heading, 76, 190, ink)
  if (layout.description) y = paintBlock(ctx, layout.description, 78, y + 16, muted)
  const rewardsTop = y + 26
  for (const [index, key, raw] of [[0, 'Inviter', referral.inviter_amount_micro_cny], [1, 'Invitee', referral.invitee_amount_micro_cny]]) {
    const x = 76 + index * 473, amount = posterCredits(raw)
    round(ctx, x, rewardsTop, 452, layout.rewardHeight, 18, dark ? '#302b28' : '#fff')
    ctx.fillStyle = muted; font(ctx, 26, 550); ctx.fillText(posterText(key, language), x + 24, rewardsTop + 40)
    ctx.fillStyle = orange; let size = layout.amountSize; font(ctx, size, 760)
    while (size > 36 && ctx.measureText(amount).width > 397) font(ctx, --size, 760)
    ctx.fillText(amount, x + 24, rewardsTop + Math.round(layout.rewardHeight * .65)); ctx.fillStyle = muted; font(ctx, 22)
    ctx.fillText(posterText(amount === '0' ? 'NoReward' : 'Credits', language), x + 24, rewardsTop + layout.rewardHeight - 26)
  }
  y = rewardsTop + layout.rewardHeight + layout.afterReward
  for (const [index, block] of layout.rules.entries()) {
    if (index) y += layout.ruleGap
    y = paintBlock(ctx, block, 78, y, muted)
  }
  // 扫码区跟随正文，只补充有限留白；短标题不会留下一个空的副标题区域。
  const qrTop = y + layout.beforeQr, qrOuter = layout.qrSize + 24, qrX = 982 - qrOuter, textWidth = qrX - 136
  round(ctx, 76, qrTop, 925, layout.qrHeight, 20, dark ? '#302b28' : '#fff')
  const scan = textBlock(ctx, posterText('Scan', language), textWidth, 38, 46, 730)
  const note = textBlock(ctx, posterText('Rules', language), textWidth, 20, 28, 450)
  const scanTop = qrTop + (layout.qrHeight - scan.height - 14 - note.height) / 2
  paintBlock(ctx, scan, 104, scanTop, ink); paintBlock(ctx, note, 104, scanTop + scan.height + 14, muted)
  round(ctx, qrX, qrTop + 10, qrOuter, qrOuter, 8, '#fff'); ctx.imageSmoothingEnabled = false; ctx.drawImage(qr, qrX + 12, qrTop + 22, layout.qrSize, layout.qrSize); ctx.imageSmoothingEnabled = true
  // 本人链接保留全部字符；不对URL加省略号。
  paintBlock(ctx, layout.address, 78, qrTop + layout.qrHeight + 20, muted)
  canvas.setAttribute('aria-label', posterText('Alt', language)); return isCurrent()
}
