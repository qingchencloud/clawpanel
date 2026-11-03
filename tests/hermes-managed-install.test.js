import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const wrapper = path.join(root, 'scripts/hermes-managed-install.ps1')
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const psQuote = s => `'${s.replaceAll("'", "''")}'`
// 只有结构化适配入口处理此合成源；产品执行入口仍须固定官方原字节 hash。
const fixture = `function Set-ManagedNodeFirstOnUserPath {
param([string]$NodeDir)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$updated = "$NodeDir;$userPath"
[Environment]::SetEnvironmentVariable("Path", $updated, "User")
}
function Install-Git {
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$userPathItems = @($userPath, 'git-sink')
[Environment]::SetEnvironmentVariable("Path", ($userPathItems -join ";"), "User")
}
function Set-GitBashEnvVar {
$candidate = 'private-bash-sink'
[Environment]::SetEnvironmentVariable("HERMES_GIT_BASH_PATH", $candidate, "User")
}
function Install-Uv {
$psHostExe = Get-PowerShellHostExe
$astralOut = @(); $ghOut = @()
& $psHostExe -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex" 2>&1 | Tee-Object -Variable astralOut | Out-Null
if (-not (Test-Path (Join-Path $HermesHome 'bin/uv.exe'))) {
& $psHostExe -ExecutionPolicy ByPass -c "irm https://github.com/astral-sh/uv/releases/latest/download/uv-installer.ps1 | iex" 2>&1 | Tee-Object -Variable ghOut | Out-Null
}
$astralOut; $ghOut
}
`

function runPs(body) {
  assert.ok(fs.existsSync(wrapper), '缺共享固定 PS wrapper')
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hermes managed 'sink-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'))
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[k] = temp
  const source = path.join(temp, 'fixture.ps1'), entry = path.join(temp, 'test.ps1')
  fs.writeFileSync(source, fixture)
  fs.writeFileSync(entry, `$ErrorActionPreference='Stop'\n$wrapperPath=${psQuote(wrapper)}\n. $wrapperPath\n$fixturePath=${psQuote(source)}\n$temp=${psQuote(temp)}\n${body}\n`)
  try {
    const before = JSON.stringify(process.env), original = sha(fs.readFileSync(source))
    const r = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-File', entry], { env, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`)
    assert.equal(JSON.stringify(process.env), before)
    assert.equal(sha(fs.readFileSync(source)), original, '不得修改原输入字节')
    const result = JSON.parse(r.stdout.trim())
    const pathReceipts = r.stderr.split(/\r?\n/).filter(line => line.startsWith('CLAWPANEL_UV_PATH_RECEIPT ')).map(line => JSON.parse(line.slice('CLAWPANEL_UV_PATH_RECEIPT '.length)))
    return pathReceipts.length ? { ...result, pathReceipts } : result
  } finally {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

test('JS读取和Rust include同一wrapper，固定旧pin及11stage经过wrapper而非原版直启', () => {
  const web = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
  const rust = fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8')
  assert.match(web, /readFileSync\(new URL\('\.\/hermes-managed-install\.ps1', import\.meta\.url\)\)/)
  assert.match(web, /'-File', wrapperPath, '-InstallerPath', scriptPath/)
  assert.match(web, /ensureHermesManagedWrapper\(plan\)/)
  assert.match(rust, /include_str!\("\.\.\/\.\.\/\.\.\/scripts\/hermes-managed-install\.ps1"\)/)
  assert.match(rust, /\.arg\(wrapper_path\)[^]*?\.arg\("-InstallerPath"\)[^]*?\.arg\(script_path\)/)
  assert.match(rust, /build_hermes_installer_stage_command\(&script_path, &wrapper_path, stage\)/)
  const ps = fs.readFileSync(wrapper, 'utf8')
  assert.match(ps, /0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2/)
  assert.match(ps, /f97608f178d1ffeca59860195ab7da295f7c8e5f/)
  assert.doesNotMatch(ps, /Set-ItemProperty|RegOverridePredefKey|SetEnvironmentVariable\([^\n]*['"](?:User|Machine)['"]/)
})

test('安装Env仅子环境钉UV隔离，移除跨版本PSModulePath，不改父环境与镜像', async () => {
  const { buildHermesInstallEnv } = await import('../scripts/dev-api.js')
  const base = { PATH: 'fixture-path', PSModulePath: 'PS7-only', pSmOdUlEpAtH: 'other', UV_NO_MODIFY_PATH: '0' }
  const original = { ...base }
  const env = buildHermesInstallEnv({ pypiMirror: 'https://fixture.invalid/simple' }, base)
  assert.equal(env.UV_NO_MODIFY_PATH, process.platform === 'win32' ? '1' : '0')
  assert.equal(Object.keys(env).some(k => k.toLowerCase() === 'psmodulepath'), process.platform !== 'win32')
  assert.equal(env.UV_DEFAULT_INDEX, 'https://fixture.invalid/simple')
  assert.deepEqual(base, original)
  const text = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8').match(/export function buildHermesInstallEnv\([^]*?\n\}/)?.[0]
  assert.ok(text)
  for (const windows of [true, false]) {
    const build = new Function('buildHermesRuntimeEnv', 'isWindows', `${text.replace(/^export /, '')};return buildHermesInstallEnv`)(e => ({ ...e }), windows)
    const actual = build({}, base)
    assert.equal(actual.UV_NO_MODIFY_PATH, windows ? '1' : '0', 'POSIX 环境不得被 Windows 修复改变')
    assert.equal(Object.keys(actual).some(k => k.toLowerCase() === 'psmodulepath'), !windows)
  }
})

test('Web真实私有cache写入与Windows11个实际argv均绑定同一wrapper原始字节', async () => {
  const { ensureHermesManagedWrapper, hermesInstallerPlan } = await import('../scripts/dev-api.js')
  assert.equal(typeof ensureHermesManagedWrapper, 'function')
  assert.equal(typeof hermesInstallerPlan, 'function')
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hermes-wrapper-bytes-'))
  try {
    const plan = hermesInstallerPlan(temp)
    fs.mkdirSync(path.dirname(plan.scriptPath), { recursive: true })
    const before = fs.readFileSync(wrapper)
    const cache = ensureHermesManagedWrapper(plan)
    assert.equal(path.dirname(cache), path.dirname(plan.scriptPath))
    assert.equal(path.basename(cache), `clawpanel-managed-${sha(before)}.ps1`)
    assert.deepEqual(fs.readFileSync(cache), before)
    fs.writeFileSync(cache, 'corrupt private cache')
    assert.equal(ensureHermesManagedWrapper(plan), cache)
    assert.deepEqual(fs.readFileSync(cache), before)
    assert.deepEqual(fs.readFileSync(wrapper), before)
    if (process.platform === 'win32') {
      assert.equal(plan.stages.length, 11)
      for (const stage of plan.stages) {
        const argv = plan.argsForStage(plan.scriptPath, stage, cache)
        assert.equal(argv[argv.indexOf('-File') + 1], cache)
        assert.equal(argv[argv.indexOf('-InstallerPath') + 1], plan.scriptPath)
        assert.equal(argv[argv.indexOf('-Stage') + 1], stage)
        assert.equal(argv[argv.indexOf('-Commit') + 1], 'f97608f178d1ffeca59860195ab7da295f7c8e5f')
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('PS5真实临时sink：精确5节点适配/原字节不变，签名类型key目标数量异常均失败', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$source=[IO.File]::ReadAllText($fixturePath)
$r=Get-ClawPanelLegacyDefinitions $source
if($r.Redirections -ne 5){throw 'count'}
foreach($d in $r.Definitions){
  $a=[ScriptBlock]::Create($d).Ast
  $bad=@($a.FindAll({param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -eq 'User'},$true))
  if($bad.Count){throw 'unsafe fixture execution'}
  . ([ScriptBlock]::Create($d))
}
[Environment]::SetEnvironmentVariable('Path','process-sink','Process')
Set-ManagedNodeFirstOnUserPath 'node-sink'
Install-Git
Set-GitBashEnvVar
if($env:Path -ne 'node-sink;process-sink;git-sink' -or $env:HERMES_GIT_BASH_PATH -ne 'private-bash-sink'){throw 'process sink'}
$badSources=@(
  $source.Replace('[string]$NodeDir','[int]$NodeDir'),
  $source.Replace('[Environment]::SetEnvironmentVariable','[System.Environment]::SetEnvironmentVariable'),
  $source.Replace('"HERMES_GIT_BASH_PATH"','"UNEXPECTED"'),
  $source.Replace('"User"','"Machine"'),
  $source.Replace('function Install-Git {','function Install-Git { param($extra)'),
  ($source + $source),
  $source.Replace('$updated, "User"','$updated, "User", "extra"'),
  $source.Replace('"Path", "User"','"Path", "User"); [Environment]::GetEnvironmentVariable("Path", "User"')
)
$rejected=0
foreach($s in $badSources){try{ $null=Get-ClawPanelLegacyDefinitions $s }catch{$rejected++}}
if($rejected -ne $badSources.Count){throw "negative accepted: $rejected"}
@{pid=$PID;redirections=$r.Redirections;negativeRejected=$rejected;path=$env:Path;kind='isolated-process-sink-not-install'}|ConvertTo-Json -Compress
`)
  assert.equal(r.redirections, 5)
  assert.equal(r.negativeRejected, 8)
  assert.ok(r.pid > 0)
  t.diagnostic(JSON.stringify(r))
})

test('PS5真实子进程：跨stage私有PATH/UV继承，winget入口阻断且catch吞错后仍红', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$privateHome=Join-Path $temp 'private home'
$null=New-Item -ItemType Directory -Force (Join-Path $privateHome 'bin')
$null=New-Item -ItemType Directory -Force (Join-Path $privateHome 'node')
Initialize-ClawPanelLegacyEnvironment $privateHome 'baseline;BASELINE;tail'
Sync-ClawPanelLegacyPath
$first=$env:Path
$env:Path='damaged-stage-path'
Sync-ClawPanelLegacyPath
if($env:Path -ne $first -or $first -notlike '*baseline;tail'){throw 'stage path'}
$child=Join-Path $temp 'child.ps1'
[IO.File]::WriteAllText($child,'@{pid=$PID;flag=$env:UV_NO_MODIFY_PATH}|ConvertTo-Json -Compress')
$childResult=(& "$PSHOME/powershell.exe" -NoProfile -File $child)|ConvertFrom-Json
if($childResult.flag -ne '1'){throw 'nested uv flag'}
$script:ClawPanelWingetAttempted=$false
$caught=$false
$blockedFrames=New-Object 'System.Collections.Generic.List[object]'
try { Invoke-ClawPanelManagedStage { try { winget install example }catch{}; '{"stage":"node","ok":true,"skipped":false,"reason":null,"duration_ms":1}' } | ForEach-Object {$blockedFrames.Add($_)} }catch{$caught=$true}
if(-not $caught -or -not $script:ClawPanelWingetAttempted){throw 'swallowed forbidden fallback'}
if($blockedFrames.Count -ne 1 -or ($blockedFrames[0]|ConvertFrom-Json).ok){throw 'false stage frame'}
$blockedFrames.Clear()
try { Invoke-ClawPanelManagedStage { winget install example } | ForEach-Object {$blockedFrames.Add($_)} }catch{}
if($blockedFrames.Count -ne 1 -or ($blockedFrames[0]|ConvertFrom-Json).ok){throw 'missing failed stage frame'}
@{pid=$PID;childPid=$childResult.pid;flag=$childResult.flag;wingetBlocked=$caught;path=$first;kind='isolated-process-sink-not-install'}|ConvertTo-Json -Compress
`)
  assert.equal(r.wingetBlocked, true)
  assert.equal(r.flag, '1')
  assert.notEqual(r.pid, r.childPid)
  t.diagnostic(JSON.stringify(r))
})

test('PS5执行入口在任何安装前拒绝未知stage/错pin/非固定vendor hash', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$rejected=0
foreach($stage in @('', 'path', 'system-packages', 'gateway')){try{Assert-ClawPanelLegacyStage $stage}catch{$rejected++}}
if($rejected -ne 4){throw 'stage accepted'}
foreach($stage in @('uv','git','node','repository','python','venv','dependencies','node-deps','config-templates','platform-sdks','bootstrap-marker')){Assert-ClawPanelLegacyStage $stage}
$hashRejected=$false
try{ $null=Read-ClawPanelLegacyInstaller $fixturePath }catch{$hashRejected=$true}
if(-not $hashRejected){throw 'fixture accepted as vendor'}
$cli=@()
foreach($case in @(@('path','f97608f178d1ffeca59860195ab7da295f7c8e5f',2),@('uv','wrong-pin',1),@('uv','f97608f178d1ffeca59860195ab7da295f7c8e5f',1))){
  $savedEap=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  $o=(& "$PSHOME/powershell.exe" -NoProfile -File $wrapperPath -InstallerPath $fixturePath -HermesHome $temp -InstallDir (Join-Path $temp 'source') -Branch 'v2026.9.24' -Commit $case[1] -ForceCommit -SkipSetup -SkipComputerUse -NonInteractive -Json -Stage $case[0] 2>$null)
  $ErrorActionPreference=$savedEap
  if($LASTEXITCODE -ne $case[2]){throw "CLI exit: $LASTEXITCODE"}
  $frame=$o|ConvertFrom-Json
  if($frame.ok){throw 'CLI accepted unsafe source'}
  $cli+=@{exit=$LASTEXITCODE;stage=$case[0];ok=$frame.ok}
}
@{pid=$PID;rejected=$rejected;hashRejected=$hashRejected;cli=$cli}|ConvertTo-Json -Depth 4 -Compress
`)
  assert.equal(r.rejected, 4)
  assert.equal(r.hashRejected, true)
  assert.deepEqual(r.cli.map(x => x.exit), [2, 1, 1])
  t.diagnostic(JSON.stringify(r))
})

test('固定 UV 版本/hash 和 NoProfile 子进程入口在共享 wrapper 内，不保留浮动执行', () => {
  const ps = fs.readFileSync(wrapper, 'utf8')
  assert.match(ps, /function Get-ClawPanelPinnedUvInstaller/)
  assert.match(ps, /f6c934a9926096f957615f9f5276efd3caeab58253eec613963a72d12b380e63/)
  assert.match(ps, /https:\/\/releases\.astral\.sh\/github\/uv\/releases\/download\/0\.13\.1\/uv-installer\.ps1/)
  assert.match(ps, /https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/0\.13\.1\/uv-installer\.ps1/)
  assert.match(ps, /-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \$installer -NoModifyPath/)
})

test('PS5 两处 UV AST 精确适配；host、flags、URL、重定向、签名和数量漂移均拒绝', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$source=[IO.File]::ReadAllText($fixturePath)
$r=Get-ClawPanelLegacyDefinitions $source
if($r.Redirections -ne 5 -or $r.UvInvocations -ne 2 -or $r.Definitions.Count -ne 4){throw 'missing narrow uv adaptation'}
$uv=$r.Definitions[-1]
if($uv -match 'irm |iex|latest/download|& \\$psHostExe'){throw 'floating invocation left executable'}
if(([regex]::Matches($uv,'Invoke-ClawPanelPinnedUvInstaller')).Count -ne 2){throw 'missing two invocations'}
$badSources=@(
  $source.Replace('function Install-Uv {','function Install-Uv {param($extra)'),
  $source.Replace('$psHostExe -ExecutionPolicy','$otherHost -ExecutionPolicy'),
  $source.Replace('-ExecutionPolicy ByPass -c','-ExecutionPolicy RemoteSigned -c'),
  $source.Replace('https://astral.sh/uv/install.ps1','https://untrusted.invalid/install.ps1'),
  $source.Replace('2>&1 | Tee-Object','3>&1 | Tee-Object'),
  $source.Replace('function Install-Uv {','function Different-Uv {'),
  ($source + '\nfunction Install-Uv {}'),
  $source.Replace('& $psHostExe -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex" 2>&1','Write-Output first-removed'),
  $source.Replace('$astralOut = @();','$astralOut = @(); & $psHostExe -c "extra";')
)
$rejected=0
foreach($s in $badSources){try{$null=Get-ClawPanelLegacyDefinitions $s}catch{$rejected++}}
if($rejected -ne $badSources.Count){throw "UV negative accepted: $rejected"}
@{redirections=$r.Redirections;uvInvocations=$r.UvInvocations;negativeRejected=$rejected;kind='PS5-AST-no-install'}|ConvertTo-Json -Compress
`)
  assert.equal(r.uvInvocations, 2)
  assert.equal(r.negativeRejected, 9)
  t.diagnostic(JSON.stringify(r))
})

test('PS5 假下载坏字节/缓存篡改均不执行，原两源分支有界保留下载错误', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$privateHome=Join-Path $temp 'private home'
$null=New-Item -ItemType Directory -Force $privateHome
Initialize-ClawPanelLegacyEnvironment $privateHome $env:Path
$script:requests=New-Object 'System.Collections.Generic.List[object]'
function Invoke-WebRequest {
  param($Uri,$OutFile,$TimeoutSec,$MaximumRedirection,[switch]$UseBasicParsing,$ErrorAction)
  $script:requests.Add(@{uri=$Uri;timeout=$TimeoutSec;redirects=$MaximumRedirection;out=$OutFile})
  if($Uri -like 'https://releases.astral.sh/*'){throw 'fixture-primary-network-blocked'}
  [IO.File]::WriteAllText($OutFile,'throw "download-must-never-execute"')
}
function Get-PowerShellHostExe { return "$PSHOME/powershell.exe" }
$HermesHome=$privateHome
$r=Get-ClawPanelLegacyDefinitions ([IO.File]::ReadAllText($fixturePath))
. ([ScriptBlock]::Create($r.Definitions[-1]))
$all=@(Install-Uv)
if($script:requests.Count -ne 2){throw "not exactly original bounded two sources: $($script:requests.Count)"}
if(($all -join '|') -notmatch 'fixture-primary-network-blocked' -or ($all -join '|') -notmatch 'SHA256|size'){throw 'lost original download/hash errors'}
foreach($request in $script:requests){
  # PS5 的 GetFullPath 会展开 Node realpathSync 仍保留的 8.3 别名；预期必须遵循同一实际路径契约。
  $expectedPrefix=[IO.Path]::GetFullPath($privateHome).TrimEnd('\\') + '\\'
  [Console]::Error.WriteLine('CLAWPANEL_UV_PATH_RECEIPT ' + (@{scope='download';temp=$temp;home=$privateHome;homeFull=[IO.Path]::GetFullPath($privateHome);actual=$request.out;expectedPrefix=$expectedPrefix;timeout=$request.timeout;redirects=$request.redirects}|ConvertTo-Json -Compress))
  if($request.timeout -ne 30 -or $request.redirects -ne 5 -or -not $request.out.StartsWith($expectedPrefix)){throw 'unbounded/outside download'}
}
$cache=Join-Path $privateHome '.cache/clawpanel-installers/uv-0.13.1-f6c934a9926096f957615f9f5276efd3caeab58253eec613963a72d12b380e63.ps1'
[IO.File]::WriteAllText($cache,'corrupt cache')
$before=$script:requests.Count
$rejected=$false
try{$null=Get-ClawPanelPinnedUvInstaller 'github'}catch{$rejected=$true}
if(-not $rejected -or $script:requests.Count -ne $before){throw 'tampered cache silently reused or repaired'}
$wrongHash=Join-Path $privateHome 'same-size-wrong-hash.ps1'
[IO.File]::WriteAllBytes($wrongHash,(New-Object byte[] 23285))
$hashRejected=$false
try{Assert-ClawPanelPinnedUvBytes $wrongHash}catch{if("$_" -match 'SHA256 mismatch'){$hashRejected=$true}}
if(-not $hashRejected){throw 'equal-size corrupt bytes accepted'}
if(@(Get-ChildItem -LiteralPath (Split-Path $cache -Parent) -Filter '*.partial').Count){throw 'download partial leaked'}
@{requests=@($script:requests.ToArray());errors=$all;cacheRejected=$rejected;hashRejected=$hashRejected;kind='fake-download-no-UV-execution'}|ConvertTo-Json -Depth 5 -Compress
`)
  assert.equal(r.requests.length, 2)
  assert.equal(r.cacheRejected, true)
  assert.equal(r.hashRejected, true)
  t.diagnostic(JSON.stringify(r))
})

test('PS5 缓存拒绝 HOME 外路径、junction 及目录冒充文件，未下载也未执行', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$privateHome=Join-Path $temp 'private home'
$outside=Join-Path $temp 'outside private home'
$null=New-Item -ItemType Directory -Force $privateHome,$outside
Initialize-ClawPanelLegacyEnvironment $privateHome $env:Path
$script:requests=0
function Invoke-WebRequest {throw 'must not download on invalid path'}
$rejected=0
try{$null=Assert-ClawPanelUvPrivatePath (Join-Path $outside 'file.ps1')}catch{$rejected++}
$null=New-Item -ItemType Junction -Path (Join-Path $privateHome '.cache') -Target $outside
try{$null=Get-ClawPanelPinnedUvInstaller 'astral'}catch{if("$_" -match 'reparse path'){$rejected++}}
try{Assert-ClawPanelPinnedUvBytes $outside}catch{if("$_" -match 'non-regular installer'){$rejected++}}
if($rejected -ne 3 -or @(Get-ChildItem -LiteralPath $outside).Count){throw 'private path boundary failed'}
@{rejected=$rejected;kind='owned-temp-junction-no-install'}|ConvertTo-Json -Compress
`)
  assert.equal(r.rejected, 3)
  t.diagnostic(JSON.stringify(r))
})

test('PS5 真子进程 sink 验证 NoProfile/NonInteractive/私有 env、退出码和进程环境恢复', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$privateHome=Join-Path $temp 'private home'
$null=New-Item -ItemType Directory -Force $privateHome
Initialize-ClawPanelLegacyEnvironment $privateHome $env:Path
$sink=Join-Path $temp 'harmless uv argv sink.ps1'
[IO.File]::WriteAllText($sink, @'
param([switch]$NoModifyPath)
@{pid=$PID;argv=[Environment]::GetCommandLineArgs();noModify=[bool]$NoModifyPath;flag=$env:UV_NO_MODIFY_PATH;install=$env:UV_INSTALL_DIR;config=$env:XDG_CONFIG_HOME;download=$env:UV_DOWNLOAD_URL;unmanaged=$env:UV_UNMANAGED_INSTALL;ci=$env:GITHUB_PATH}|ConvertTo-Json -Compress
exit 7
'@)
# 只替换本次测试进程的已校验下载边界；实际固定哈希函数另有坏字节及真实只读原字节验收。
function Get-ClawPanelPinnedUvInstaller {param($SourceId) return $sink}
$env:UV_DOWNLOAD_URL='https://fixture.invalid/floating'
$env:UV_UNMANAGED_INSTALL='outside-fixture'
$env:GITHUB_PATH='outside-ci-file'
$before=[Environment]::GetEnvironmentVariables('Process')|ConvertTo-Json -Compress
$output=@(Invoke-ClawPanelPinnedUvInstaller -HostExe "$PSHOME/powershell.exe" -SourceId 'astral')
$code=$LASTEXITCODE
$after=[Environment]::GetEnvironmentVariables('Process')|ConvertTo-Json -Compress
if($before -cne $after){throw 'wrapper process env not restored'}
$child=$output|Where-Object {$_ -is [string] -and $_.StartsWith('{')}|Select-Object -First 1|ConvertFrom-Json
if(-not $child -or $child.pid -eq $PID -or $code -ne 7){throw 'sink/exit masked'}
if($child.argv -notcontains '-NoProfile' -or $child.argv -notcontains '-NonInteractive' -or $child.argv -notcontains '-File' -or $child.argv -contains '-c'){throw 'unsafe argv'}
$expectedInstall=[IO.Path]::GetFullPath((Join-Path $privateHome 'bin'))
$expectedConfig=[IO.Path]::GetFullPath((Join-Path $privateHome '.config'))
[Console]::Error.WriteLine('CLAWPANEL_UV_PATH_RECEIPT ' + (@{scope='child-env';temp=$temp;home=$privateHome;homeFull=[IO.Path]::GetFullPath($privateHome);actualInstall=$child.install;expectedInstall=$expectedInstall;actualConfig=$child.config;expectedConfig=$expectedConfig;flag=$child.flag;noModify=$child.noModify}|ConvertTo-Json -Compress))
if(-not $child.noModify -or $child.flag -ne '1' -or $child.install -ne $expectedInstall -or $child.config -ne $expectedConfig){throw 'private env'}
if($child.download -or $child.unmanaged -or $child.ci){throw 'inherited redirect env'}
$outside=Join-Path $temp 'outside bin'
$null=New-Item -ItemType Directory -Force $outside
$null=New-Item -ItemType Junction -Path (Join-Path $privateHome 'bin') -Target $outside
$blocked=@(Invoke-ClawPanelPinnedUvInstaller -HostExe "$PSHOME/powershell.exe" -SourceId 'astral')
if($LASTEXITCODE -ne 1 -or ($blocked -join '|') -notmatch 'reparse path' -or ($blocked -join '|') -match '"pid"'){throw 'private binary output junction reached child'}
if($before -cne ([Environment]::GetEnvironmentVariables('Process')|ConvertTo-Json -Compress)){throw 'blocked env not restored'}
@{pid=$PID;child=$child;exit=$code;envRestored=$true;outputJunctionBlocked=$true;kind='actual-PS5-harmless-child-not-install'}|ConvertTo-Json -Depth 5 -Compress
`)
  assert.equal(r.exit, 7)
  assert.equal(r.envRestored, true)
  assert.equal(r.outputJunctionBlocked, true)
  t.diagnostic(JSON.stringify(r))
})
