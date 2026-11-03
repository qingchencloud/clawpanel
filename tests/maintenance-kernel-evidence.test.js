import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source=readFileSync(new URL('../scripts/maintenance-runtime-smoke.mjs',import.meta.url),'utf8')
test('真实验收指纹包含实际发运桥与已有认证/网关依赖，预览同样使用 Windows 短 HOME',()=>{
 const map=source.match(/function collectCandidateSourceHashes\(project\) \{[^]*?\n\}/)?.[0]
 assert.ok(map, '真实验收快照入口必须存在')
 assert.match(source,/report.environment.candidateSourceHashes = collectCandidateSourceHashes\(project\)/)
 for(const file of ['scripts/opencode-proxy.js','scripts/deepseek-harness-auth.js','scripts/deepseek-harness-proxy.js','src/lib/opencode-storage-bridge.js','src/engines/hermes/pages/chat.js','src/engines/opencode/pages/dashboard.js']) assert.ok(map.includes(file),file)
 const deps=source.slice(source.indexOf('report.environment.verifierDependencyHashes'),source.indexOf('report.environment.candidateSourceHashes'))
 assert.ok(deps.includes('src/lib/openclaw-gateway-compat.js'))
 // 基线不存在的 PM 不伪造指纹；候选实际发运该模块时必须读取真实文件。
 assert.match(map,/for \(const optional of \['scripts\/hermes-pm-runtime.js', 'scripts\/hermes-managed-install.ps1'\]\)/)
 assert.match(map,/fs\.lstatSync\(path\.join\(project, optional\)\); files\.push\(optional\)/)
 assert.match(map,/if \(error\.code !== 'ENOENT'\) throw error/)
 assert.match(map,/isFile\(\) && !stat\.isSymbolicLink\(\)/)
 assert.match(source,/shortDshHome = process\.platform === 'win32' && \['deepseek-harness', 'deepseek-harness-preview'\]\.includes\(engine\)/)
})
