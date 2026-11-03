import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildLocales } from '../src/locales/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = path.join(root, 'src', 'locales')

// 界面运行时只读 src/locales/*.json；语言源在 src/locales/modules/*.js。
// 改了源却忘记 npm run locales:build 时，界面会直接显示 key，这里负责拦住。
test('语言源与生成的 locales JSON 保持同步', () => {
  const generated = buildLocales()
  const languages = Object.keys(generated)
  assert.ok(languages.length >= 11, `语言数量异常：${languages.length}`)
  for (const lang of languages) {
    const file = path.join(localesDir, `${lang}.json`)
    assert.ok(fs.existsSync(file), `缺少 ${lang}.json`)
    const actual = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepStrictEqual(actual, generated[lang], `${lang}.json 与 src/locales/modules 不同步，请运行 npm run locales:build`)
  }
  const files = fs.readdirSync(localesDir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
  for (const lang of files) assert.ok(languages.includes(lang), `src/locales/${lang}.json 没有对应的语言源`)
})
