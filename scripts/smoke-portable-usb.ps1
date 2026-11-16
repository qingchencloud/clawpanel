# 面板仓库内的便携布局冒烟测试（开发自测用）。
# U 盘版的正式打包 / 写盘 / 验收工具在专用仓库 clawpanel-portable
# （https://github.com/qingchencloud/clawpanel-portable，本地 D:\Data\PC\clawpanel-portable），
# 正式验收请用其 scripts/verify-windows.ps1。
param(
  # 模拟模式：用 subst 虚拟盘符 + 桩 CLI（默认，无副作用，用于 CI/本机快速验证布局约定）
  [string]$DriveLetter = "",
  # 真实模式：指定真实 U 盘路径（如 F:\），严格只读校验，不创建目录、不补配置、不写桩。
  # openclaw/hermes/uv/git/node 任一缺失或执行失败都会令 ok=false 且退出码非零。
  [string]$UsbPath = "",
  [string]$RootName = "ClawPanelPortable",
  [switch]$Keep
)

$ErrorActionPreference = "Stop"

function Find-FreeDriveLetter {
  foreach ($letter in @("Z", "Y", "X", "W", "V", "U", "T", "S", "R", "Q", "P")) {
    if (-not (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue)) {
      return $letter
    }
  }
  throw "No free test drive letter found"
}

# 仅在文件不存在时写入（真实盘保护：绝不覆盖用户数据）
function Set-ContentIfAbsent {
  param([string]$Path, [object]$Value, [string]$Encoding = "UTF8")
  if (Test-Path -LiteralPath $Path) { return $false }
  $Value | Set-Content -LiteralPath $Path -Encoding $Encoding
  return $true
}

$realMode = -not [string]::IsNullOrWhiteSpace($UsbPath)
$hostRoot = $null
$driveName = $null

if ($realMode) {
  if (-not (Test-Path -LiteralPath $UsbPath)) {
    throw "UsbPath not found: $UsbPath"
  }
  $usbRoot = Join-Path $UsbPath $RootName
} else {
  if ([string]::IsNullOrWhiteSpace($DriveLetter)) {
    $DriveLetter = Find-FreeDriveLetter
  }
  $DriveLetter = $DriveLetter.Replace(':', '').ToUpperInvariant()
  if (Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue) {
    throw "Drive $DriveLetter already exists. Choose another DriveLetter."
  }
  $hostRoot = Join-Path $env:TEMP ("clawpanel-usb-smoke-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $hostRoot | Out-Null
  $driveName = $DriveLetter + ":"
}

try {
  if (-not $realMode) {
    $driveRoot = $DriveLetter + ":\"
    subst $driveName $hostRoot
    $usbRoot = Join-Path $driveRoot $RootName
  }
  $dataDir = Join-Path $usbRoot "data"
  $panelDir = Join-Path $dataDir "clawpanel"
  $openclawDir = Join-Path $dataDir "openclaw"
  $hermesHome = Join-Path $dataDir "hermes"
  $openclawEngine = Join-Path $usbRoot "engines\openclaw"
  $hermesBin = Join-Path $usbRoot "engines\hermes\bin"
  $uvBin = Join-Path $usbRoot "runtimes\uv\bin"
  $gitCmd = Join-Path $usbRoot "runtimes\git\cmd"

  if ($realMode) {
    # ===== 真实模式：严格只读，逐组件实测 =====
    function Test-Component {
      param([string]$Path, [string[]]$CmdArgs)
      if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ ok = $false; status = "missing"; output = $null }
      }
      try {
        $out = & $Path @CmdArgs 2>&1 | Select-Object -First 1
        if ($LASTEXITCODE -ne 0) {
          return [pscustomobject]@{ ok = $false; status = "error"; output = ($out -join " ") }
        }
        return [pscustomobject]@{ ok = $true; status = "ok"; output = ($out -join " ") }
      } catch {
        return [pscustomobject]@{ ok = $false; status = "error"; output = $_.Exception.Message }
      }
    }

    $manifest = $null
    $manifestOk = $false
    try {
      $raw = Get-Content -LiteralPath (Join-Path $usbRoot "portable.json") -Raw
      $manifest = $raw -replace "^﻿", "" | ConvertFrom-Json
      $manifestOk = ($manifest.mode -eq "portable")
    } catch {}

    $fsName = "unknown"
    try { $fsName = (Get-Volume -FilePath $usbRoot -ErrorAction Stop).FileSystem } catch {}

    $components = [ordered]@{
      openclaw = Test-Component -Path (Join-Path $openclawEngine "openclaw.cmd") -CmdArgs @("--version")
      hermes = Test-Component -Path (Join-Path $hermesBin "hermes.cmd") -CmdArgs @("version")
      node = Test-Component -Path (Join-Path $openclawEngine "node.exe") -CmdArgs @("--version")
      uv = Test-Component -Path (Join-Path $uvBin "uv.exe") -CmdArgs @("--version")
      git = Test-Component -Path (Join-Path $gitCmd "git.exe") -CmdArgs @("--version")
    }
    $componentsOk = -not ($components.Values | Where-Object { -not $_.ok } | Select-Object -First 1)
    $result = [pscustomobject]@{
      ok = ($manifestOk -and $componentsOk)
      mode = "real-usb"
      fileSystem = $fsName
      usbRoot = $usbRoot
      manifestMode = $manifest.mode
      openclaw = $components.openclaw
      hermes = $components.hermes
      node = $components.node
      uv = $components.uv
      git = $components.git
    }
    $result | ConvertTo-Json -Depth 4
    if (-not $result.ok) { exit 1 }
    return
  }

  foreach ($dir in @($panelDir, $openclawDir, $hermesHome, $openclawEngine, $hermesBin, $uvBin, $gitCmd)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  $null = Set-ContentIfAbsent -Path (Join-Path $usbRoot "portable.json") -Value (@{
    mode = "portable"
    dataDir = "./data"
    enginesDir = "./engines"
    runtimesDir = "./runtimes"
  } | ConvertTo-Json -Depth 4)

  $null = Set-ContentIfAbsent -Path (Join-Path $panelDir "clawpanel.json") -Value (@{
    accessPassword = "portable-smoke"
    engine = "openclaw"
  } | ConvertTo-Json -Depth 8)

  $null = Set-ContentIfAbsent -Path (Join-Path $openclawDir "openclaw.json") -Value '{ "gateway": { "port": 18789 }, "agents": { "main": { "name": "main" } } }'
  $null = Set-ContentIfAbsent -Path (Join-Path $hermesHome "config.yaml") -Value "model: smoke"

  # ===== 模拟模式：写桩 CLI，验证布局与 PATH 约定 =====
  @(
    "@echo off",
    "echo openclaw portable smoke"
  ) | Set-Content -LiteralPath (Join-Path $openclawEngine "openclaw.cmd") -Encoding ASCII

  @(
    "@echo off",
    'if "%1"=="version" (',
    "  echo Hermes Agent v0.0.0-portable-smoke",
    "  exit /b 0",
    ")",
    'if "%1"=="--version" (',
    "  echo Hermes Agent v0.0.0-portable-smoke",
    "  exit /b 0",
    ")",
    'if "%1"=="gateway" (',
    '  if "%2"=="status" (',
    "    echo stopped",
    "    exit /b 0",
    "  )",
    ")",
    "echo hermes portable smoke",
    "exit /b 0"
  ) | Set-Content -LiteralPath (Join-Path $hermesBin "hermes.cmd") -Encoding ASCII

  @(
    "@echo off",
    "echo uv 0.0.0-portable-smoke"
  ) | Set-Content -LiteralPath (Join-Path $uvBin "uv.cmd") -Encoding ASCII

  @(
    "@echo off",
    "echo git version 0.0.0-portable-smoke"
  ) | Set-Content -LiteralPath (Join-Path $gitCmd "git.cmd") -Encoding ASCII

  $oldPortableRoot = $env:CLAWPANEL_PORTABLE_ROOT
  $oldHermesHome = $env:HERMES_HOME
  $oldUvToolDir = $env:UV_TOOL_DIR
  $oldUvToolBinDir = $env:UV_TOOL_BIN_DIR
  $oldUvCacheDir = $env:UV_CACHE_DIR
  $oldUvPythonInstallDir = $env:UV_PYTHON_INSTALL_DIR
  $oldPath = $env:PATH

  $env:CLAWPANEL_PORTABLE_ROOT = $usbRoot
  $env:HERMES_HOME = $hermesHome
  $env:UV_TOOL_DIR = Join-Path $usbRoot "engines\hermes"
  $env:UV_TOOL_BIN_DIR = $hermesBin
  $env:UV_CACHE_DIR = Join-Path $usbRoot "runtimes\uv\cache"
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $usbRoot "runtimes\uv\python"
  $env:PATH = "$hermesBin;$openclawEngine;$uvBin;$gitCmd;$env:SystemRoot\System32"

  try {
    $hermesVersion = & hermes version
    $openclawVersion = & openclaw
    $gitVersion = & git --version
    $uvVersion = & uv --version
  } finally {
    $env:CLAWPANEL_PORTABLE_ROOT = $oldPortableRoot
    $env:HERMES_HOME = $oldHermesHome
    $env:UV_TOOL_DIR = $oldUvToolDir
    $env:UV_TOOL_BIN_DIR = $oldUvToolBinDir
    $env:UV_CACHE_DIR = $oldUvCacheDir
    $env:UV_PYTHON_INSTALL_DIR = $oldUvPythonInstallDir
    $env:PATH = $oldPath
  }

  [pscustomobject]@{
    ok = $true
    mode = "simulated"
    fileSystem = "subst(NTFS)"
    usbRoot = $usbRoot
    hostRoot = $hostRoot
    hermes = ($hermesVersion -join "`n")
    openclaw = ($openclawVersion -join "`n")
    git = ($gitVersion -join "`n")
    uv = ($uvVersion -join "`n")
  } | ConvertTo-Json -Depth 4
} finally {
  if (-not $realMode) {
    if (-not $Keep) {
      subst $driveName /D 2>$null
      Remove-Item -LiteralPath $hostRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Write-Host "Keeping test drive $driveName -> $hostRoot"
    }
  }
}
