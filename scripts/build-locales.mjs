import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLocales } from '../src/locales/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const locales = buildLocales()

for (const [lang, dict] of Object.entries(locales)) {
  const target = path.join(root, 'src', 'locales', `${lang}.json`)
  fs.writeFileSync(target, `${JSON.stringify(dict, null, 2)}\n`, 'utf8')
  console.log(`[locales] ${lang} -> ${path.relative(root, target)}`)
}
