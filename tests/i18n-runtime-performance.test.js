import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildLocales } from '../src/locales/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('运行时只加载当前语言，不再首屏构建全部语言字典', () => {
  const source = read('src/lib/i18n.js')
  assert.doesNotMatch(source, /locales\/index\.js/)
  assert.doesNotMatch(source, /buildLocales\s*\(/)
  assert.match(source, /import zhCN from '\.\.\/locales\/zh-CN\.json'/)
  assert.match(source, /import\('\.\.\/locales\/en\.json'/)

  const main = read('src/main.js')
  assert.match(main, /const i18nReady = initI18n\(\)/)
  assert.match(main, /await i18nReady/)
  assert.match(read('src/components/sidebar.js'), /await setLang\(code\)/)
  assert.match(read('src/pages/settings.js'), /await setLang\(select\.value\)/)
})

test('生成的按语言 JSON 与模块化翻译源完全一致', () => {
  const locales = buildLocales()
  for (const [lang, expected] of Object.entries(locales)) {
    const actual = JSON.parse(read(`src/locales/${lang}.json`))
    assert.deepEqual(actual, expected, `${lang}.json 需要执行 npm run locales:build`)
  }
})

test('语言切换等待字典加载完成后再生效', async () => {
  const values = new Map([['clawpanel_lang', 'en']])
  globalThis.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  }
  const i18n = await import(`../src/lib/i18n.js?test=${Date.now()}`)

  await i18n.initI18n()
  assert.equal(i18n.getLang(), 'en')
  assert.equal(i18n.t('common.save'), 'Save')
  assert.equal(await i18n.setLang('zh-CN'), true)
  assert.equal(i18n.t('common.save'), '保存')
  assert.equal(await i18n.setLang('not-supported'), false)
})
