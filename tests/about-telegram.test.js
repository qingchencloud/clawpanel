// 失败清单先行：遗漏入口/邀请URL漂移/外链隔离缺失/旧社群丢失/翻译生成覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildLocales } from '../src/locales/index.js'
import { icon } from '../src/lib/icons.js'

const invitation = 'https://t.me/+rjRE3PgVL9tmOGZk'
const locales = buildLocales()
const source = fs.readFileSync(new URL('../src/pages/about.js', import.meta.url), 'utf8')
const oldLinks = ['https://discord.gg/U9AttmsNHh', 'https://qt.cool/c/OpenClaw', 'https://qt.cool/c/OpenClawWx', 'https://qt.cool/c/OpenClawDY', 'https://qt.cool/c/feishu', 'https://yb.tencent.com/gp/i/IIGXzcMcdh84']
const oldImages = ['/images/OpenClaw-QQ.png', '/images/OpenClawWx.png', 'https://qt.cool/c/OpenClawDY/qr.png', 'https://qt.cool/c/feishu/qr.png']

// 隔离执行真实模板函数；完整render入口/点击/布局由独立headless DOM证据覆盖。
function communityFixture(lang, { native = false, rejectOpen = false } = {}) {
  const events = [], calls = [], toasts = []
  const el = { innerHTML: '', querySelectorAll: selector => {
    assert.equal(selector, '[data-telegram-invite]')
    return anchors(el.innerHTML).filter(a => a.attributes['data-telegram-invite']).map(a => ({ href: a.attributes.href, addEventListener: (type, handler) => { assert.equal(type, 'click'); events.push(handler) } }))
  } }
  const t = key => key.split('.').reduce((value, part) => value?.[part], locales[lang]) ?? key
  const code = source.replace(/^import .+\n/gm, '').replace('export async function render()', 'async function render()')
  vm.runInNewContext(code + '\nrenderCommunity(page)', { page: { querySelector: selector => { assert.equal(selector, '#community-section'); return el } }, t, icon, isTauriRuntime: () => native, openExternalUrl: async url => { calls.push(url); if (rejectOpen) throw Error('fixture shell denial') }, toast: (...args) => toasts.push(args) }, { timeout: 1000 })
  return { html: el.innerHTML, events, calls, toasts }
}
const community = lang => communityFixture(lang).html
function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, content]) => ({
    attributes: Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])),
    text: content.replace(/<[^>]+>/g, '').trim(), content,
  }))
}

for (const lang of Object.keys(locales)) test(`About Telegram：${lang} 精确邀请及明确安全外链`, () => {
  const links = anchors(community(lang)), telegram = links.filter(a => a.attributes.href === invitation)
  assert.equal(telegram.length, 2, '社群区QR和按钮两个入口都应是用户指定的同一邀请')
  for (const entry of telegram) {
    assert.equal(entry.attributes.target, '_blank')
    assert.ok(entry.attributes.rel.split(/\s+/).includes('noopener'))
    assert.ok(entry.attributes.rel.split(/\s+/).includes('noreferrer'))
  }
  const link = telegram.find(a => a.attributes['data-telegram-invite'] === 'button')
  assert.ok(link, '加入按钮必须保留')
  assert.match(link.attributes.class, /\bbtn\b/)
  assert.equal(typeof locales[lang].about.joinTelegram, 'string', '翻译源必须包含新增键')
  assert.ok(locales[lang].about.joinTelegram.includes('Telegram'))
  assert.equal(link.text, locales[lang].about.joinTelegram)
  const qr = telegram.find(a => a.attributes['data-telegram-invite'] === 'qr')
  assert.ok(qr)
  assert.match(qr.content, /src="\/images\/ClawPanel-Telegram\.png"/)
  assert.equal(typeof locales[lang].about.telegramGroup, 'string')
  assert.ok(community(lang).includes(locales[lang].about.telegramGroup))
})

test('About Telegram：旧社群链接与四张QR均不替换，不引入Telegram远程QR', () => {
  const html = community('zh-CN'), links = anchors(html).map(a => a.attributes.href)
  for (const href of oldLinks) assert.equal(links.filter(value => value === href).length, 1, href)
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map(([, src]) => src)
  assert.deepEqual(images, [...oldImages, '/images/ClawPanel-Telegram.png'])
  assert.equal(links.filter(href => href.startsWith('https://t.me/')).length, 2)
})

test('About Telegram：11语言生成JSON及既有社群翻译材料保留新增标签', () => {
  for (const [lang, dict] of Object.entries(locales)) {
    const runtime = JSON.parse(fs.readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url)))
    const translation = new URL(`../scripts/translations/${lang}/about.json`, import.meta.url)
    for (const key of ['joinTelegram', 'telegramGroup', 'telegramOpenFailed']) {
      assert.equal(typeof dict.about[key], 'string', lang + '模块新增标签缺失：' + key)
      assert.equal(runtime.about[key], dict.about[key], lang + '生成标签不能丢失：' + key)
      if (fs.existsSync(translation)) assert.equal(JSON.parse(fs.readFileSync(translation))[key], dict.about[key])
    }
  }
  assert.equal(locales['zh-CN'].about.joinTelegram, '加入 Telegram')
  assert.equal(locales.en.about.joinTelegram, 'Join Telegram')
})

test('About Telegram QR：本地PNG保持已解码用户原图的逐字节hash，不生成/替换图片', () => {
  const png = fs.readFileSync(new URL('../public/images/ClawPanel-Telegram.png', import.meta.url))
  assert.equal(crypto.createHash('sha256').update(png).digest('hex'), 'ca51d164769d4d26ba9afa4fe1393d531e477f71d5baab75f42263e233b8a7bc')
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10])
  assert.equal(png.readUInt32BE(16), 256); assert.equal(png.readUInt32BE(20), 256)
  const html = community('zh-CN'), image = html.match(/<img\b[^>]*src="\/images\/ClawPanel-Telegram\.png"[^>]*>/)?.[0]
  assert.ok(image); assert.match(image, /width:140px/); assert.match(image, /height:140px/)
  assert.match(image, /object-fit:contain/); assert.match(image, /background:#fff/)
})

test('About Telegram Web：QR/按钮不preventDefault、不调桌面API，保持普通anchor', async () => {
  const f = communityFixture('en')
  assert.equal(f.events.length, 2)
  for (const handler of f.events) { let prevented = false; await handler({ preventDefault: () => { prevented = true } }); assert.equal(prevented, false) }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.toasts, [])
})

test('About Telegram Tauri：两个入口均preventDefault并各调用封装一次，不直开webview', async () => {
  const f = communityFixture('zh-CN', { native: true })
  assert.equal(f.events.length, 2)
  for (const handler of f.events) { let prevented = false; await handler({ preventDefault: () => { prevented = true } }); assert.equal(prevented, true) }
  assert.deepEqual(f.calls, [invitation, invitation]); assert.deepEqual(f.toasts, [])
})

test('About Telegram Tauri：shell拒绝可见错误，仍拦截默认导航而不silent或浏览器降级', async () => {
  const f = communityFixture('en', { native: true, rejectOpen: true })
  assert.equal(f.events.length, 2)
  for (const handler of f.events) { let prevented = false; await handler({ preventDefault: () => { prevented = true } }); assert.equal(prevented, true) }
  assert.deepEqual(f.calls, [invitation, invitation]); assert.equal(f.toasts.length, 2)
  for (const [message, kind] of f.toasts) { assert.match(message, /Failed to open Telegram/); assert.match(message, /fixture shell denial/); assert.equal(kind, 'error') }
})

test('openExternalUrl真实封装：隔离模块调度shell open、传播错误、拒绝非HTTP，不执行桌面', () => {
  const file = fileURLToPath(new URL('../src/lib/tauri-api.js', import.meta.url))
  const probe = `import vm from 'node:vm';import fs from 'node:fs';import assert from 'node:assert/strict';
    const calls=[],imports=[],web=[],state={fail:false};
    const context=vm.createContext({window:{__TAURI_INTERNALS__:{},location:{hostname:'tauri.localhost'},open:(...args)=>web.push(args)},URL,setTimeout,clearTimeout});
    const i18n=new vm.SyntheticModule(['t'],function(){this.setExport('t',key=>key)},{context});
    const shell=new vm.SyntheticModule(['open'],function(){this.setExport('open',async url=>{calls.push(url);if(state.fail)throw Error('fixture native shell blocked')})},{context});
    await shell.link(()=>{});await shell.evaluate();
    const module=new vm.SourceTextModule(fs.readFileSync(${JSON.stringify(file)},'utf8'),{context,importModuleDynamically:async spec=>{imports.push(spec);assert.equal(spec,'@tauri-apps/plugin-shell');return shell}});
    await module.link(spec=>{assert.equal(spec,'./i18n.js');return i18n});await module.evaluate();
    assert.equal(typeof module.namespace.openExternalUrl,'function');
    await module.namespace.openExternalUrl(${JSON.stringify(invitation)});state.fail=true;
    await assert.rejects(module.namespace.openExternalUrl(${JSON.stringify(invitation)}),/fixture native shell blocked/);
    const before=calls.length;
    for(const url of ['javascript:alert(1)','file:///C:/owned.txt','https://user:password@t.me/'])await assert.rejects(module.namespace.openExternalUrl(url));
    assert.equal(calls.length,before);assert.deepEqual(calls,[${JSON.stringify(invitation)},${JSON.stringify(invitation)}]);assert.deepEqual(web,[]);
    console.log(JSON.stringify({nativeExecuted:false,calls,imports,webFallback:false,invalidRejected:3,errorPropagated:true}));`
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const receipt = JSON.parse(result.stdout.trim())
  assert.equal(receipt.nativeExecuted, false); assert.equal(receipt.errorPropagated, true)
  assert.deepEqual(receipt.calls, [invitation, invitation]); assert.equal(receipt.webFallback, false)
})
