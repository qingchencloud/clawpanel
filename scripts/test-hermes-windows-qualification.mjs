#!/usr/bin/env node
// 可信手工资格入口。--execute 只接受 GitHub 托管的一次性 Windows VM，绝不回退到本机安装。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareStartupDiagnosticSpawn, startHermesFilePhaseObservation } from './hermes-startup-diagnostic.mjs'
import { observeHermesPythonCache } from './hermes-python-cache-observation.mjs'
import { classifyHermesMetadataRequest } from './hermes-qualification-provider.mjs'
import { createHermesExecFileObserver } from './hermes-exec-observation.mjs'
import { decodeStatusTailObservation } from './hermes-status-tail-receipts.mjs'

export const STAGES = ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve']

// 只读识别已审双版本 factory 的确定语法；不 import/eval 候选，也不搜索全文第一个 stages。
export function readHermesRelease(webSource, rust, expectedVersion) {
  const one = pattern => {
    const matches = [...webSource.matchAll(pattern)]
    assert.equal(matches.length, 1, 'Hermes release 声明缺失或重复')
    return matches[0][1]
  }
  const constant = name => one(new RegExp(`^const HERMES_STABLE_${name} = '([^']+)'`, 'gm'))
  const version = constant('VERSION'), tag = constant('TAG'), commit = constant('COMMIT'), branch = constant('BRANCH')
  const pins = { '0.21.5': 'f97608f178d1ffeca59860195ab7da295f7c8e5f', '0.22.2': 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' }
  assert.equal(version, expectedVersion)
  assert.ok(Object.hasOwn(pins, version) && exactSha(commit) && pins[version] === commit, 'Hermes release version/pin 未审查')
  assert.equal(branch, version === '0.21.5' ? 'v2026.9.24' : 'release/0.22.2', 'Hermes release branch 未审查')
  assert.ok(rust.includes(`HERMES_STABLE_VERSION: &str = "${version}"`) && rust.includes(commit), 'Hermes release Rust version/pin 不符')
  const installerSha256 = one(/HERMES_INSTALLER_SHA256\s*=\s*\{\s*windows:\s*'([a-f0-9]{64})'/g)
  const factory = one(/^export function hermesInstallerPlan\(([^]*?)^\}/gm)
  // 注释及字符串各为独立 token，避免其中的 stages/括号冒充分支；模板仅作不可执行数据。
  const lex = source => [...source.matchAll(/\s+|\/\/[^\n]*|\/\*[^]*?\*\/|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|===|!==|=>|\|\||\S/g)]
    .map(m => m[0]).filter(t => !/^\s|^\/\/|^\/\*/.test(t))
  const tokens = lex('(' + factory + '}'); let cursor = 0
  const take = source => {
    const expected = lex(source)
    assert.deepEqual(tokens.slice(cursor, cursor + expected.length), expected, 'Hermes installer factory 形态/分支/固定 guard 不符')
    cursor += expected.length
  }
  const semi = () => { if (tokens[cursor] === ';') cursor++ }
  const guardedThrow = () => {
    take('throw new Error(')
    assert.match(tokens[cursor++] || '', /^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")$/, 'Hermes installer guard 缺固定错误声明')
    take(')'); semi()
  }
  const returnStages = () => {
    take('return {')
    const properties = {}, closing = { '(': ')', '[': ']', '{': '}' }
    while (tokens[cursor] !== '}') {
      const key = tokens[cursor++]
      assert.ok(/^[A-Za-z]\w*$/.test(key || '') && !Object.hasOwn(properties, key), 'Hermes installer 属性缺失/重复/未知形态')
      take(':')
      const value = [], stack = []
      while (cursor < tokens.length && (stack.length || ![',', '}'].includes(tokens[cursor]))) {
        const token = tokens[cursor++]
        if (Object.hasOwn(closing, token)) stack.push(closing[token])
        else if ([')', ']', '}'].includes(token)) assert.equal(stack.pop(), token, 'Hermes installer 属性边界不符')
        value.push(token)
      }
      assert.ok(value.length && !stack.length, 'Hermes installer 属性不完整')
      properties[key] = value
      if (tokens[cursor] === ',') cursor++
    }
    take('}'); semi()
    assert.deepEqual(Object.keys(properties).sort(), ['argsForStage', 'program', 'scriptPath', 'sha256', 'sourcePath', 'stages', 'url'])
    const array = properties.stages
    assert.equal(array[0], '['); assert.equal(array.at(-1), ']')
    const stages = []
    for (let i = 1; i < array.length - 1; i++) {
      assert.match(array[i], /^'[a-z][a-z0-9-]*'$/, 'Hermes installer stages 必须是实际字符串 literal')
      stages.push(array[i].slice(1, -1))
      if (i + 1 < array.length - 1) assert.equal(array[++i], ',')
    }
    assert.ok(stages.length >= 5 && new Set(stages).size === stages.length, '缺真实 Windows 安装协议/hash')
    return stages
  }
  take('(home = hermesHome()) { const installDir = hermesSourceDir(home)'); semi()
  take("const cacheDir = path.join(home, '.clawpanel-cache')"); semi()
  take("if (isWindows) { if (HERMES_STABLE_VERSION === '0.21.5') {")
  take(`if (HERMES_STABLE_COMMIT !== '${pins['0.21.5']}')`); guardedThrow()
  const legacyStages = returnStages(); take('}')
  take(`if (HERMES_STABLE_VERSION !== '0.22.2' || HERMES_STABLE_COMMIT !== '${pins['0.22.2']}')`); guardedThrow()
  const modernStages = returnStages(); take('}')
  returnStages(); take('}'); assert.equal(cursor, tokens.length, 'Hermes installer factory 有额外分支')
  const stages = version === '0.21.5' ? legacyStages : modernStages
  if (version === '0.22.2') assert.deepEqual(stages, ['repository', 'venv', 'python-deps', 'config', 'complete'], '22.2 upstream stage 协议不符，不虚构 node-deps')
  else assert.deepEqual(stages, ['uv', 'git', 'node', 'repository', 'python', 'venv', 'dependencies', 'node-deps', 'config-templates', 'platform-sdks', 'bootstrap-marker'], '21.5 原11 stage 协议不符')
  return { version, tag, commit, stages, installerSha256 }
}

const tooling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const hash = file => digest(fs.readFileSync(file))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const exactSha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value)
const within = (home, file) => { const rel = path.relative(path.resolve(home), path.resolve(file)); return !rel.startsWith('..') && !path.isAbsolute(rel) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

export function parseArgs(args) {
  const flags = new Set(['--plan', '--execute', '--help', '--matrix', '--startup-diagnostic', '--startup-stack-samples', '--status-tail-diagnostic'])
  const values = new Set(['--root', '--sha', '--version', '--variant', '--output', '--verify-linux-evidence', '--publish-evidence'])
  const o = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    assert.ok(!Object.hasOwn(o, key), `重复参数 ${key}`)
    if (flags.has(key)) o[key] = true
    else { assert.ok(values.has(key) && args[i + 1] && !args[i + 1].startsWith('--'), `未知或缺值参数 ${key}`); o[key] = args[++i] }
  }
  if (o['--sha']) assert.ok(exactSha(o['--sha']), 'SHA 必须是小写完整40位')
  if (o['--version']) assert.match(o['--version'], /^0\.\d+\.\d+$/, '必须精确版本')
  if (o['--variant']) assert.ok(['old', 'new'].includes(o['--variant']), 'variant 必须 old/new')
  assert.ok([o['--plan'], o['--execute'], o['--matrix'], o['--verify-linux-evidence'], o['--publish-evidence']].filter(Boolean).length <= 1, '模式互斥')
  if (o['--startup-stack-samples']) assert.equal(o['--startup-diagnostic'], true, 'stack sampling requires startup diagnostic')
  if (o['--startup-diagnostic']) assert.equal(o['--execute'], true, 'startup diagnostic requires execute')
  if (o['--status-tail-diagnostic']) {
    assert.ok(o['--execute'] || o['--plan'], 'status tail diagnostic requires execute or plan')
    assert.ok(!o['--startup-diagnostic'] && !o['--startup-stack-samples'], 'status tail diagnostic is separate from startup sampling')
    assert.ok(o['--version'] === '0.22.2' && o['--variant'] === 'new', 'status tail diagnostic requires exact new candidate')
  }
  return o
}

export function matrixFromInputs(env) {
  assert.ok(env.STATUS_TAIL_DIAGNOSTIC === undefined || ['true', 'false', ''].includes(env.STATUS_TAIL_DIAGNOSTIC), 'invalid status tail diagnostic boolean')
  if (env.STATUS_TAIL_DIAGNOSTIC === 'true') assert.ok(env.TARGET === 'candidate' && env.PLATFORM === 'windows' && env.STARTUP_DIAGNOSTIC !== 'true' && env.STARTUP_STACK_SAMPLES !== 'true', 'status tail diagnostic requires separate Windows candidate mode')
  if (env.STARTUP_STACK_SAMPLES === 'true') assert.ok(env.STARTUP_DIAGNOSTIC === 'true' && env.TARGET === 'candidate' && env.PLATFORM === 'windows', 'stack samples require Windows candidate diagnostic')
  if (env.STARTUP_DIAGNOSTIC === 'true') assert.notEqual(env.PLATFORM, 'linux', 'startup diagnostic requires Windows')
  assert.ok(['baseline', 'candidate', 'both'].includes(env.TARGET), 'target 无效')
  const include = []
  for (const [target, variant, key, version] of [['baseline', 'old', 'BASELINE_SHA', '0.21.5'], ['candidate', 'new', 'CANDIDATE_SHA', '0.22.2']]) {
    if (env.TARGET !== target && env.TARGET !== 'both') continue
    assert.ok(exactSha(env[key]), `${key} 必须是完整 SHA，不接受分支/浮动 tag`)
    include.push({ variant, sha: env[key], version })
  }
  return { include }
}

export function runnerProofFailures(p) {
  // 除 ImageOS 精确两项 allowlist 外保留原有合取门禁；原因不拼入环境值或凭据。
  const checks = {
    platform: p.platform === 'win32', architecture: p.arch === 'x64',
    'runner-environment': p.runnerEnvironment === 'github-hosted', 'runner-os': p.runnerOS === 'Windows',
    event: p.event === 'workflow_dispatch', 'main-ref': p.ref === 'refs/heads/main', repository: p.repository === 'qingchencloud/clawpanel',
    'workflow-ref': p.workflowRef === 'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main',
    'workflow-sha-format': exactSha(p.workflowSha), 'workflow-sha-match': p.workflowSha === p.toolingSha,
    'run-id': /^\d+$/.test(p.runId || ''), 'run-attempt': /^\d+$/.test(p.attempt || ''),
    'virtual-machine': p.virtualMachine === true, 'image-os': ['win25', 'win25-vs2026'].includes(p.imageOS), 'image-version': !!p.imageVersion,
    'user-name': p.userName?.toLowerCase() === 'runneradmin', 'sid-format': /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(p.sid || ''),
    'actual-profile': /^[a-z]:\\Users\\runneradmin$/i.test(p.actualProfile || ''), 'profile-registration': p.actualProfile?.toLowerCase() === p.registeredProfile?.toLowerCase(),
  }
  return Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
}

export function validateRunnerProof(p) {
  const failures = runnerProofFailures(p)
  assert.equal(failures.length, 0, `Windows 资格门禁失败：仅可信 main 手工 GitHub-hosted VM + 真实 runneradmin SID/ProfileList；环境变量不是宿主隔离证明；failedConditions=${failures.join(',')}`)
}

export function isolationEnv({ home, temp, parent = process.env, realProfile = parent.USERPROFILE }) {
  home = path.resolve(home); temp = path.resolve(temp)
  const env = {}
  for (const k of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (parent[k]) env[k] = parent[k]
  const inherited = parent.PATH || parent.Path || ''
  const entries = inherited.split(';').filter(p => p && (!realProfile || !p.toLowerCase().startsWith(realProfile.toLowerCase() + '\\')))
  env.PATH = [path.join(home, '.hermes/hermes-agent/venv/Scripts'), path.join(home, '.hermes/bin'), path.join(home, '.local/bin'), path.join(home, '.npm-global'), ...entries].join(';')
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    HERMES_HOME: path.join(home, '.hermes'), OPENCLAW_CONFIG_DIR: path.join(home, '.openclaw'),
    NPM_CONFIG_PREFIX: path.join(home, '.npm-global'), NPM_CONFIG_CACHE: path.join(home, '.npm-cache'), NPM_CONFIG_USERCONFIG: path.join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'global-npmrc'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    UV_CACHE_DIR: path.join(home, '.uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(home, '.uv-python'), UV_TOOL_DIR: path.join(home, '.uv-tools'), UV_TOOL_BIN_DIR: path.join(home, '.local/bin'), UV_INSTALL_DIR: path.join(home, '.local/bin'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PLAYWRIGHT_BROWSERS_PATH: path.join(home, '.browsers'), CI: '1' })
  return env
}

export function assertHostUnchanged(before, after) { assert.deepEqual(after, before, '宿主 registry类型/值、PATH、shell、global launcher 或父环境发生变更；不自动恢复掩盖失败') }

export function assertSameSource(root, files) {
  for (const [file, expected] of Object.entries(files)) {
    const f = path.resolve(root, file)
    assert.ok(within(root, f) && fs.existsSync(f) && fs.lstatSync(f).isFile() && !fs.lstatSync(f).isSymbolicLink(), `源码缺失/越界 ${file}`)
    assert.equal(hash(f), expected, `源码字节 SHA256 不同 ${file}`)
  }
}

// 仅从原始证据生成另一个全新公开副本。保留原件；HOME、完整 env、运行时和缓存从不进入副本。
// ZIP 内的 trace/network/snapshot 也逐成员脱敏，不因扩展名是 zip 而漏掉随机 Gateway 密钥。
export async function publishEvidence({ roots, output }) {
  output = path.resolve(output); physical(output); assert.ok(!fs.existsSync(output), '公开输出必须全新')
  for (const [label, root] of Object.entries(roots)) {
    assert.match(label, /^[a-z][a-z0-9-]*$/); physical(root)
    assert.ok(fs.statSync(root).isDirectory() && !within(root, output) && !within(output, root), '公开输出与原始证据不得重叠')
  }
  const source = String.raw`
import sys,json,pathlib,os,re,hashlib,zipfile,io
plan=json.load(sys.stdin);out=pathlib.Path(plan['output']);out.mkdir(parents=True,exist_ok=False)
denied={'h','home','t','tmp','source','node_modules','.hermes','.env','.git','.npm-cache','.uv-cache','.browsers','cache','caches'}
deniedfiles={'isolationenv.json','environment.json','env.json'}
extensions={'.json','.jsonl','.log','.txt','.md','.png','.zip'}
secrets=set();files=[];manifest=[]
def linked(p):return p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction())
def remember(v):
 v=v.strip().strip('"\'')
 if len(v)>=8 and not v.startswith('[REDACTED') and v not in {'qualification-local-no-secret'}:secrets.add(v)
def discover(t):
 for m in re.finditer(r'(?im)^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*([^\r\n]+)',t):remember(m[1])
 for m in re.finditer(r'(?i)["\'](?:API_SERVER_KEY|apiKey|api_key|accessPassword|gateway_token|gatewayToken|token|secret|password|authorization)["\']\s*:\s*["\']([^"\'\r\n]{8,})["\']',t):remember(m[1].removeprefix('Bearer '))
 for m in re.finditer(r'(?i)\bBearer\s+([A-Za-z0-9._~+/-]{8,})',t):remember(m[1])
def texts(data,iszip):
 if iszip:
  with zipfile.ZipFile(io.BytesIO(data)) as z:
   for n in z.namelist():
    try:yield z.read(n).decode('utf-8')
    except UnicodeDecodeError:pass
 else:
  try:yield data.decode('utf-8')
  except UnicodeDecodeError:pass
for label,r in plan['roots'].items():
 root=pathlib.Path(r)
 # 只读取已知测试 HOME 的 dotenv 用于脱敏，不枚举/公开私有运行时、数据库或缓存。
 for rel in ['h/.hermes/.env','runtime/home/.hermes/.env','runtime-final/home/.hermes/.env','runtime-at-timeout/home/.hermes/.env']:
  p=root/rel
  if p.is_file() and not any(linked(x) for x in [p,*list(p.parents)[:len(pathlib.Path(rel).parts)]]):discover(p.read_text(encoding='utf-8-sig'))
 for current,dirs,names in os.walk(root,followlinks=False):
  dirs[:]=[d for d in sorted(dirs) if d.lower() not in denied and not linked(pathlib.Path(current,d))]
  for name in sorted(names):
   p=pathlib.Path(current,name)
   if linked(p) or name.lower() in denied or name.lower() in deniedfiles or p.suffix.lower() not in extensions:continue
   data=p.read_bytes();iszip=p.suffix.lower()=='.zip'
   for text in texts(data,iszip):discover(text)
   files.append((label,p.relative_to(root),data,iszip))
ordered=sorted(secrets,key=len,reverse=True)
def scrub(data):
 try:t=data.decode('utf-8')
 except UnicodeDecodeError:return data
 for secret in ordered:t=t.replace(secret,'[REDACTED]')
 return t.encode('utf-8')
for label,rel,data,iszip in files:
 if iszip:
  b=io.BytesIO()
  with zipfile.ZipFile(io.BytesIO(data)) as original,zipfile.ZipFile(b,'w') as public:
   for info in original.infolist():
    assert not pathlib.PurePosixPath(info.filename).is_absolute() and '..' not in pathlib.PurePosixPath(info.filename).parts,'trace member path escape'
    public.writestr(info,scrub(original.read(info.filename)))
  clean=b.getvalue()
 else:clean=scrub(data)
 dest=out/label/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(clean)
 manifest.append({'path':str(pathlib.PurePosixPath(label,*rel.parts)),'rawSha256':hashlib.sha256(data).hexdigest(),'publishedSha256':hashlib.sha256(clean).hexdigest(),'redactedOrRepacked':clean!=data})
summary={'schemaVersion':1,'scope':'sanitized evidence copy; original status/assertions unchanged; not a qualification upgrade','privateHomeUploaded':False,'fullEnvironmentUploaded':False,'redactedValueHashes':sorted(hashlib.sha256(s.encode()).hexdigest() for s in secrets),'files':manifest}
(out/'publication-manifest.json').write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps({'files':len(files),'privateHomeUploaded':False,'fullEnvironmentUploaded':False}))
`
  const env = {}; for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k]
  Object.assign(env, { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' })
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', source], { env, input: JSON.stringify({ roots, output }), encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(r.status, 0, `公开副本失败；不上传原件: ${r.stderr}`); return JSON.parse(r.stdout)
}

export function validatePrivateCompletion(r, expected) {
  assert.ok(r && r.version === expected.version && r.commit === expected.commit, 'private completion 版本/commit 缺失或不匹配')
  for (const p of [r.python, ...['hermes_cli.main', 'fastapi', 'uvicorn'].map(k => r.modules?.[k])]) assert.ok(typeof p === 'string' && within(expected.home, p), 'private completion 路径越出 HOME')
  if (expected.version === '0.22.2') {
    assert.deepEqual(r.requiredStages, ['repository', 'venv', 'python-deps', 'config', 'complete'], 'private completion 22.2 实际五 stage 不符')
    const pm = r.pm, managed = path.join(expected.home, '.hermes')
    assert.ok(pm && r.python === pm.selectedStorePython && within(path.join(managed, 'tools'), r.python) && typeof pm.dependencyPython === 'string' && within(path.join(managed, 'installs'), pm.dependencyPython) && pm.dependencyPython !== r.python, 'private completion 混淆 dependency Python 与 selected store Python')
    assert.ok(r.commandSpec?.program === pm.dependencyPython && r.commandSpec.role === 'pm-bootstrap-metadata' && r.commandSpec.args?.[0] === '-I', 'private completion 缺真实 command spec')
    for (const proof of [pm.completion, pm.preflight]) assert.ok(proof?.commit === expected.commit && proof.current === true && proof.same === true && proof.completed === true, 'private completion/products/preflight 回执缺失')
    assert.equal(pm.completion.pending, false, 'private completion 仍有 pending debt')
    assert.deepEqual(pm.preflight.command, ['profile', 'list'], 'private completion 未通过原 preflight Python helper')
  } else assert.ok(typeof r.cli === 'string' && within(expected.home, r.cli), 'private completion 旧 CLI 越界')
  assert.ok(r.requiredStages?.length >= 5 && r.requiredStages.every(name => r.stages?.some(s => s.name === name && s.exitCode === 0)), 'private completion 缺真实安装阶段成功回执')
}

// 固定 f976/d923 agent/title_generator.py：完整prompt与R26实际wire核验；不扩展旧前缀。
export function matchesPinnedTitleRequest(body, evidence) {
  const record = (value, keys) => {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
    const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors)
    return own.length === keys.length && keys.every(k => Object.hasOwn(descriptors, k) && descriptors[k].enumerable && Object.hasOwn(descriptors[k], 'value'))
  }
  const exact = (value, expected) => {
    if (expected === null || typeof expected !== 'object') return value === expected
    const keys = Object.keys(expected)
    if (Array.isArray(expected)) {
      if (!Array.isArray(value) || value.length !== expected.length || Reflect.ownKeys(value).length !== keys.length + 1) return false
    } else if (!record(value, keys)) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return keys.every(k => Object.hasOwn(descriptors[k] || {}, 'value') && exact(descriptors[k].value, expected[k]))
  }
  if (!evidence || evidence.method !== 'POST' || evidence.path !== '/v1/chat/completions' || evidence.authenticated !== true || !['f97608f178d1ffeca59860195ab7da295f7c8e5f', 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'].includes(evidence.pin)) return false
  const family = evidence.nonceFamily === undefined ? 'web' : evidence.nonceFamily
  if (!['web', 'native', 'native-web-compat'].includes(family)) return false
  const noncePattern = family === 'web' ? /^hq-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/ : /^native-acceptance-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
  if (!record(body, ['messages', 'model', 'reasoning_effort', 'response_format']) || !Array.isArray(evidence.models) || !evidence.models.includes(body.model) || !Array.isArray(evidence.calls)) return false
  if (!Array.isArray(body.messages) || body.messages.length !== 2 || Reflect.ownKeys(body.messages).length !== 3 || !body.messages.every(m => record(m, ['role', 'content']))) return false
  const [system, user] = body.messages
  const nonce = family === 'native-web-compat' ? evidence.nonce : user.content
  if (system.role !== 'system' || typeof system.content !== 'string' || crypto.createHash('sha256').update(system.content).digest('hex') !== '3f1eef0616ddd2c13d45a3f8cef4ed648dadfdacdba7fbedceebf5a04d549998' || user.role !== 'user' || typeof user.content !== 'string' || typeof nonce !== 'string' || !noncePattern.test(nonce)) return false
  if (family === 'native-web-compat' && (evidence.pin !== 'f97608f178d1ffeca59860195ab7da295f7c8e5f' || user.content !== `Unicode 中文 🦀 café é ${nonce}`)) return false
  const format = { type: 'json_schema', json_schema: { name: 'session_title', strict: true, schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } }
  if (body.reasoning_effort !== 'none' || !exact(body.response_format, format)) return false
  const prior = evidence.calls.filter(c => c.purpose === 'chat' && c.authenticated === true && c.stream === true && c.nonce === nonce && c.model === body.model)
  return prior.length === 1 && (family !== 'native-web-compat' || prior[0].openingMessageSha256 === crypto.createHash('sha256').update(user.content).digest('hex')) && !evidence.calls.some(c => c.purpose === 'title' && c.nonce === nonce)
}

// 仅精确已核strict标题合同返回JSON content；其余路径保持原响应文本。
export function qualificationProviderReply(body, nonce, evidence = null) {
  const input = evidence?.nonceFamily === 'native-web-compat' ? `Unicode 中文 🦀 café é ${nonce}` : nonce
  if (matchesPinnedTitleRequest(body, evidence) && input === body.messages[1].content) return JSON.stringify({ title: `Hermes qualification ${nonce} ${body.model}` })
  return `Hermes qualification reply ${nonce} ${body.model}.`
}

export function classifyProviderRequest(body, evidence = null) {
  const system = (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n').trim()
  if (/^(?:You are a title generator\.|Create a concise title for an AI coding-assistant session|You generate concise (?:chat|conversation) titles)/.test(system)) return 'title'
  if (matchesPinnedTitleRequest(body, evidence)) return 'title'
  if (/^(?:You are Hermes(?: Agent)?[, .]|You are (?:an? |a helpful )AI assistant)/.test(system)) return 'chat'
  return 'unattributed'
}

// 独立检查原一次status的HTTP与原exec闭环；旧health、UI或passed自述均不替代本项。
export function assertGatewayStatusReadback(r) {
  assert.ok(r?.schemaVersion === 1 && r.status === 'passed' && r.requestFailed === false, 'STATUS_READBACK_MISSING_OR_FAILED')
  assert.ok(r.api?.cmd === 'hermes_gateway_action' && Number.isInteger(r.api.status) && r.api.status >= 200 && r.api.status < 300, 'STATUS_HTTP_FAILED')
  const text = r.api.result
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024 && text.trim() && !/^unknown$/i.test(text.trim()), 'STATUS_VALUE_INVALID')
  // 本隔离入口刚启动自己的Gateway；帮助文字/未运行状态不算运行回读。
  assert.ok(/(?:^|\n)\s*(?:✓\s*)?Gateway is running\b/.test(text), 'STATUS_NOT_RUNNING')
  assert.ok(Array.isArray(r.exec) && r.exec.length === 3, 'STATUS_EXEC_EVIDENCE_MISSING')
  const [start, result, close] = r.exec
  assert.deepEqual(r.exec.map(e => e.event), ['execFile-start', 'execFile-result', 'execFile-close'], 'STATUS_EXEC_ORDER')
  assert.deepEqual(start.command, ['gateway', 'status'], 'STATUS_EXEC_COMMAND')
  assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0 && Number.isSafeInteger(start.callId) && start.callId > 0 && r.exec.every(e => e.pid === start.pid && e.callId === start.callId && typeof e.utc === 'string' && Number.isFinite(Date.parse(e.utc))), 'STATUS_EXEC_IDENTITY')
  assert.ok(result.source === 'callback' && result.error === null && (result.code === null || result.code === 0) && result.signal === null && result.killed === false, 'STATUS_EXEC_FAILED')
  assert.ok(close.code === 0 && close.error === null && close.signal === null && close.killed === false, 'STATUS_EXEC_CLOSE_FAILED')
  assert.ok(typeof result.stdout === 'string' && result.stdoutTruncated === false && result.stdout.trim() === text.trim(), 'STATUS_EXEC_OUTPUT_MISMATCH')
}

// request只执行原API一次；失败转为独立红收据，后续UI/生命周期照常取证，不重试或等额外close。
export async function collectGatewayStatusReadback({ request, apiReceipts, readExecEvents }) {
  const cursor = apiReceipts.length, r = { schemaVersion: 1, status: 'failed', requestFailed: false, startedAt: new Date().toISOString() }
  try { await request() } catch { r.requestFailed = true }
  try {
    const receipts = apiReceipts.slice(cursor)
    assert.equal(receipts.length, 1, 'STATUS_API_RECEIPT_COUNT')
    const receipt = receipts[0]
    r.api = { cmd: receipt.cmd, status: receipt.status, result: typeof receipt.result === 'string' && Buffer.byteLength(receipt.result) <= 1024 * 1024 ? receipt.result : null }
    const events = readExecEvents(), starts = events.filter(e => e.event === 'execFile-start' && Array.isArray(e.argv) && e.argv.at(-2) === 'gateway' && e.argv.at(-1) === 'status')
    assert.equal(starts.length, 1, 'STATUS_EXEC_START_COUNT')
    const start = starts[0]
    r.exec = events.filter(e => e.callId === start.callId && e.pid === start.pid && e.event?.startsWith('execFile-')).map(e => {
      const row = Object.fromEntries(['event', 'callId', 'pid', 'utc', 'source', 'code', 'signal', 'killed'].filter(k => Object.hasOwn(e, k)).map(k => [k, e[k]]))
      if (e.event === 'execFile-start') row.command = e.argv.slice(-2)
      if (Object.hasOwn(e, 'error')) row.error = e.error === null ? null : Object.fromEntries(['name', 'code', 'signal', 'killed', 'errno', 'syscall'].filter(k => Object.hasOwn(e.error, k)).map(k => [k, e.error[k]]))
      if (e.event === 'execFile-result') { row.stdout = e.stdout; row.stdoutTruncated = e.stdoutTruncated }
      return row
    })
    r.status = 'passed'; assertGatewayStatusReadback(r)
  } catch { r.status = 'failed'; r.failure = 'STATUS_READBACK_FAILED' }
  r.finishedAt = new Date().toISOString()
  return r
}

// 只使用原status那一次exec的已落盘stderr；即使原CLI失败仍保留可解析观察，绝不改其结论。
export function collectStatusTailReadback({ readback, execEvents }) {
  const r = { status: 'failed', qualificationPass: false, originalCliPassed: false, scope: 'same original status execFile.stderr; diagnostic only' }
  try { assertGatewayStatusReadback(readback); r.originalCliPassed = true } catch { /* 原失败在独立断言中优先抛出。 */ }
  try {
    const start = readback?.exec?.[0]
    assert.ok(start?.event === 'execFile-start' && Number.isSafeInteger(start.pid) && start.pid > 0 && Number.isSafeInteger(start.callId) && start.callId > 0, 'STATUS_TAIL_EXEC_IDENTITY')
    assert.ok(Array.isArray(execEvents), 'STATUS_TAIL_EXEC_MISSING')
    const results = execEvents.filter(e => e.event === 'execFile-result' && e.callId === start.callId && e.pid === start.pid)
    assert.equal(results.length, 1, 'STATUS_TAIL_RESULT_COUNT')
    const result = results[0]
    assert.ok(result.source === 'callback' && typeof result.stderr === 'string' && result.stderrTruncated === false && Buffer.byteLength(result.stderr) <= 1048576, 'STATUS_TAIL_STDERR_MISSING_OR_TRUNCATED')
    r.stderr = { bytes: Buffer.byteLength(result.stderr), sha256: digest(result.stderr), callId: start.callId, pid: start.pid }
    r.observation = decodeStatusTailObservation(result.stderr, { rootPid: start.pid })
    if (r.originalCliPassed) r.status = 'diagnostic-only-not-qualification'
  } catch (error) {
    // 只留固定诊断码，不复制原stderr、Error.cmd或任意异常文本。
    const match = String(error?.message || '').match(/^STATUS_TAIL_[A-Z0-9_]+$/)
    r.observationError = match ? match[0] : 'STATUS_TAIL_EVIDENCE_INVALID'
  }
  return r
}

export function assertStatusTailReadback(readback, r) {
  assertGatewayStatusReadback(readback)
  assert.ok(r?.status === 'diagnostic-only-not-qualification' && r.originalCliPassed === true && r.qualificationPass === false && r.observation?.diagnosticValid === true, 'STATUS_TAIL_DIAGNOSTIC_INCOMPLETE')
}

export function qualificationStatus(r) {
  try { assertGatewayStatusReadback(r.gatewayStatusReadback) } catch { return 'failed' }
  if (r.diagnostic?.enabled) return r.hostUnchanged === true ? 'diagnostic-only-not-qualification' : 'failed'
  if (!STAGES.every(name => r.stages?.some(s => s.name === name && s.status === 'passed')) || !r.hostUnchanged) return 'failed'
  const b = r.browser
  if (!b?.actualChromium || !b.trace || !b.screenshots?.length || b.pageErrors?.length !== 0 || !b.completeReply || !b.historyAfterReload) return 'failed'
  // 本入口没有 native GUI driver；拒绝用外部 passed 自述升级证据。
  return 'passed-web-native-missing'
}

// 固定old/new进程HERMES_HOME路径；仅本轮已准入的home/.hermes，不枚举HOME或跟随record中的路径。
// 三件并非原子快照；不探测/获取文件锁。任何缺失、拒绝、读取冲突或不稳定均明确不完整。
export function captureHermesGatewayStateFiles(home, phase) {
  assert.ok(['before-status', 'after-status'].includes(phase), '未知status文件取证阶段')
  const limits = { perFileBytes: 65536, totalBytes: 131072 }
  const names = ['gateway.pid', 'gateway.lock', 'gateway_state.json']
  const r = { schemaVersion: 1, phase, status: 'incomplete', atomic: false, lockProbe: 'not-performed', limits, bytesRead: 0, startedAt: new Date().toISOString(), files: [] }
  const fail = code => { throw Object.assign(new Error('status file read rejected'), { code }) }
  const canonical = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  const directory = p => {
    physical(p)
    const s = fs.lstatSync(p, { bigint: true })
    if (!s.isDirectory() || s.isSymbolicLink() || canonical(fs.realpathSync.native(p)) !== canonical(p)) fail('UNSAFE_PATH')
    return s
  }
  const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino
  const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs && a.nlink === b.nlink
  const identity = s => ({ device: String(s.dev), inode: String(s.ino), links: Number(s.nlink), createdNs: String(s.birthtimeNs), modifiedNs: String(s.mtimeNs) })
  const reason = error => ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EAGAIN', 'EIO', 'EINVAL', 'ELOOP', 'ENOTDIR', 'UNSAFE_PATH', 'FILE_CHANGED', 'SHORT_READ'].includes(error?.code) ? error.code : 'READ_ERROR'
  let root, owner, base
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0') || home.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH')
    home = path.resolve(home); owner = directory(home); root = path.join(home, '.hermes'); base = directory(root)
  } catch (error) {
    r.files = names.map(file => ({ file, status: error.code === 'ENOENT' ? 'missing' : 'rejected', reason: reason(error), bytesRead: 0 }))
    r.finishedAt = new Date().toISOString(); return r
  }
  // 仅输出typed身份与枚举；自由字符串/完整argv/privatecode/凭据不导出，不使用异常message。
  const project = (value, file) => {
    if (Number.isSafeInteger(value) && value > 0 && file !== 'gateway_state.json') return { format: 'bare-pid', pid: value }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RECORD_TYPE')
    const record = { format: 'json-object' }, positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0
    if (Number.isSafeInteger(value.pid) && value.pid > 0) record.pid = value.pid
    if (value.kind === 'hermes-gateway') record.kind = value.kind
    else if (Object.hasOwn(value, 'kind')) record.kindSha256 = digest(JSON.stringify(value.kind))
    if (positive(value.start_time)) record.startTime = value.start_time
    if (Object.hasOwn(value, 'argv')) { record.argvSha256 = digest(JSON.stringify(value.argv)); if (Array.isArray(value.argv)) record.argvCount = value.argv.length }
    if (typeof value.hermes_home === 'string') record.hermesHome = { sha256: digest(value.hermes_home), matchesPrivateHome: !value.hermes_home.includes('\0') && path.isAbsolute(value.hermes_home) && canonical(value.hermes_home) === canonical(root) }
    const legacy = value.clawpanel_legacy_identity
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      const p = {}
      if (positive(legacy.create_time)) p.createTime = legacy.create_time
      if (typeof legacy.script_sha256 === 'string' && /^[a-f0-9]{64}$/.test(legacy.script_sha256)) p.scriptSha256 = legacy.script_sha256
      if (['f97608f178d1ffeca59860195ab7da295f7c8e5f', 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'].includes(legacy.pin)) p.pin = legacy.pin
      record.legacyIdentity = p
    }
    if (['starting', 'running', 'stopped', 'startup_failed', 'degraded', 'stopping', 'shutting_down'].includes(value.gateway_state)) record.gatewayState = value.gateway_state
    if (['running', 'stopped'].includes(value.desired_state)) record.desiredState = value.desired_state
    if (typeof value.updated_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value.updated_at) && Number.isFinite(Date.parse(value.updated_at))) record.updatedAt = value.updated_at
    return record
  }
  for (const file of names) {
    const row = { file, status: 'read-failed', bytesRead: 0 }; r.files.push(row)
    const target = path.join(root, file)
    try {
      if (!sameNode(owner, directory(home)) || !sameNode(base, directory(root))) fail('FILE_CHANGED')
      const before = fs.lstatSync(target, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino <= 0n) { row.status = 'rejected'; fail('UNSAFE_PATH') }
      physical(target)
      if (!within(root, fs.realpathSync.native(target))) { row.status = 'rejected'; fail('UNSAFE_PATH') }
      row.fileIdentity = identity(before); row.declaredBytes = String(before.size)
      if (before.size > BigInt(limits.perFileBytes) || before.size > BigInt(limits.totalBytes - r.bytesRead)) {
        row.status = 'over-budget'; row.reason = before.size > BigInt(limits.perFileBytes) ? 'FILE_BYTES' : 'TOTAL_BYTES'; continue
      }
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
      let bytes
      try {
        const opened = fs.fstatSync(fd, { bigint: true })
        if (!opened.isFile() || !sameFile(before, opened) || !sameNode(owner, directory(home)) || !sameNode(base, directory(root)) || canonical(fs.realpathSync.native(target)) !== canonical(target)) fail('FILE_CHANGED')
        bytes = Buffer.alloc(Number(before.size))
        while (row.bytesRead < bytes.length) {
          const n = fs.readSync(fd, bytes, row.bytesRead, bytes.length - row.bytesRead, row.bytesRead)
          if (!n) fail('SHORT_READ')
          row.bytesRead += n; r.bytesRead += n
        }
        const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(target, { bigint: true })
        if (!sameFile(before, after) || !sameFile(before, current) || current.isSymbolicLink() || !sameNode(owner, directory(home)) || !sameNode(base, directory(root)) || canonical(fs.realpathSync.native(target)) !== canonical(target)) fail('FILE_CHANGED')
      } finally { fs.closeSync(fd) }
      row.bytes = bytes.length; row.sha256 = digest(bytes)
      try {
        if (!bytes.length) fail('EMPTY_FILE')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        row.record = project(JSON.parse(text), file); row.status = 'captured'
      } catch { row.status = 'invalid-record'; row.reason = 'INVALID_RECORD' }
    } catch (error) { if (error.code === 'ENOENT') row.status = 'missing'; else if (error.code === 'UNSAFE_PATH') row.status = 'rejected'; row.reason = reason(error) }
  }
  r.status = r.files.every(f => f.status === 'captured') ? 'complete' : 'incomplete'
  r.finishedAt = new Date().toISOString(); return r
}

function physical(file) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), `路径含 reparse/symlink: ${p}`)
    if (p === path.dirname(p)) break
  }
  return file
}
// 调用子进程前固定 checkout；后续命令 cwd 已切换到私有导出目录。
export function resolveQualificationCheckout(file, cwd = process.cwd()) {
  return physical(path.resolve(cwd, file))
}
// 只采集本轮测试HOME中的固定运行日志；故障前后分开，不上传整个HOME或缓存。
export function captureHermesRuntimeLogs(home, output, phase) {
  assert.ok(['before-stop', 'after-stop'].includes(phase), '未知日志阶段')
  const source = physical(path.resolve(home, '.hermes')), destination = physical(path.resolve(output, 'runtime-logs', phase))
  assert.ok(within(path.resolve(home), source) && within(path.resolve(output), destination))
  assert.ok(!fs.existsSync(destination), '日志阶段输出必须全新'); fs.mkdirSync(destination, { recursive: true })
  return ['gateway-run.log', 'dashboard-run.log', 'logs/gateway.log', 'logs/errors.log'].map(sourceRelative => {
    const file = physical(path.join(source, sourceRelative))
    if (!fs.existsSync(file)) return { sourceRelative, missing: true }
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), '运行日志必须是普通文件')
    const fd = fs.openSync(file, 'r')
    try {
      const totalBytes = fs.fstatSync(fd).size, capturedBytes = Math.min(totalBytes, 1024 * 1024)
      const data = Buffer.alloc(capturedBytes), readBytes = fs.readSync(fd, data, 0, capturedBytes, Math.max(0, totalBytes - capturedBytes))
      assert.equal(readBytes, capturedBytes, '日志读取过程中发生截断；保留失败')
      const target = path.join(destination, sourceRelative.replaceAll('/', '_'))
      fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' })
      return { sourceRelative, file: path.relative(output, target), totalBytes, capturedBytes, truncated: totalBytes > capturedBytes, sha256: digest(data) }
    } finally { fs.closeSync(fd) }
  })
}
// 已经失败后的单次只读观察：保留原红灯，仅区分进程失败与晚就绪，不延长产品启动门禁。
export async function observeFailedGatewayStartup({ isOpen, readHealth, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const started = now(), r = { scope: 'post-failure-observation-not-acceptance', qualificationPass: false, becameReachable: false, samples: [] }
  while (now() - started < 20000) {
    const open = await isOpen(); r.samples.push({ elapsedMs: now() - started, portOpen: open })
    if (open) { r.becameReachable = true; try { r.health = await readHealth() } catch (error) { r.healthError = String(error) }; break }
    await pause(Math.min(500, 20000 - (now() - started)))
  }
  r.elapsedMs = now() - started
  return r
}
function ps(code) {
  // Windows PowerShell 5.1 自行建立模块路径，不继承 PS7 的不兼容模块；仅改子环境副本。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  // PS5 默认代码页会把弯引号最佳匹配为未转义 ASCII 引号，破坏 CIM JSON。
  // 在 JSON 序列化前固定 stdout 编码；不丢字段、不截断命令或放宽原门禁。
  code = '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n' + code
  const started = Date.now()
  const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  const phaseTimings = []
  for (const match of (r.stderr || '').matchAll(/CLAWPANEL_HOST_PHASE (\{[^\r\n]*\})/g)) {
    try {
      const p = JSON.parse(match[1])
      if (phaseTimings.length < 6 && ['init', 'registry', 'shells', 'launchers', 'execution-policy', 'complete'].includes(p.phase) && Number.isSafeInteger(p.elapsedMs) && p.elapsedMs >= 0) phaseTimings.push({ phase: p.phase, elapsedMs: p.elapsedMs })
    } catch { /* 诊断解析失败不伪造 canary 成功；原退出码仍严格判断。 */ }
  }
  // 只输出固定白名单字段，不输出命令、环境或 registry 值；时间线不进入宿主指纹。
  const diagnostic = 'CLAWPANEL_PS_DIAGNOSTICS ' + JSON.stringify({ status: r.status ?? null, signal: r.signal ?? null, errorCode: r.error?.code ?? null, elapsedMs: Date.now() - started, phaseTimings })
  if (r.status !== 0 || phaseTimings.length) console.error(diagnostic)
  assert.equal(r.status, 0, `${diagnostic}\n${r.stderr || ''}`); return JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
}
export function actualRunnerProof() {
  assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Windows 资格门禁：本机/自托管不启动候选')
  const local = ps(`$id=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$id.User.Value;$p=(Get-ItemProperty -LiteralPath ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$sid)).ProfileImagePath;$c=Get-CimInstance Win32_ComputerSystem;@{sid=$sid;userName=($id.Name -split '\\\\')[-1];actualProfile=[Environment]::GetFolderPath('UserProfile');registeredProfile=$p;virtualMachine=($c.Model -match 'Virtual Machine')}|ConvertTo-Json`)
  const git = spawnSync('git', ['--no-optional-locks', '-C', tooling, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }); assert.equal(git.status, 0)
  return { ...local, platform: process.platform, arch: process.arch, runnerEnvironment: process.env.RUNNER_ENVIRONMENT, runnerOS: process.env.RUNNER_OS, event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY, workflowRef: process.env.GITHUB_WORKFLOW_REF, workflowSha: process.env.GITHUB_WORKFLOW_SHA, toolingSha: git.stdout.trim(), runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion }
}

// 只读 reparse point 自身，不跟随/执行 AppExecLink；原始数据读取或普通文件 hash 失败均抛错。
export function windowsPathFingerprintSource() {
  // 逐文件诊断仅记录序号/阶段/本PS进程CPU；512是日志额度，不是扫描额度。诊断失败不改变原指纹或异常。
  // 仅launcher普通文件延后hash；同进程最多两个pipeline/等待句柄，前后metadata复核，任一错误整次失败。
  // worker复用原literal hash函数，EndInvoke只解包真实ErrorRecord；shell/default不使用pool。
  // 固定文本仅去行首缩进以保留原EncodedCommand/32767门禁，不换传输、不压缩或删减原检查。
  return String.raw`
if(-not ('ClawPanelReparseReader' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public sealed class ClawPanelReparseFacts {
  public string ReparseTag, LinkType, Target, PrintName, DataSha256;
  public uint Version, Flags;
  public string[] Strings;
}
public static class ClawPanelReparseReader {
  const uint FILE_FLAG_OPEN_REPARSE_POINT=0x00200000, FILE_FLAG_BACKUP_SEMANTICS=0x02000000, FSCTL_GET_REPARSE_POINT=0x000900A8;
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle handle,uint control,IntPtr input,int inputSize,byte[] output,int outputSize,out int returned,IntPtr overlapped);
  public static byte[] Read(string path) {
    using(var handle=CreateFileW(path,0,7,IntPtr.Zero,3,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,IntPtr.Zero)) {
      if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      var buffer=new byte[16384];int returned;
      if(!DeviceIoControl(handle,FSCTL_GET_REPARSE_POINT,IntPtr.Zero,0,buffer,buffer.Length,out returned,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
      if(returned<8||returned>buffer.Length)throw new InvalidDataException("Invalid reparse size");
      Array.Resize(ref buffer,returned);return buffer;
    }
  }
  static string Utf16(byte[] data,int offset,int length) {
    if(offset<8||length<0||(length&1)!=0||offset>data.Length-length)throw new InvalidDataException("Invalid reparse string bounds");
    return new UnicodeEncoding(false,false,true).GetString(data,offset,length);
  }
  public static ClawPanelReparseFacts Decode(byte[] data) {
    if(data==null||data.Length<8)throw new InvalidDataException("Missing reparse header");
    uint tag=BitConverter.ToUInt32(data,0);int header=(tag&0x80000000)!=0?8:24;
    if(data.Length!=header+BitConverter.ToUInt16(data,4))throw new InvalidDataException("Invalid reparse data length");
    var facts=new ClawPanelReparseFacts{ReparseTag="0x"+tag.ToString("x8"),LinkType="Opaque",Strings=new string[0]};
    using(var hash=SHA256.Create())facts.DataSha256=BitConverter.ToString(hash.ComputeHash(data)).Replace("-","").ToLowerInvariant();
    if(tag==0x8000001b) {
      if(data.Length<14||BitConverter.ToUInt32(data,8)<3)throw new InvalidDataException("Invalid AppExecLink header");
      string text=Utf16(data,12,data.Length-12);
      if(!text.EndsWith("\0",StringComparison.Ordinal))throw new InvalidDataException("Unterminated AppExecLink");
      facts.Strings=text.TrimEnd('\0').Split('\0');
      if(facts.Strings.Length<3||String.IsNullOrEmpty(facts.Strings[0])||String.IsNullOrEmpty(facts.Strings[1])||String.IsNullOrEmpty(facts.Strings[2]))throw new InvalidDataException("Missing AppExecLink target");
      facts.Version=BitConverter.ToUInt32(data,8);facts.LinkType="AppExecLink";facts.Target=facts.Strings[2];
    } else if(tag==0xa000000c||tag==0xa0000003) {
      int start=tag==0xa000000c?20:16;
      if(data.Length<start)throw new InvalidDataException("Missing link offsets");
      facts.Target=Utf16(data,start+BitConverter.ToUInt16(data,8),BitConverter.ToUInt16(data,10));
      facts.PrintName=Utf16(data,start+BitConverter.ToUInt16(data,12),BitConverter.ToUInt16(data,14));
      facts.LinkType=tag==0xa000000c?"SymbolicLink":"MountPoint";
      if(tag==0xa000000c)facts.Flags=BitConverter.ToUInt32(data,16);
    }
    return facts;
  }
}
'@}
function Write-ClawPanelFingerprintStage($trace,$stage,$event,$bytes){
  if($null -eq $trace){return}
  try{
    $b=if($trace.budget){$trace.budget}else{$trace};[Threading.Monitor]::Enter($b)
    try{
    if($b.records -ge 512){return};$b.records++
    $cpu=[int64]$trace.process.TotalProcessorTime.TotalMilliseconds
    [Console]::Error.WriteLine('CLAWPANEL_LAUNCHER_FILE {"directoryIndex":'+$trace.directoryIndex+',"fileIndex":'+$trace.fileIndex+',"stage":"'+$stage+'","event":"'+$event+'","bytes":'+$bytes+',"elapsedMs":'+$trace.clock.ElapsedMilliseconds+',"cpuMs":'+$cpu+'}')
    }finally{[Threading.Monitor]::Exit($b)}
  }catch{}
}
function Get-ClawPanelPathFingerprint($p,$trace=$null,$defer=$false){
  $k='attributes';$z=0L
  try{
    Write-ClawPanelFingerprintStage $trace $k 'begin' $z
    try{$a=[IO.File]::GetAttributes($p)}catch [IO.FileNotFoundException]{Write-ClawPanelFingerprintStage $trace $k 'absent' $z;return [ordered]@{kind='absent';sha256=$null}}catch [IO.DirectoryNotFoundException]{Write-ClawPanelFingerprintStage $trace $k 'absent' $z;return [ordered]@{kind='absent';sha256=$null}}
    Write-ClawPanelFingerprintStage $trace $k 'end' $z
    $k='item';Write-ClawPanelFingerprintStage $trace $k 'begin' $z
    $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
    Write-ClawPanelFingerprintStage $trace $k 'end' $z
    if(($a -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      $k='reparse';Write-ClawPanelFingerprintStage $trace $k 'begin' $z
      $r=[ClawPanelReparseReader]::Decode([ClawPanelReparseReader]::Read($p))
      $metadata=[ordered]@{attributes=[int64]$a;bytes=$(if($item.PSIsContainer){$null}else{[int64]$item.Length});createdUtc=$item.CreationTimeUtc.Ticks;modifiedUtc=$item.LastWriteTimeUtc.Ticks;reparseTag=$r.ReparseTag;linkType=$r.LinkType;target=$r.Target;printName=$r.PrintName;flags=$r.Flags;version=$r.Version;strings=@($r.Strings);dataSha256=$r.DataSha256}
      $fingerprint=[ordered]@{kind='reparse';sha256=$null;reparseTag=$r.ReparseTag;linkType=$r.LinkType;target=$r.Target;metadata=$metadata;metadataSha256=(Get-ClawPanelUtf8Sha256 (ConvertTo-Json -InputObject $metadata -Depth 4 -Compress))}
      Write-ClawPanelFingerprintStage $trace $k 'end' $z;return $fingerprint
    }
    if($item.PSIsContainer){return [ordered]@{kind='directory';sha256=$null;attributes=[int64]$a}}
    $sha256=$null;if(!$defer){
    $k='filehash';$z=[int64]$item.Length;Write-ClawPanelFingerprintStage $trace $k 'begin' $z
    $sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash
    Write-ClawPanelFingerprintStage $trace $k 'end' $z}
    return [ordered]@{kind='file';sha256=$sha256;bytes=[int64]$item.Length;attributes=[int64]$a}
  }catch{Write-ClawPanelFingerprintStage $trace $k 'failed' $z;throw}
}
function New-ClawHashPool{@{p=[runspacefactory]::CreateRunspacePool(1,2);j=@();q=@();c=('param($p,$e,$t);function Write-ClawPanelFingerprintStage{'+${'$'}{function:Write-ClawPanelFingerprintStage}+'};function fp{'+${'$'}{function:Get-ClawPanelPathFingerprint}+'};function stamp($i=$(Get-Item -LiteralPath $p -Force -ea Stop)){if($i.PSIsContainer -or ([int]$i.Attributes -band 1024)){throw "Changed"};@([int]$i.Attributes,$i.Length,$i.CreationTimeUtc.Ticks,$i.LastWriteTimeUtc.Ticks)-join ","};$ErrorActionPreference="Stop";$e=stamp $e;if((stamp)-ne $e){throw "Changed"};$r=fp $p $t;if((stamp)-ne $e){throw "Changed"};$r.sha256')}}
function Close-ClawDir($d){if(--$d.n -eq 0){Write-ClawPanelLauncherDirectory $d.i 'fingerprinted' $d.c $d.b}}
function Step-ClawPanelHash($s,$r,$f,$t){
  if($null-ne$s.q){
    if($r){$c=$t.Clone();$c.budget=$t;$s.q+=,@($r,$f,$c);$t.dir.n++;return}
    $q=@($s.q|Sort-Object {-$_[1].Length},{$s.q.IndexOf($_)});$s.q=$null
    foreach($e in $q){Step-ClawPanelHash $s @e}
  }
  if($s.j.Count -eq 2 -or (!$r -and $s.j.Count)){
    $n=[Threading.WaitHandle]::WaitAny([Threading.WaitHandle[]]@($s.j|%{$_.a.AsyncWaitHandle}));$j=$s.j[$n]
    try{try{$h=@($j.p.EndInvoke($j.a))}catch{$e=$_.Exception.InnerException;if($e.ErrorRecord){throw $e.ErrorRecord};throw};if($j.p.HadErrors -or $h.Count -ne 1 -or $h[0] -isnot [string] -or $h[0] -notmatch '^[a-f0-9]{64}$'){throw 'Invalid hash'};$j.r.sha256=$j.r.fingerprint.sha256=$h[0];Close-ClawDir $j.d}
    finally{$j.a.AsyncWaitHandle.Close();$j.p.Dispose();$s.j=@($s.j|?{$_ -ne $j})}
  }
  if($r){$p=[powershell]::Create();try{$p.RunspacePool=$s.p;$c=$t.Clone();$c.budget=$t.budget;[void]$p.AddScript($s.c).AddArgument($f.FullName).AddArgument($f).AddArgument($c);$s.j+=@{p=$p;a=$p.BeginInvoke();r=$r;d=$t.dir};$p=$null}finally{if($p){$p.Dispose()}}}
}
`.replace(/^ +/gm, '')
}

export function hostSnapshot(proof) {
  const profile64 = Buffer.from(proof.actualProfile).toString('base64')
  const data = ps(`
$ErrorActionPreference='Stop'
function Get-ClawPanelUtf8Sha256($s){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
$hostClock=[Diagnostics.Stopwatch]::StartNew()
function Write-ClawPanelHostPhase($phase){[Console]::Error.WriteLine('CLAWPANEL_HOST_PHASE {"phase":"'+$phase+'","elapsedMs":'+$hostClock.ElapsedMilliseconds+'}')}
Write-ClawPanelHostPhase 'init'
${windowsPathFingerprintSource()}
Write-ClawPanelHostPhase 'registry'
$registry=@();foreach($p in @('HKCU:\\Environment','HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment','HKCU:\\Software\\Microsoft\\Command Processor')){if(Test-Path -LiteralPath $p){$k=Get-Item -LiteralPath $p;foreach($n in ($k.GetValueNames()|Sort-Object)){$v=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$registry+=@{hive=$p;name=$n;kind=$k.GetValueKind($n).ToString();sha256=(Get-ClawPanelUtf8Sha256 (ConvertTo-Json -InputObject $v -Compress))}}}else{$registry+=@{hive=$p;absent=$true}}}
Write-ClawPanelHostPhase 'shells'
$real=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${profile64}'))
$shells=@();$paths=@($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost,"$real\\.bashrc","$real\\.bash_profile","$real\\.profile","$real\\.zshrc","$real\\Documents\\PowerShell\\profile.ps1","$real\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1")
foreach($p in ($paths|Sort-Object -Unique)){$fingerprint=Get-ClawPanelPathFingerprint $p;$shells+=@{path=$p;exists=($fingerprint.kind -ne 'absent');sha256=$fingerprint.sha256;fingerprint=$fingerprint}}
Write-ClawPanelHostPhase 'launchers'
$launchers=@();$dirs=@(($env:PATH -split ';')+@("$real\\AppData\\Roaming\\npm","$real\\.local\\bin","$real\\.hermes\\bin"))|Sort-Object -Unique
$launcherPrefixes=@('hermes','uv','node','npm','python','git');$di=0
$launcherFingerprintTrace=@{directoryIndex=0;fileIndex=0;records=0;clock=$hostClock;process=[Diagnostics.Process]::GetCurrentProcess()}
$hw=New-ClawHashPool
function Write-ClawPanelLauncherDirectory($index,$event,$count,$bytes){if($index -le 64){[Console]::Error.WriteLine('CLAWPANEL_LAUNCHER_DIRECTORY {"index":'+$index+',"event":"'+$event+'","count":'+$count+',"bytes":'+$bytes+',"elapsedMs":'+$hostClock.ElapsedMilliseconds+'}')}}
try{$hw.p.Open()
foreach($d in $dirs){if($d -and (Test-Path -LiteralPath $d)){
  $di++;Write-ClawPanelLauncherDirectory $di 'begin' 0 0
  $lf=@(@(foreach($prefix in $launcherPrefixes){Get-ChildItem -LiteralPath $d -Filter ($prefix+'*') -File -ErrorAction Stop})|Where-Object {$_.Name -match '^(hermes|uv|node|npm|python|git)([.-].*|[0-9.]*\\.exe|\\.cmd|\\.ps1)?$'}|Sort-Object FullName)
  $lb=0L;foreach($f in $lf){$lb+=$f.Length};Write-ClawPanelLauncherDirectory $di 'enumerated' $lf.Count $lb
  $t=$launcherFingerprintTrace;$t.directoryIndex=$di;$t.fileIndex=0;$t.dir=@{n=1;i=$di;c=$lf.Count;b=$lb}
  foreach($f in $lf){$t.fileIndex++;$fingerprint=Get-ClawPanelPathFingerprint $f.FullName $launcherFingerprintTrace $true;$row=@{path=$f.FullName;bytes=$f.Length;sha256=$fingerprint.sha256;fingerprint=$fingerprint};$launchers+=$row;if($fingerprint.kind -eq 'file'){Step-ClawPanelHash $hw $row $f $t}}
  Close-ClawDir $t.dir
}}
Step-ClawPanelHash $hw
while($hw.j.Count){Step-ClawPanelHash $hw}
}finally{foreach($j in $hw.j){$j.p.Stop();$j.a.AsyncWaitHandle.Close();$j.p.Dispose()};$hw.p.Dispose()}
Write-ClawPanelHostPhase 'execution-policy'
$executionPolicy=@(Get-ExecutionPolicy -List|ForEach-Object {@{scope=$_.Scope.ToString();value=$_.ExecutionPolicy.ToString()}})
Write-ClawPanelHostPhase 'complete'
@{registry=$registry;shells=$shells;launchers=$launchers;executionPolicy=$executionPolicy}|ConvertTo-Json -Depth 7`)
  return { ...data, parentEnvSha256: digest(JSON.stringify(Object.entries(process.env).sort())) }
}

// 派生记录只保留固定诊断字段；用于区分脚本前、reexec 与 main 后的未覆盖耗时。
export function createHermesPhaseReceiver(fs, file, childPid, observerPid, enabled) {
  if (!enabled || !Number.isSafeInteger(childPid) || childPid < 1) return () => {}
  const labels = new Set(['entry', 'src_b', 'src_e', 'store', 'reexec', 'imp_b', 'imp_e', 'cur_b', 'cur_e', 'debt1_b', 'debt1_e', 'act_b', 'act_e', 'state1_b', 'state1_e', 'prof_b', 'prof_e', 'boot_b', 'boot_e', 'state2_b', 'state2_e', 'debt2_b', 'debt2_e', 'policy_b', 'policy_e', 'preflight', 'main_b', 'main_exit', 'pyjson_b', 'pyjson_e', 'meta_b', 'meta_e'])
  const keys = ['schemaVersion', 'scope', 'phase', 'pid', 'ppid', 'sequence', 'elapsedMs', 'deltaMs']
  const decoder = new TextDecoder('utf-8'), started = process.hrtime.bigint(), streams = new Map()
  let buffered = '', dropping = false, bytes = 0, written = 0
  return chunk => {
    if (written >= 64 || bytes >= 131072) return
    try {
      // 是收完本 chunk 的观察时刻，不伪称 Python 发射时刻；同 chunk 共享锚点。
      const observedAt = new Date().toISOString(), spawnElapsedMs = Number(process.hrtime.bigint() - started) / 1e6
      bytes += chunk.byteLength
      if (bytes > 131072) return
      const fragments = decoder.decode(chunk, { stream: true }).split('\n')
      for (let index = 0; index < fragments.length && written < 64; index++) {
        const complete = index < fragments.length - 1
        if (dropping) { if (complete) dropping = false; continue }
        buffered += fragments[index]
        if (buffered.length > 4096) { buffered = ''; dropping = !complete; continue }
        if (!complete) continue
        const line = buffered.replace(/\r$/, ''); buffered = ''
        if (!line.startsWith('CLAWPANEL_HERMES_PHASE ')) continue
        try {
          const phase = JSON.parse(line.slice('CLAWPANEL_HERMES_PHASE '.length))
          if (!phase || Array.isArray(phase) || Object.keys(phase).length !== keys.length || !keys.every(key => Object.hasOwn(phase, key))) continue
          if (phase.schemaVersion !== 1 || !['launch', 'metadata'].includes(phase.scope) || !labels.has(phase.phase)) continue
          if (!Number.isSafeInteger(phase.pid) || phase.pid < 1 || !Number.isSafeInteger(phase.ppid) || phase.ppid < 0 || !Number.isSafeInteger(phase.sequence) || phase.sequence < 1) continue
          if (![phase.elapsedMs, phase.deltaMs].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12) || phase.deltaMs > phase.elapsedMs) continue
          const previous = streams.get(phase.pid)
          if ((!previous && streams.size >= 8) || (previous && (phase.sequence <= previous.sequence || phase.elapsedMs < previous.elapsedMs))) continue
          fs.appendFileSync(file, JSON.stringify({ event: 'hermes-phase', childPid, observerPid, observedAt, spawnElapsedMs, phase }) + '\n')
          streams.set(phase.pid, { sequence: phase.sequence, elapsedMs: phase.elapsedMs })
          written++
        } catch { /* 新诊断写失败不得改变子进程控制流或原始收据。 */ }
      }
    } catch { /* 保留原始 stderr/close 记录，不用诊断异常取代产品错误。 */ }
  }
}

// 只旁听真实 spawn 的参数/输出/退出，不替换返回值、环境、信号或阶段执行。
export function spawnAuditSource(log, diagnostic = null) {
  // execute仍只在真实VM准入后生成；内联可信tooling，不从候选目录加载观察器。
  const execObservation = `const createHermesExecFileObserver=${createHermesExecFileObserver.toString()};cp.execFile=createHermesExecFileObserver(cp.execFile,{write:event=>fs.appendFileSync(file,JSON.stringify(event)+'\\n'),secrets:['qualification-local-no-secret']});`
  const injection = diagnostic ? `const startHermesFilePhaseObservation=${startHermesFilePhaseObservation.toString()};const configFile=${JSON.stringify(diagnostic.configFile)};const prepareStartupDiagnosticSpawn=${prepareStartupDiagnosticSpawn.toString()};` : ''
  const prepare = diagnostic ? `let diagnosticConfig=null;let diagnosticSpawn=false;if(Array.isArray(args[1])&&fs.existsSync(configFile)){diagnosticConfig=JSON.parse(fs.readFileSync(configFile,'utf8'));const originalSpec={program:args[0],args:args[1],options:args[2]};const prepared=prepareStartupDiagnosticSpawn(originalSpec,diagnosticConfig);diagnosticSpawn=prepared!==originalSpec;args=[prepared.program,prepared.args,prepared.options]};` : ''
  const fileObservation = diagnostic ? `if(diagnosticSpawn&&child.pid){const receiver=phaseReceiver(fs,diagnosticConfig.phaseOutput,child.pid,process.pid,true);const stopFile=startHermesFilePhaseObservation({fs,path,file:diagnosticConfig.gatewayLog,receive:receiver,onFinish:receipt=>record({event:'hermes-file-observation',receipt})});child.once('close',()=>stopFile())};` : ''
  return `import cp from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {StringDecoder} from 'node:string_decoder';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;${injection}const file=${JSON.stringify(log)};const phaseReceiver=${createHermesPhaseReceiver.toString()};cp.spawn=function(...args){${prepare}const child=Reflect.apply(original,this,args);const a=Array.isArray(args[1])?args[1]:[];const i=a.findIndex(x=>String(x).toLowerCase()==='-stage');const record=v=>fs.appendFileSync(file,JSON.stringify({pid:child.pid,program:args[0],args:a,stage:i>=0?a[i+1]:null,...v,at:new Date().toISOString()})+'\\n');if(child.pid)record({event:'start'});const phase=phaseReceiver(fs,file,child.pid,process.pid,process.env.CLAWPANEL_HERMES_PHASE_TIMING==='1');const outDecoder=new StringDecoder('utf8'),errDecoder=new StringDecoder('utf8');${fileObservation}let stdout='',stderr='';child.stdout?.on('data',d=>{stdout=(stdout+(typeof d==='string'?d:outDecoder.write(d))).slice(-1048576)});child.stderr?.on('data',d=>{stderr=(stderr+(typeof d==='string'?d:errDecoder.write(d))).slice(-1048576);phase(d)});child.on('close',(code,signal)=>{stdout=(stdout+outDecoder.end()).slice(-1048576);stderr=(stderr+errDecoder.end()).slice(-1048576);record({event:'close',exitCode:code,signal,stdout,stderr})});return child};${execObservation}syncBuiltinESMExports();`
}

async function reachable(port) { return new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.on('connect', () => { s.destroy(); resolve(true) }); s.on('error', () => resolve(false)); s.setTimeout(750, () => { s.destroy(); resolve(false) }) }) }
// 显式JSON envelope：零行也有query与processes=[]，不把空stdout当作进程已退出。
export function hermesRuntimeProcessSnapshotSource({ home, pids }) {
  const byPid = pids !== undefined
  if (byPid) assert.ok(Array.isArray(pids) && pids.length > 0 && pids.length <= 256 && new Set(pids).size === pids.length && pids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'runtime terminal query requires nonempty exact PIDs')
  else assert.ok(typeof home === 'string' && home.length > 0, 'runtime observation requires private HOME')
  const prefix = byPid ? '' : `$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString('base64')}'));`
  const query = byPid ? `Get-CimInstance Win32_Process -Filter '${pids.map(pid => `ProcessId=${pid}`).join(' OR ')}' -ErrorAction Stop` : 'Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($h)}'
  const binding = byPid ? `@{kind='pids';pids=@(${pids.join(',')})}` : "@{kind='home'}"
  return `$ErrorActionPreference='Stop';${prefix}$rows=@(${query}|ForEach-Object {[pscustomobject]@{ProcessId=[int]$_.ProcessId;ParentProcessId=[int]$_.ParentProcessId;ExecutablePath=$_.ExecutablePath;CommandLine=${byPid ? '$null' : '$_.CommandLine'};CreationDate=$(if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null})}});ConvertTo-Json -InputObject @{schemaVersion=1;observedAt=[DateTime]::UtcNow.ToString('o');query=${binding};processes=@($rows)} -Depth 6 -Compress`
}
export function assertHermesRuntimeIdentities(rows, allowEmpty = false) {
  assert.ok(Array.isArray(rows) && (allowEmpty || rows.length > 0), 'STOP requires fresh nonempty preStop runtime identities')
  assert.ok(rows.length <= 256 && new Set(rows.map(row => row?.ProcessId)).size === rows.length, 'runtime identities duplicate/over-budget')
  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row?.ProcessId) && row.ProcessId > 0, 'runtime identity missing valid PID')
    assert.ok(typeof row.CreationDate === 'string' && /^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(row.CreationDate) && Number.isFinite(Date.parse(row.CreationDate)), 'runtime identity missing exact CreationDate')
  }
}
// 超时/其它网络错误是未知，不伪称关闭；沿用原本750ms单次TCP预算。
export function observeHermesRuntimePort(port) {
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'runtime configured port invalid')
  return new Promise(resolve => {
    const host = '127.0.0.1', socket = net.connect({ host, port }); let finished = false
    const finish = (reachable, errorCode) => { if(finished)return;finished=true;socket.destroy();resolve({host,port,observedAt:new Date().toISOString(),reachable,closed:!reachable&&errorCode==='ECONNREFUSED',errorCode}) }
    socket.once('connect',()=>finish(true,null));socket.once('error',error=>finish(false,error.code));socket.setTimeout(750,()=>finish(false,'ETIMEDOUT'))
  })
}
export function assertHermesRuntimeStopEvidence(receipt, expectedPorts) {
  assertHermesRuntimeIdentities(receipt.preStop)
  const pids = receipt.preStop.map(row=>row.ProcessId).sort((a,b)=>a-b), post = receipt.postStop
  assert.ok(post?.schemaVersion===1 && post.query?.kind==='pids' && typeof post.observedAt==='string' && Number.isFinite(Date.parse(post.observedAt)), 'STOP terminal observation incomplete')
  assert.deepEqual(post.query.pids?.slice().sort((a,b)=>a-b),pids,'STOP terminal query does not bind preStop PIDs')
  assertHermesRuntimeIdentities(post.processes,true)
  assert.ok(post.processes.every(row=>pids.includes(row.ProcessId)), 'STOP terminal contains unqueried PID')
  const identities=receipt.preStop.map(row=>{
    const current=post.processes.find(p=>p.ProcessId===row.ProcessId)
    assert.ok(!current || current.CreationDate!==row.CreationDate, 'STOP original PID+CreationDate still present')
    return {ProcessId:row.ProcessId,CreationDate:row.CreationDate,exited:true,reason:current?'pid-reused':'pid-absent',postCreationDate:current?.CreationDate??null}
  })
  assert.ok(Array.isArray(expectedPorts)&&expectedPorts.length===2&&new Set(expectedPorts).size===2&&expectedPorts.every(port=>Number.isSafeInteger(port)&&port>0&&port<=65535),'STOP requires two exact configured ports')
  assert.ok(Array.isArray(receipt.portEvidence)&&receipt.portEvidence.length===2,'STOP configured port observations missing')
  assert.deepEqual(receipt.portEvidence.map(p=>p?.port).sort((a,b)=>a-b),expectedPorts.slice().sort((a,b)=>a-b),'STOP configured ports mismatch')
  for(const port of receipt.portEvidence)assert.ok(port?.host==='127.0.0.1'&&port.reachable===false&&port.closed===true&&port.errorCode==='ECONNREFUSED'&&typeof port.observedAt==='string'&&Number.isFinite(Date.parse(port.observedAt)),'STOP configured port not proven closed')
  return identities
}
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)) }) }) }
async function until(fn, timeout = 120000) { const start = Date.now(); while (Date.now() - start < timeout) { const x = await fn(); if (x) return x; await wait(500) } throw new Error('有界等待超时') }

export function verifyLinuxEvidence(output, sha, version) {
  const runtime = read(path.join(output, 'runtime/report.json'))
  assert.equal(runtime.status, 'passed'); assert.equal(runtime.cases.length, 11); assert.ok(runtime.cases.every(c => c.status === 'passed')); assert.equal(runtime.versions.hermes, version)
  const ready = read(path.join(output, 'server/ready.json')); assert.equal(ready.home, '/tmp/runtime/home'); assert.equal(ready.sourceSha, sha); assert.equal(ready.version, version)
  for (const n of [1, 2]) {
    const dir = path.join(output, `browser-round${n}`), r = read(path.join(dir, 'report.json'))
    assert.equal(r.ok, true); assert.equal(r.steps.length, 8); assert.deepEqual(r.errors, [])
    assert.ok(r.hold.elapsedSeconds >= 210); assert.equal(r.hold.health.length, 42); assert.ok(r.hold.health.every(h => h.status === 200 && Number.isFinite(Date.parse(h.at))))
    assert.ok(Date.parse(r.hold.health.at(-1).at) - Date.parse(r.hold.health[0].at) >= 200000)
    assert.ok(fs.statSync(path.join(dir, 'trace.zip')).size > 1000)
    assert.ok(fs.readdirSync(dir).some(f => f.endsWith('.png') && fs.statSync(path.join(dir, f)).size > 1000))
  }
  const stop = read(path.join(output, 'server/stop.json'))
  assert.equal(stop.status, 'passed'); assert.equal(stop.productionStop, true); assert.equal(stop.pidsExited, true); assert.equal(stop.portsClosed, true)
  return { status: 'passed-linux-fresh11-and-two-warm-long-ui', sha, version, nativeTauri: 'not-run', coldInstallations: 1, uiRounds: 2 }
}

// 只留直接孩子与双流的事件/字节数；进度、exit和close都不代替原成功门禁。
export function observeQualificationCommand(child, receipt) {
  const state = receipt.commandObservation = { schemaVersion: 1, pid: child.pid, exitReceived: false, closeReceived: false, stdoutBytes: 0, stderrBytes: 0 }
  const count = (kind, chunk) => { state[kind + 'Bytes'] += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk); state[kind + 'LastDataAt'] = new Date().toISOString() }
  child.stdout?.on('data', chunk => count('stdout', chunk))
  child.stderr?.on('data', chunk => count('stderr', chunk))
  child.once('exit', (code, signal) => { Object.assign(state, { exitReceived: true, directExitCode: code, directSignal: signal, exitedAt: new Date().toISOString() }) })
  child.once('close', (code, signal) => { Object.assign(state, { closeReceived: true, closeCode: code, closeSignal: signal, closedAt: new Date().toISOString() }) })
  return { timeout() { Object.assign(state, { timedOutAt: new Date().toISOString(), directExitCodeAtTimeout: child.exitCode, directSignalAtTimeout: child.signalCode, stdoutEndedAtTimeout: child.stdout?.readableEnded ?? null, stderrEndedAtTimeout: child.stderr?.readableEnded ?? null }) } }
}

let qualificationBrowserImportActive = false
export async function loadQualificationChromium({ home, cacheDirectory, moduleFile, importer = url => import(url) }) {
  assert.equal(qualificationBrowserImportActive, false, '拒绝并发 browser import 环境串扰')
  assert.ok(path.isAbsolute(home) && path.isAbsolute(cacheDirectory) && path.isAbsolute(moduleFile), '私有 browser 路径必须绝对')
  assert.equal(cacheDirectory, path.join(home, '.browsers'), '只接受私有 HOME 的固定 cache')
  assert.equal(moduleFile, path.join(home, 'browser-tools/node_modules/playwright/index.mjs'), '只接受本轮私有 module')
  for (const file of [home, cacheDirectory, moduleFile]) physical(file)
  assert.ok(fs.statSync(cacheDirectory).isDirectory() && fs.statSync(moduleFile).isFile(), '私有 browser cache/module 缺失')
  const name = 'PLAYWRIGHT_BROWSERS_PATH'
  const keys = process.platform === 'win32' ? Object.keys(process.env).filter(k => k.toUpperCase() === name) : Object.keys(process.env).filter(k => k === name)
  assert.ok(keys.length <= 1, 'browser cache 环境字段重复')
  const key = keys[0] || name, present = keys.length === 1, value = process.env[key]
  qualificationBrowserImportActive = true
  let chromium
  try {
    // 仅当前一次性验收进程的模块初始化作用域；不写用户/系统环境、注册表或宿主cache。
    // 官方registry在import时固定路径；finally先还原，再用显式私有env启动真实browser。
    process.env[key] = cacheDirectory
    ;({ chromium } = await importer(pathToFileURL(moduleFile).href))
  } finally {
    try { if (present) process.env[key] = value; else delete process.env[key] } finally { qualificationBrowserImportActive = false }
  }
  const executable = chromium?.executablePath?.()
  assert.ok(typeof executable === 'string' && path.isAbsolute(executable) && within(cacheDirectory, executable), 'browser registry不在私有cache；拒绝旧module或宿主路径')
  return chromium
}

async function execute(o) {
  if (o['--startup-stack-samples']) assert.ok(o['--version'] === '0.22.2' && o['--variant'] === 'new', 'stack samples require new candidate')
  for (const k of ['--root', '--sha', '--version', '--variant', '--output']) assert.ok(o[k], `缺少 ${k}`)
  const output = path.resolve(o['--output']); physical(output); assert.ok(!fs.existsSync(output), '输出必须全新'); fs.mkdirSync(output, { recursive: true })
  const r = { schemaVersion: 1, status: 'failed', candidateSha: o['--sha'], expectedVersion: o['--version'], variant: o['--variant'], startedAt: new Date().toISOString(), commands: [], installerStarted: false, stages: STAGES.map(name => ({ name, status: 'missing' })), nativeTauri: { status: 'not-run', qualificationComplete: false }, limitations: ['仅手工一次性托管 Windows 的真实 Web 验收，不证明 native Tauri GUI', 'HOME 隔离不是 Windows HKCU 沙箱；因此本机/self-hosted 均在候选执行前拒绝', '不自动恢复宿主变更，不自动重试，不使用业务凭据或收费模型'] }
  const diagnostic = o['--startup-diagnostic'] === true
  const statusTailDiagnostic = o['--status-tail-diagnostic'] === true
  if (diagnostic) r.diagnostic = { enabled: true, scope: 'diagnostic-only-not-acceptance', stackSampling: o['--startup-stack-samples'] === true, qualificationPass: false, originalStartupBudgetMs: 20000, cliBudgetMs: 15000, installBudgetMs: 900000 }
  if (statusTailDiagnostic) r.diagnostic = { enabled: true, kind: 'status-tail', scope: 'diagnostic-only-not-acceptance', qualificationPass: false, originalStartupBudgetMs: 20000, cliBudgetMs: 15000, installBudgetMs: 900000 }
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(r, null, 2))
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2))
  let env, home, project, checkout, before, proof, web, provider, base, runtimePort, dashboardPort, browser, context, cli, python, release, lastSession, stopped = true, installCursor = 0
  const runtimePids = new Set(), pendingCommands = new Set(), calls = [], providerHTTP = [], apiReceipts = []
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  async function run(program, args, { cwd = project, timeout = 120000, browserDiagnostics = false } = {}) {
    const index = r.commands.length, item = { program, args, cwd, startedAt: new Date().toISOString() }; r.commands.push(item); save()
    const log = path.join(output, `command-${index}`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, env: browserDiagnostics ? { ...env, DEBUG: 'pw:install' } : env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); item.pid = child.pid; if (child.pid) pendingCommands.add(child.pid)
      const observation = browserDiagnostics ? observeQualificationCommand(child, item) : null
      let stdout = '', stderr = ''; child.stdout.on('data', d => { fs.appendFileSync(log + '.stdout.log', d); stdout = (stdout + d).slice(-16777216) }); child.stderr.on('data', d => { fs.appendFileSync(log + '.stderr.log', d); stderr = (stderr + d).slice(-16777216) })
      const timer = setTimeout(() => { observation?.timeout(); child.kill(); reject(new Error(`命令超时: ${program}`)) }, timeout)
      child.once('error', e => { clearTimeout(timer); reject(e) }); child.once('close', code => { clearTimeout(timer); pendingCommands.delete(child.pid); Object.assign(item, { exitCode: code, finishedAt: new Date().toISOString() }); save(); resolve({ code, stdout, stderr }) })
    })
    assert.equal(result.code, 0, `${program}: ${result.stderr.slice(-3000)}`); return result.stdout.trim()
  }
  const git = args => run('git', ['--no-optional-locks', ...args])
  async function api(cmd, args = {}, timeout = 120000) {
    const response = await fetch(base + '/__api/' + cmd, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeout) })
    const value = await response.json(); apiReceipts.push({ cmd, status: response.status, at: new Date().toISOString(), result: value }); write('api-receipts.json', apiReceipts)
    assert.ok(response.ok && !value?.error, `${cmd}: ${JSON.stringify(value)}`); return value
  }
  async function stage(name, fn) {
    const s = r.stages.find(x => x.name === name); Object.assign(s, { status: 'running', startedAt: new Date().toISOString() }); save()
    try { s.actual = await fn(); assertHostUnchanged(before, hostSnapshot(proof)); s.status = 'passed' }
    catch (e) { s.status = 'failed'; s.error = e.stack; throw e }
    finally { s.finishedAt = new Date().toISOString(); save() }
  }
  async function completion() {
    const status = await api('check_hermes'); assert.equal(status.installed, true); assert.equal(status.version, o['--version'])
    const source = path.join(env.HERMES_HOME, 'hermes-agent')
    const actualCommit = await git(['-C', path.join(env.HERMES_HOME, 'hermes-agent'), 'rev-parse', 'HEAD'])
    const snippet = "import sys,json,importlib; print(json.dumps({'python':sys.executable,'modules':{n:importlib.import_module(n).__file__ for n in ['hermes_cli.main','fastapi','uvicorn']}}))"
    let probe, pm, commandSpec
    if (o['--version'] === '0.22.2') {
      let canonical = fs.realpathSync(source); canonical = canonical.startsWith('\\\\?\\UNC\\') ? '\\\\' + canonical.slice(8) : canonical.replace(/^\\\\\?\\/, '')
      const key = digest(canonical).slice(0, 16), state = path.join(env.HERMES_HOME, 'installs', key), factsFile = path.join(state, 'facts.json')
      physical(factsFile); const dependencyEnvironment = read(factsFile).packages?.venv?.environment
      assert.ok(typeof dependencyEnvironment === 'string' && path.isAbsolute(dependencyEnvironment), 'PM facts 缺真实 environment')
      physical(dependencyEnvironment); assert.ok(within(path.join(state, 'environments'), fs.realpathSync(dependencyEnvironment))); assert.ok(fs.statSync(path.join(dependencyEnvironment, 'pyvenv.cfg')).isFile())
      const dependencyPython = path.join(dependencyEnvironment, 'Scripts/python.exe'); physical(dependencyPython); assert.ok(within(home, fs.realpathSync(dependencyPython)))
      const helper = fs.readFileSync(path.join(project, 'scripts/hermes-pm-runtime.js'), 'utf8')
      const original = name => { const body = helper.match(new RegExp('export const ' + name + ' = String.raw`([\\s\\S]*?)\\n`'))?.[1]; assert.ok(body && body.includes(release.commit), `缺原始 PM helper ${name}`); return body }
      const launch = original('HERMES_PRIVATE_LAUNCH_SCRIPT'), metadata = original('HERMES_PRIVATE_METADATA_SCRIPT')
      const index = r.commands.length
      probe = JSON.parse(await run(dependencyPython, ['-I', '-B', '-c', launch, source, env.HERMES_HOME, release.commit, '--python-json', snippet]))
      const stderr = fs.readFileSync(path.join(output, `command-${index}.stderr.log`), 'utf8')
      const preflightLine = stderr.split(/\r?\n/).findLast(s => s.startsWith('CLAWPANEL_HERMES_PRIVATE_PREFLIGHT ')); assert.ok(preflightLine, '缺原始 selected-store preflight 回执')
      const preflight = JSON.parse(preflightLine.slice('CLAWPANEL_HERMES_PRIVATE_PREFLIGHT '.length))
      python = fs.realpathSync(probe.python); assert.ok(within(path.join(env.HERMES_HOME, 'tools'), python), 'probe 未进入 selected store Python')
      commandSpec = { program: dependencyPython, args: ['-I', '-B', '-c', metadata, source, release.commit], role: 'pm-bootstrap-metadata', actualSelectedInterpreter: python }
      const versionText = await run(commandSpec.program, commandSpec.args); assert.ok(versionText.includes(o['--version']), '实际 Hermes metadata 版本不符，不能用 Python --version 代替')
      const events = fs.readFileSync(path.join(output, 'spawn-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)).slice(installCursor)
      const lines = events.filter(e => e.exitCode === 0).flatMap(e => String(e.stdout || '').split(/\r?\n/))
      const completed = lines.findLast(s => s.startsWith('CLAWPANEL_HERMES_PRIVATE_COMPLETION ')); assert.ok(completed, '缺原始 PM private products completion 回执')
      const completionProof = JSON.parse(completed.slice('CLAWPANEL_HERMES_PRIVATE_COMPLETION '.length))
      for (const p of [completionProof.bootRecord, preflight.bootRecord]) { assert.ok(typeof p === 'string'); physical(p); assert.ok(within(env.HERMES_HOME, fs.realpathSync(p))); const boot = read(p); assert.equal(boot.identity, release.commit); assert.ok(Object.values(boot.results || {}).length && Object.values(boot.results).every(s => s.ok === true), '原始 boot record 不完整') }
      pm = { factsFile, dependencyEnvironment, dependencyPython, selectedStorePython: python, completion: completionProof, preflight, helperSha256: r.sourceHashes['scripts/hermes-pm-runtime.js'] }
    } else {
      // 旧版本只使用真实验证过的受管 venv；status.path 可能是解释器，不能当 CLI 执行。
      cli = path.join(source, 'venv/Scripts/hermes.exe'); python = path.join(source, 'venv/Scripts/python.exe')
      for (const f of [cli, python]) { physical(f); assert.ok(within(home, fs.realpathSync(f))) }
      commandSpec = { program: cli, args: ['--version'], role: 'legacy-managed-hermes-cli' }
      assert.ok((await run(commandSpec.program, commandSpec.args)).includes(o['--version']))
      probe = JSON.parse(await run(python, ['-c', snippet])); assert.equal(fs.realpathSync(probe.python), fs.realpathSync(python))
    }
    const events = fs.readFileSync(path.join(output, 'spawn-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x))
    const receipt = { ...probe, python, cli: cli || null, reportedStatusPath: status.path, commandSpec, pm, commit: actualCommit, version: status.version, requiredStages: release.stages, stages: events.slice(installCursor).filter(e => e.stage).map(e => ({ name: e.stage, exitCode: e.exitCode, pid: e.pid, at: e.at })) }
    validatePrivateCompletion(receipt, { home, version: o['--version'], commit: release.commit })
    const installer = path.join(env.HERMES_HOME, '.clawpanel-cache', `install-${release.tag}.ps1`); assert.equal(hash(installer), release.installerSha256)
    write('privatecompletion.json', receipt); return receipt
  }
  function markInstall() { const f = path.join(output, 'spawn-audit.jsonl'); installCursor = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0 }
  async function capturePids() {
    const snapshot = ps(hermesRuntimeProcessSnapshotSource({ home: env.HERMES_HOME }))
    assert.ok(snapshot?.schemaVersion===1&&snapshot.query?.kind==='home'&&Array.isArray(snapshot.processes),'runtime inventory missing complete snapshot')
    const rows=snapshot.processes
    write('runtime-pids.json',{pids:rows.map(row=>row.ProcessId),actual:rows,snapshot})
    assertHermesRuntimeIdentities(rows)
    for(const row of rows)runtimePids.add(row.ProcessId)
    return rows
  }
  async function stopRuntime() {
    if (!base || stopped) return
    const receipt={status:'failed',productionStop:false,preStop:[],ports:[runtimePort,dashboardPort],startedAt:new Date().toISOString(),errors:[]}
    try {
      // 新鲜证据不能用历史Set代替；取证失败仍独立执行原两个停止API。
      try {receipt.preStop=await capturePids();assertHermesRuntimeIdentities(receipt.preStop)}catch(error){receipt.errors.push(String(error))}
      for(const [cmd,args] of [['hermes_dashboard_stop',undefined],['hermes_gateway_action',{action:'stop'}]]) {
        try {await api(cmd,args)}catch(error){receipt.errors.push(`${cmd}: ${error}`)}
      }
      if(receipt.errors.length)throw new Error(receipt.errors.join('\n'))
      await until(async () => !(await reachable(runtimePort)) && !(await reachable(dashboardPort)) && [...runtimePids].every(pid => !alive(pid)), 30000)
      const pids=receipt.preStop.map(row=>row.ProcessId)
      receipt.postStop=ps(hermesRuntimeProcessSnapshotSource({pids}))
      receipt.portEvidence=await Promise.all([runtimePort,dashboardPort].map(observeHermesRuntimePort))
      receipt.identities=assertHermesRuntimeStopEvidence(receipt,[runtimePort,dashboardPort])
      Object.assign(receipt,{status:'passed',productionStop:true,pids,pidsExited:true,portsClosed:true});stopped=true
    } catch(error) {receipt.error=String(error);throw error}
    finally {receipt.finishedAt=new Date().toISOString();write('stop-pids-ports.json',receipt)}
  }
  const history = async () => {
    const sessions = await api('hermes_sessions_list', { limit: 100 }); const list = Array.isArray(sessions) ? sessions : sessions.sessions
    assert.ok(list?.length, '真实历史为空')
    for (const s of list) { const detail = await api('hermes_session_detail', { sessionId: s.id || s.session_id }); if (JSON.stringify(detail).includes(lastSession.reply)) return detail }
    throw new Error('真实 CLI 历史没有完整本轮回复')
  }
  try {
    proof = actualRunnerProof(); write('runner-proof.json', proof)
    r.runnerAdmission = { passed: false, failedConditions: runnerProofFailures(proof) }
    r.runnerAdmission.passed = r.runnerAdmission.failedConditions.length === 0
    write('runner-admission.json', r.runnerAdmission); save(); validateRunnerProof(proof)
    r.toolingDependencies = Object.fromEntries(['scripts/test-hermes-windows-qualification.mjs', 'scripts/hermes-qualification-provider.mjs', 'scripts/hermes-startup-diagnostic.mjs', 'scripts/hermes-python-cache-observation.mjs', 'scripts/hermes-exec-observation.mjs', 'scripts/hermes-status-tail-receipts.mjs'].map(file => [file, hash(path.join(tooling, file))]))
    write('tooling-dependencies.json', { sha: proof.toolingSha, files: r.toolingDependencies })
    assert.ok(within(physical(process.env.RUNNER_TEMP), output), '输出不在本次 RUNNER_TEMP')
    checkout = resolveQualificationCheckout(o['--root'])
    assert.ok(within(physical(process.env.GITHUB_WORKSPACE), checkout), '候选不在 checkout workspace')
    before = hostSnapshot(proof); write('host-before.json', before)
    home = path.join(output, 'h'); assert.ok(home.length <= 96, 'Windows 私有 HOME 路径过长'); fs.mkdirSync(home)
    env = isolationEnv({ home, temp: path.join(output, 't'), realProfile: proof.actualProfile })
    // 仅通过真实 VM/SID 资格后启用固定阶段诊断；失败仍按原20秒就绪门禁判红。
    env.CLAWPANEL_HERMES_PHASE_TIMING = '1'
    // 仅本诊断VM子环境启用；run/status/stop均使用同一个current body，正常模式不设变量。
    if (statusTailDiagnostic) env.CLAWPANEL_HERMES_STATUS_TAIL_DIAGNOSTIC = '1'
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HERMES_HOME', 'OPENCLAW_CONFIG_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'TEMP']) fs.mkdirSync(physical(env[key]), { recursive: true })
    for (const key of ['GIT_CONFIG_GLOBAL', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) fs.writeFileSync(env[key], '')
    write('isolationenv.json', env)
    write('isolation-proof.json', { fullEnvironmentSha256: digest(JSON.stringify(env)), credentialInheritance: false, privatePaths: Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'HERMES_HOME', 'OPENCLAW_CONFIG_DIR'].map(k => [k, env[k]])), pathVariableCount: Object.keys(env).filter(k => k.toLowerCase() === 'path').length })
    project = path.join(output, 'source'); fs.mkdirSync(project)
    await stage('source-isolation', async () => {
      assert.equal(await git(['-C', checkout, 'rev-parse', 'HEAD']), o['--sha'])
      assert.equal(await git(['-C', checkout, 'status', '--porcelain', '--untracked-files=no']), '')
      const source = {}, tree = (await git(['-C', checkout, 'ls-tree', '-r', '--full-tree', o['--sha']])).split('\n')
      for (const line of tree) {
        const m = line.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/); assert.ok(m, '拒绝 symlink/submodule/特殊 Git tree entry')
        const [, , oid, file] = m; assert.ok(within(project, path.resolve(project, file)))
        const bytes = spawnSync('git', ['--no-optional-locks', '-C', checkout, 'show', `${o['--sha']}:${file}`], { env, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 })
        assert.equal(bytes.status, 0); assert.equal(crypto.createHash('sha1').update(`blob ${bytes.stdout.length}\0`).update(bytes.stdout).digest('hex'), oid)
        const target = path.join(project, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes.stdout); source[file] = hash(target)
      }
      write('source-sha256.json', { sha: o['--sha'], method: 'literal git show raw bytes + ls-tree blob SHA1 + readback SHA256', files: source }); r.sourceHashes = source
      assertSameSource(project, source)
      const webSource = fs.readFileSync(path.join(project, 'scripts/dev-api.js'), 'utf8'), rust = fs.readFileSync(path.join(project, 'src-tauri/src/commands/hermes.rs'), 'utf8')
      release = readHermesRelease(webSource, rust, o['--version']); write('release.json', release)
      await run(process.execPath, [npmCli, 'ci'], { timeout: 600000 }); await run(process.execPath, [path.join(project, 'node_modules/vite/bin/vite.js'), 'build'])
      const dist = {}; function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else { assert.ok(e.isFile()); dist[path.relative(project, f)] = hash(f) } } } walk(path.join(project, 'dist')); write('dist-sha256.json', dist); r.distHashes = dist
      r.nativeTauri.entryEvidence = { scope: 'source-only, not native execution', file: 'src-tauri/src/commands/hermes.rs', sha256: source['src-tauri/src/commands/hermes.rs'], commands: ['install_hermes', 'update_hermes', 'uninstall_hermes'] }
      return { tracked: Object.keys(source).length, dist: Object.keys(dist).length, release }
    })
    runtimePort = await freePort(); dashboardPort = await freePort(); const webPort = await freePort(); assert.equal(new Set([runtimePort, dashboardPort, webPort]).size, 3)
    fs.writeFileSync(path.join(env.OPENCLAW_CONFIG_DIR, 'clawpanel.json'), JSON.stringify({ ignoreRisk: true, openclawDir: env.OPENCLAW_CONFIG_DIR, engineMode: 'hermes', enabledEngines: ['hermes'], engineSetupChoice: 'explicit' }))
    fs.writeFileSync(path.join(env.OPENCLAW_CONFIG_DIR, 'openclaw.json'), '{}\n')
    r.environment = { home, hermesHome: env.HERMES_HOME, output, source: project, checkout, sourceSha: o['--sha'] }
    const audit = path.join(home, 'spawn-audit.mjs'); fs.writeFileSync(audit, spawnAuditSource(path.join(output, 'spawn-audit.jsonl'), diagnostic ? { configFile: path.join(output, 'startup-diagnostic-config.json') } : null))
    web = spawn(process.execPath, ['--import', pathToFileURL(audit).href, path.join(project, 'scripts/serve.js'), '--host', '127.0.0.1', '--port', String(webPort)], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    r.webPid = web.pid; r.webPort = webPort; web.stdout.on('data', d => fs.appendFileSync(path.join(output, 'serve.stdout.log'), d)); web.stderr.on('data', d => fs.appendFileSync(path.join(output, 'serve.stderr.log'), d)); web.on('exit', (code, signal) => { r.webExit = { code, signal, at: new Date().toISOString() }; save() })
    base = `http://127.0.0.1:${webPort}`; await until(() => reachable(webPort), 30000)
    await stage('install-privatecompletion', async () => { r.installerStarted = true; markInstall(); save(); await api('install_hermes', { method: 'uv-tool' }, 900000); const receipt = await completion()
      if (diagnostic) {
        const config = { enabled: true, stackSampling: r.diagnostic.stackSampling, scope: r.diagnostic.scope, version: o['--version'], gatewayLog: path.join(env.HERMES_HOME, 'gateway-run.log'), phaseOutput: path.join(output, 'startup-file-phases.jsonl') }
        if (o['--version'] === '0.22.2') {
          config.pmScript = fs.readFileSync(path.join(project, 'scripts/hermes-pm-runtime.js'), 'utf8').match(/export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`([\s\S]*?)\n`/)?.[1]
          assert.ok(config.pmScript?.includes(release.commit), '缺固定 PM launch script'); config.pmScript += '\n'; config.pin = release.commit
        }
        write('startup-diagnostic-config.json', config)
        r.diagnostic.pythonCache = observeHermesPythonCache({ home, modulePaths: [receipt.modules.fastapi] })
        write('python-cache-observation.json', r.diagnostic.pythonCache)
      }
      return receipt })
    await stage('runtime-ui', async () => {
      const providerModels = ['qualification-one', 'qualification-two']
      provider = http.createServer(async (req, res) => {
        let raw = '', receipt
        const authMatches = req.headers.authorization === 'Bearer qualification-local-no-secret'
        const record = fields => {
          receipt = { seq: providerHTTP.length + 1, at: new Date().toISOString(), method: req.method, path: req.url, bodySha256: digest(raw), authMatches, ...fields }
          providerHTTP.push(receipt); write('provider-http.json', providerHTTP)
        }
        try {
        for await (const d of req) { raw += d; if (raw.length > 8388608) { r.providerError = 'provider request body too large'; record({ kind: 'unknown', body: {}, responseStatus: 413, accepted: false }); save(); res.writeHead(413); return res.end() } }
        const metadata = classifyHermesMetadataRequest(req.method, req.url, raw, providerModels)
        if (metadata) {
          record({ kind: 'metadata', body: req.method === 'POST' ? JSON.parse(raw) : {}, responseStatus: metadata.status, provider: metadata.provider, accepted: true })
          write('provider-metadata.json', providerHTTP.filter(row => row.kind === 'metadata'))
          res.writeHead(metadata.status, { 'content-type': 'application/json' })
          if (metadata.status === 200) return res.end(JSON.stringify({ data: providerModels.map(id => ({ id, object: 'model' })) }))
          return res.end(JSON.stringify({ error: 'metadata protocol not provided by this OpenAI fixture' }))
        }
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions')
        const b = JSON.parse(raw), nonce = [...JSON.stringify(b.messages || []).matchAll(/hq-[a-f0-9-]{36}/g)].at(-1)?.[0]
        const evidence = { method: req.method, path: req.url, authenticated: authMatches, pin: release.commit, models: providerModels, calls }
        const purpose = classifyProviderRequest(b, evidence), system = (b.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n')
        const reply = qualificationProviderReply(b, nonce, evidence)
        record({ kind: purpose === 'unattributed' ? 'unknown' : purpose, body: { model: b.model }, model: b.model, nonce, responseStatus: 200, accepted: authMatches && purpose !== 'unattributed' })
        calls.push({ at: new Date().toISOString(), kind: receipt.kind, method: req.method, path: req.url, bodySha256: digest(raw), purpose, systemPrefix: system.slice(0, 200), systemSha256: digest(system), url: req.url, nonce, model: b.model, stream: b.stream, messages: b.messages, authenticated: req.headers.authorization === 'Bearer qualification-local-no-secret' }); write('provider-requests.json', calls)
        assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer qualification-local-no-secret')
        if (b.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const delta of [{ role: 'assistant', content: '' }, { content: reply }, {}]) res.write('data: ' + JSON.stringify({ id: 'qualification', object: 'chat.completion.chunk', model: b.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n'); res.end('data: [DONE]\n\n') }
        else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'qualification', object: 'chat.completion', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })) }
        } catch (e) { r.providerError = String(e); if (!receipt) record({ kind: 'unknown', body: {}, responseStatus: 500, accepted: false }); else { receipt.responseStatus = 500; receipt.accepted = false; write('provider-http.json', providerHTTP) }; if (!res.headersSent) res.writeHead(500); res.end('qualification provider error'); save() }
      }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
      r.providerPort = provider.address().port
      const url = `http://127.0.0.1:${provider.address().port}/v1`
      await api('configure_hermes', { provider: 'custom', apiKey: 'qualification-local-no-secret', baseUrl: url, model: 'qualification-one' })
      // 只修改一次性 HOME 内配置，选随机 dashboard 端口，不覆盖真实用户文件。
      // 在隔离子进程内用候选锁定的 YAML 库合并，避免追加重复 dashboard 键破坏已有配置。
      const merge = `import fs from 'node:fs';import YAML from ${JSON.stringify(pathToFileURL(path.join(project, 'node_modules/yaml/browser/index.js')).href)};const f=process.argv[1];const c=YAML.parse(fs.readFileSync(f,'utf8'))||{};c.dashboard={...(c.dashboard||{}),port:Number(process.argv[2])};c.qualification_marker=process.argv[3];fs.writeFileSync(f,YAML.stringify(c));`
      await run(process.execPath, ['--input-type=module', '-e', merge, path.join(env.HERMES_HOME, 'config.yaml'), String(dashboardPort), o['--sha']])
      await api('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' }); await api('hermes_env_set', { key: 'API_SERVER_PORT', value: String(runtimePort) }); await api('hermes_set_gateway_url', { url: `http://127.0.0.1:${runtimePort}` })
      const profiles = await api('hermes_profiles_list'); assert.ok(profiles.profiles.some(p => p.name === 'default')); await api('hermes_profile_use', { name: 'default' })
      stopped = false; await api('hermes_gateway_action', { action: 'start' }); await api('hermes_health_check'); await api('hermes_capabilities')
      const readAudit = () => fs.readFileSync(path.join(output, 'spawn-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      let statusAuditCursor
      try { statusAuditCursor = readAudit().length } catch { /* 缺原观察仍调用原status并判红，不遮住后续UI。 */ }
      r.gatewayStatusFiles = { before: captureHermesGatewayStateFiles(home, 'before-status') }
      try {
        r.gatewayStatusReadback = await collectGatewayStatusReadback({ request: () => api('hermes_gateway_action', { action: 'status' }), apiReceipts, readExecEvents: () => { assert.ok(Number.isInteger(statusAuditCursor), 'STATUS_AUDIT_BASELINE_MISSING'); return readAudit().slice(statusAuditCursor) } })
        write('gateway-status-readback.json', r.gatewayStatusReadback)
      } finally {
        r.gatewayStatusFiles.after = captureHermesGatewayStateFiles(home, 'after-status')
        write('gateway-status-files.json', r.gatewayStatusFiles); save()
      }
      if (statusTailDiagnostic) {
        r.statusTailReadback = collectStatusTailReadback({ readback: r.gatewayStatusReadback, execEvents: readAudit().slice(statusAuditCursor) })
        write('status-tail-readback.json', r.statusTailReadback); save()
        assertStatusTailReadback(r.gatewayStatusReadback, r.statusTailReadback)
        r.diagnostic.gatewayReadyWithinBudget = true; await capturePids()
        return { scope: r.diagnostic.scope, gatewayReadyWithinBudget: true, qualificationPass: false }
      }
      if (diagnostic) { r.diagnostic.gatewayReadyWithinBudget = true; await capturePids(); return { scope: r.diagnostic.scope, gatewayReadyWithinBudget: true } }
      const dash = await api('hermes_dashboard_start'); assert.equal(dash.started, true); assert.equal((await api('hermes_dashboard_probe')).running, true); await capturePids()
      // 官方40747修复Node24.16与旧zip stream的死锁；固定测试工具版本，不降Node或扩安装预算。
      await run(process.execPath, [npmCli, 'install', '--prefix', path.join(home, 'browser-tools'), '--no-save', '--ignore-scripts', '--package-lock=false', 'playwright@1.60.0'], { timeout: 600000 })
      const browserModules = path.join(home, 'browser-tools/node_modules')
      r.browserTooling = {
        playwrightVersion: JSON.parse(fs.readFileSync(path.join(browserModules, 'playwright/package.json'), 'utf8')).version,
        coreVersion: JSON.parse(fs.readFileSync(path.join(browserModules, 'playwright-core/package.json'), 'utf8')).version,
        browserManifestSha256: digest(fs.readFileSync(path.join(browserModules, 'playwright-core/browsers.json'))),
      }
      assert.equal(r.browserTooling.playwrightVersion, '1.60.0'); assert.equal(r.browserTooling.coreVersion, '1.60.0')
      write('browser-tooling.json', r.browserTooling); save()
      // 本验收只用默认headless shell；不再下载未使用的headed Chrome，原600秒和真实启动/长UI门禁不变。
      await run(process.execPath, [path.join(home, 'browser-tools/node_modules/playwright/cli.js'), 'install', '--only-shell', 'chromium'], { timeout: 600000, browserDiagnostics: true })
      const parentEnvironmentBeforeImport = digest(JSON.stringify(process.env))
      const chromium = await loadQualificationChromium({ home, cacheDirectory: env.PLAYWRIGHT_BROWSERS_PATH, moduleFile: path.join(browserModules, 'playwright/index.mjs') })
      r.browserTooling.parentEnvironmentRestored = digest(JSON.stringify(process.env)) === parentEnvironmentBeforeImport
      r.browserTooling.defaultRegistryExecutablePath = chromium.executablePath()
      assert.equal(r.browserTooling.parentEnvironmentRestored, true, 'browser import后验收进程环境没有复原')
      write('browser-tooling.json', r.browserTooling); save()
      browser = await chromium.launch({ headless: true, env }); context = await browser.newContext({ locale: 'zh-CN' }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
      const pageErrors = [], screenshots = [], prompts = []; context.on('page', p => p.on('pageerror', e => pageErrors.push(String(e))))
      const page = await context.newPage(); await page.goto(base + '/#/h/chat'); await page.locator('#hm-chat-input').waitFor()
      const dashPage = await context.newPage(); const dashResponse = await dashPage.goto(`http://127.0.0.1:${dashboardPort}`); assert.equal(dashResponse.status(), 200); await dashPage.locator('body').waitFor(); await dashPage.screenshot({ path: path.join(output, 'dashboard.png'), fullPage: true }); screenshots.push('dashboard.png'); await dashPage.close()
      for (const model of ['qualification-one', 'qualification-two', 'qualification-two']) {
        if (prompts.length === 1) { await api('hermes_sync_provider', { provider: 'custom', apiKey: 'qualification-local-no-secret', baseUrl: url, model, setDefault: true }); await page.reload(); await page.locator('#hm-chat-input').waitFor() }
        if (prompts.length === 2) { const beforeCalls = calls.length; await context.setOffline(true); await page.waitForTimeout(1500); await context.setOffline(false); await page.reload(); await page.locator('#hm-chat-input').waitFor(); assert.equal(calls.length, beforeCalls, '重连不应重放聊天') }
        await page.locator('#hm-chat-new-chat').click(); const nonce = 'hq-' + crypto.randomUUID(), reply = `Hermes qualification reply ${nonce} ${model}.`; prompts.push({ nonce, model, reply }); lastSession = { reply }
        await page.locator('#hm-chat-input').fill(nonce); await page.locator('#hm-chat-send').click(); await page.getByText(reply, { exact: false }).first().waitFor({ timeout: 120000 }); await page.locator('#hm-chat-stop').waitFor({ state: 'hidden', timeout: 120000 })
        const name = `chat-${prompts.length}.png`; await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name)
      }
      await history(); await page.reload(); await page.getByText(lastSession.reply, { exact: false }).first().waitFor({ timeout: 30000 }); await page.screenshot({ path: path.join(output, 'history.png'), fullPage: true }); screenshots.push('history.png')
      assert.deepEqual(pageErrors, []); assert.equal(calls.filter(c => c.purpose === 'unattributed').length, 0, '额外 Provider 请求未归因，保留 system/raw 回执，不冒充 chat/title')
      for (const p of prompts) { assert.equal(calls.filter(c => c.purpose === 'chat' && c.nonce === p.nonce && c.model === p.model).length, 1, '聊天请求必须恰好一次'); assert.ok(calls.filter(c => c.purpose === 'title' && c.nonce === p.nonce).length <= 1, '同 nonce 标题请求重复') }
      assert.ok(calls.every(c => c.authenticated && prompts.some(p => p.nonce === c.nonce)), '未知 nonce 或认证不符')
      r.providerAttribution = { chats: calls.filter(c => c.purpose === 'chat').length, titles: calls.filter(c => c.purpose === 'title').length, unknown: 0, prompts }
      await context.tracing.stop({ path: path.join(output, 'trace.zip') }); await browser.close(); browser = null
      r.browser = { actualChromium: true, screenshots, trace: 'trace.zip', pageErrors, completeReply: true, historyAfterReload: true, prompts }; write('browser-report.json', r.browser)
      return { profiles, dash, providerRequests: calls.length }
    })
    if (!diagnostic && !statusTailDiagnostic) {
    const sentinel = path.join(env.HERMES_HOME, 'memories/qualification.txt'); fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, o['--sha']); const sentinelHash = hash(sentinel)
    const preserve = async () => { assert.equal(hash(sentinel), sentinelHash); assert.ok(fs.readFileSync(path.join(env.HERMES_HOME, 'config.yaml'), 'utf8').includes(`qualification_marker: ${o['--sha']}`)); assert.ok((await api('hermes_profiles_list')).profiles.some(p => p.name === 'default')); assert.equal((await api('hermes_read_config')).model_raw, 'qualification-two'); return history() }
    await stage('update-stop', async () => { await stopRuntime(); markInstall(); await api('update_hermes', {}, 900000); await completion(); await preserve(); return { productionStop: true, updateVerified: true } })
    await stage('uninstall-reinstall-preserve', async () => { await api('uninstall_hermes', { cleanConfig: false }); assert.equal((await api('check_hermes')).installed, false); assert.equal(hash(sentinel), sentinelHash); markInstall(); await api('install_hermes', { method: 'uv-tool' }, 900000); await completion(); await preserve(); stopped = false; await api('hermes_gateway_action', { action: 'start' }); await api('hermes_health_check'); assert.equal((await api('hermes_dashboard_start')).started, true); await capturePids(); await stopRuntime(); return { cleanConfig: false, actualHistoryReRead: true, memoryHash: sentinelHash, reinstalled: true, restartedAndStopped: true } })
    }
  } catch (e) {
    r.error = e.stack;
    if (env && runtimePort && /Gateway 启动后端口未就绪/.test(r.error)) {
      try { r.failedStartupObservation = await observeFailedGatewayStartup({ isOpen: () => reachable(runtimePort), readHealth: () => api('hermes_health_check', {}, 10000) }); write('failed-startup-observation.json', r.failedStartupObservation) }
      catch (error) { r.failedStartupObservationError = String(error) }
    }
  }
  finally {
    if (home) { try { r.runtimeLogs = { beforeStop: captureHermesRuntimeLogs(home, output, 'before-stop') } } catch (e) { r.cleanupError = `故障运行日志留证失败: ${e.message}` } }
    if (env && !stopped) { try { await capturePids() } catch (e) { r.cleanupError = `停止前真实运行进程未取得完整观察: ${e.message}` } }
    try { if (browser) { if (context) await context.tracing.stop({ path: path.join(output, 'failed-trace.zip') }); await browser.close() } } catch (e) { r.browserCleanupError = String(e) }
    try { await stopRuntime() } catch (e) { r.stopError = String(e) }
    // HTTP 安装超时也保留未退出的真实阶段 PID；只清理本观察器亲自记录且尚无 close 的子进程。
    const observed = path.join(output, 'spawn-audit.jsonl'), pendingObserved = new Set()
    if (fs.existsSync(observed)) {
      try { for (const line of fs.readFileSync(observed, 'utf8').trim().split('\n').filter(Boolean)) { const e = JSON.parse(line); if (e.event === 'start') pendingObserved.add(e.pid); if (e.event === 'close') pendingObserved.delete(e.pid) } }
      catch (e) { r.cleanupError = `子进程观察日志不完整: ${e.message}` }
    }
    const pending = [...new Set([...pendingObserved, ...pendingCommands])]
    write('pending-owned-children.json', { pids: pending, at: new Date().toISOString() })
    for (const pid of pending) if (alive(pid)) { const k = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { env, windowsHide: true, encoding: 'utf8' }); write(`owned-child-${pid}-taskkill.json`, { pid, status: k.status, stdout: k.stdout, stderr: k.stderr }) }
    if (web && alive(web.pid)) { const k = spawnSync('taskkill.exe', ['/PID', String(web.pid), '/T', '/F'], { env, windowsHide: true, encoding: 'utf8' }); write('owned-web-taskkill.json', { pid: web.pid, status: k.status, stdout: k.stdout, stderr: k.stderr }) }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
    try {
      await until(async () => (!web || !alive(web.pid)) && (!r.webPort || !(await reachable(r.webPort))) && (!r.providerPort || !(await reachable(r.providerPort))) && pending.every(pid => !alive(pid)) && [...runtimePids].every(pid => !alive(pid)), 15000)
      write('infrastructure-stop.json', { webPid: web?.pid || null, webExited: true, webPort: r.webPort, providerPort: r.providerPort, allPortsClosed: true, pendingOwnedPids: pending, pendingOwnedPidsExited: true, runtimePids: [...runtimePids], runtimePidsExited: runtimePids.size ? true : null, runtimeIdentityScope: 'infrastructure raw PID cleanup only; production identity proof is separate stop-pids-ports.json' })
    } catch (e) { r.cleanupError = String(e) }
    if (before) { try { const after = hostSnapshot(proof); write('host-after.json', after); assertHostUnchanged(before, after); r.hostUnchanged = true } catch (e) { r.hostUnchanged = false; r.hostChangeError = e.message } }
    if (r.sourceHashes) { r.sourceDrift = Object.keys(r.sourceHashes).filter(f => !fs.existsSync(path.join(project, f)) || hash(path.join(project, f)) !== r.sourceHashes[f]); if (r.sourceDrift.length) r.error = '源文件发生漂移' }
    if (r.distHashes) { r.distDrift = Object.keys(r.distHashes).filter(f => !fs.existsSync(path.join(project, f)) || hash(path.join(project, f)) !== r.distHashes[f]); if (r.distDrift.length) r.error = 'dist 发生漂移' }
    if (r.toolingDependencies) { r.toolingDrift = Object.keys(r.toolingDependencies).filter(f => !fs.existsSync(path.join(tooling, f)) || hash(path.join(tooling, f)) !== r.toolingDependencies[f]); if (r.toolingDrift.length) r.error = '可信 tooling 发生漂移' }
    if (env) { for (const name of ['gateway-run.log', 'dashboard-run.log']) { const f = path.join(env.HERMES_HOME, name); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(output, name)) } }
    if (home) { try { r.runtimeLogs ||= {}; r.runtimeLogs.afterStop = captureHermesRuntimeLogs(home, output, 'after-stop') } catch (e) { r.cleanupError = `停止后运行日志留证失败: ${e.message}` } }
    r.status = r.error || r.stopError || r.browserCleanupError || r.cleanupError || r.providerError ? 'failed' : qualificationStatus(r); r.finishedAt = new Date().toISOString(); save()
  }
  console.log(JSON.stringify({ status: r.status, candidateSha: r.candidateSha, output, nativeTauri: 'not-run' }))
  return r.status === 'passed-web-native-missing' || r.status === 'diagnostic-only-not-qualification' ? 0 : 1
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o['--matrix']) { console.log(JSON.stringify(matrixFromInputs(process.env))); return 0 }
  if (o['--verify-linux-evidence']) { assert.ok(exactSha(o['--sha'])); console.log(JSON.stringify(verifyLinuxEvidence(o['--verify-linux-evidence'], o['--sha'], o['--version']))); return 0 }
  if (o['--publish-evidence']) { assert.ok(o['--output'], '公开副本必须指定新 output'); console.log(JSON.stringify(await publishEvidence({ roots: { evidence: path.resolve(o['--publish-evidence']) }, output: o['--output'] }))); return 0 }
  if (o['--execute']) return execute(o)
  console.log(JSON.stringify({ stages: STAGES, installsOnLocalHost: false, nativeTauriRequiredForFullQualification: true, candidateSecrets: false, retries: 0, startupTiming: { qualifiedVmOnly: true, acceptanceExtension: false }, ...(o['--status-tail-diagnostic'] ? { statusTailDiagnostic: true, diagnosticNeverQualifies: true, diagnosticScope: 'status-tail-diagnostic-only-not-qualification', executionWiringReady: true } : {}), usage: '--execute --root candidate --sha <40hex> --version <0.x.y> --variant old|new --output <fresh RUNNER_TEMP/dir>', nativeTauri: 'separate missing gate, not upgraded by external receipt' }))
  return 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code }).catch(e => { console.error(e.stack); process.exitCode = 1 })
