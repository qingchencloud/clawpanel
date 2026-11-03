import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const langs = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'vi', 'es', 'pt', 'ru', 'fr', 'de']
const readmes = ['README.md', ...langs.filter(lang => lang !== 'zh-CN').map(lang => `README.${lang}.md`)]
// 公司品牌本身允许出现；只匹配旧接口域名和明确的接口推广语句。
const oldPromotion = /gpt\.qt\.cool|ciyapi\.(?:79tian\.com|com)|词元\s*API|詞元\s*API|CiyAPI|晴辰(?:云|雲)(?:免费测试|免費測試)|(?:免费测试|免費測試)[：:]\s*晴辰(?:云|雲)|QingChen Cloud(?: for)? free testing/i

// 本文件仅验证源码及文档契约；真实DOM和合成配置保存由独立浏览器E2E验证。
test('运行时不再内置两旧接口推荐及快捷模型请求', () => {
  for (const file of ['src/lib/model-presets.js', 'src/lib/openclaw-kb.js', 'src/pages/models.js', 'src/pages/assistant.js']) {
    const content = read(file)
    assert.doesNotMatch(content, oldPromotion, `${file} 仍内置旧推广`)
    assert.doesNotMatch(content, /\b(?:QTCOOL|CIYAPI|fetchQtcoolModels|fetchCiyapiModels)\b/, `${file} 仍依赖旧快捷配置`)
  }
})

test('当前11语言README不再介绍旧接口推广', () => {
  for (const file of readmes) assert.doesNotMatch(read(file), oldPromotion, `${file} 仍宣传旧接口`)
})

test('11语言已生成模型及助手文案不再含旧推广键', () => {
  for (const lang of langs) {
    const locale = JSON.parse(read(`src/locales/${lang}.json`))
    for (const section of ['models', 'assistant']) {
      for (const key of Object.keys(locale[section] || {})) assert.doesNotMatch(key, /^(?:qtcool|ciyapi)/i, `${lang}.${section}.${key} 仍为旧推广键`)
      assert.doesNotMatch(JSON.stringify(locale[section]), oldPromotion, `${lang}.${section} 仍有旧推广文案`)
    }
  }
})

test('翻译源与补丁不会重新生成旧接口推广', () => {
  for (const file of ['src/locales/modules/models.js', 'src/locales/modules/assistant.js', 'scripts/translations/ja/models.json', 'scripts/translations/ko/models.json']) {
    assert.doesNotMatch(read(file), /(?:qtcool|ciyapi)/i, `${file} 保留旧推广来源`)
  }
})

test('服务商介绍采用普通官网链接且不再携带推广参数', () => {
  assert.doesNotMatch(read('src/lib/model-presets.js'), /CH_4BVI0BM2|PFrw2an5|Ph1OP5I3_GY|keahn2zr|3F6F9XYKTS/)
})

test('旧密钥不会由推荐路径静默读取或复用', () => {
  assert.doesNotMatch(read('src/lib/model-presets.js'), /readOpenclawConfig|readModelChannels/)
  assert.doesNotMatch(read('src/pages/assistant.js'), /quickDrafts\[providerKey\]\.key\s*=\s*configured\.apiKey/)
  assert.doesNotMatch(read('src/pages/models.js'), /bannerKey\s*\|\|\s*existingProvider\?\.apiKey/)
})

test('官网模型与安装包品牌、关于页及服务器赞助仍保留', () => {
  assert.match(read('src-tauri/src/commands/site_api.rs'), /https:\/\/claw\.qt\.cool/)
  assert.match(read('src-tauri/src/commands/openclaw_gateway_official.rs'), /clawpanel-official-gateway/)
  assert.match(read('src-tauri/src/commands/config.rs'), /@qingchencloud\/openclaw-zh/)
  assert.match(read('src/pages/about.js'), /xintian/)
  assert.match(read('src/pages/about.js'), /sponsor-qr-thumb/)
  assert.match(read('README.md'), /https:\/\/www\.ciyundata\.com\/cart\/goods\.htm\?id=267/)
  assert.match(read('README.md'), /慈云数据-香港直连2H2G_99元\/年/)
})
