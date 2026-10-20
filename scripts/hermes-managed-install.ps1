param(
    [string]$InstallerPath, [string]$HermesHome, [string]$InstallDir,
    [string]$Branch, [string]$Commit, [switch]$ForceCommit,
    [switch]$SkipSetup, [switch]$SkipComputerUse, [switch]$NonInteractive,
    [switch]$Json, [string]$Stage
)
$ErrorActionPreference = 'Stop'

function Assert-ClawPanelLegacyStage([string]$Name) {
    if ($Name -cnotin @('uv','git','node','repository','python','venv','dependencies','node-deps','config-templates','platform-sdks','bootstrap-marker')) {
        throw 'ClawPanel legacy installer: unknown or unmanaged stage'
    }
}

function Read-ClawPanelLegacyInstaller([string]$SourcePath) {
    # 原版字节只读；不接受用户提供另一 hash，不修改 vendor 文件。
    $item = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ClawPanel legacy installer: non-regular source' }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($hash -cne '0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2') { throw 'ClawPanel legacy installer: pinned vendor SHA256 mismatch' }
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Get-ClawPanelLegacyDefinitions([string]$Source) {
    # 严核固定旧版的三函数五个环境节点；UV 两调用另行验证，不全局替换整个安装器。
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'ClawPanel legacy installer: AST parse failure' }
    $specs = [ordered]@{
        'Set-ManagedNodeFirstOnUserPath' = @(@('GetEnvironmentVariable','Path',2), @('SetEnvironmentVariable','Path',3))
        'Install-Git' = @(@('GetEnvironmentVariable','Path',2), @('SetEnvironmentVariable','Path',3))
        'Set-GitBashEnvVar' = @(,@('SetEnvironmentVariable','HERMES_GIT_BASH_PATH',3))
    }
    $definitions = @(); $total = 0
    foreach ($name in $specs.Keys) {
        $functions = @($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $true) | Where-Object { $_.Name -ceq $name })
        if ($functions.Count -ne 1) { throw "ClawPanel legacy installer: function count $name" }
        $fn = $functions[0]
        if ($fn.IsFilter -or $fn.IsWorkflow -or $fn.Parameters.Count) { throw "ClawPanel legacy installer: signature $name" }
        $parameters = @($fn.Body.ParamBlock.Parameters)
        if ($name -ceq 'Set-ManagedNodeFirstOnUserPath') {
            if ($parameters.Count -ne 1 -or $parameters[0].Name.VariablePath.UserPath -cne 'NodeDir' -or
                $parameters[0].DefaultValue -or $parameters[0].Attributes.Count -ne 1 -or
                $parameters[0].Attributes[0] -isnot [System.Management.Automation.Language.TypeConstraintAst] -or
                $parameters[0].Attributes[0].TypeName.FullName -cne 'string') { throw "ClawPanel legacy installer: signature $name" }
        } elseif ($fn.Body.ParamBlock) { throw "ClawPanel legacy installer: signature $name" }
        $calls = @($fn.Body.FindAll({param($n)
            $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
            $n.Member.Value -in @('GetEnvironmentVariable','SetEnvironmentVariable') -and $n.Arguments.Count -ge 2
        }, $true))
        $expected = $specs[$name]
        if ($calls.Count -ne $expected.Count) { throw "ClawPanel legacy installer: call count $name" }
        $edits = @()
        for ($i = 0; $i -lt $calls.Count; $i++) {
            $call = $calls[$i]; $spec = $expected[$i]
            if (-not $call.Static -or $call.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst] -or
                $call.Expression.TypeName.FullName -cne 'Environment' -or $call.Member.Value -cne $spec[0] -or
                $call.Arguments.Count -ne $spec[2] -or
                $call.Arguments[0] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $call.Arguments[0].Value -cne $spec[1]) { throw "ClawPanel legacy installer: call shape $name" }
            $target = $call.Arguments[$call.Arguments.Count - 1]
            if ($target -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $target.Value -cne 'User') { throw "ClawPanel legacy installer: target $name" }
            if ($call.Member.Value -ceq 'SetEnvironmentVariable') {
                $value = @{ 'Set-ManagedNodeFirstOnUserPath'='$updated'; 'Install-Git'='($userPathItems -join ";")'; 'Set-GitBashEnvVar'='$candidate' }[$name]
                if ($call.Arguments[1].Extent.Text -cne $value) { throw "ClawPanel legacy installer: value shape $name" }
            }
            $edits += @{ Start=($target.Extent.StartOffset - $fn.Extent.StartOffset); Length=($target.Extent.EndOffset - $target.Extent.StartOffset) }
        }
        $definition = $fn.Extent.Text
        foreach ($edit in ($edits | Sort-Object Start -Descending)) {
            $definition = $definition.Substring(0,$edit.Start) + "'Process'" + $definition.Substring($edit.Start + $edit.Length)
        }
        $definitions += $definition; $total += $edits.Count
    }
    if ($total -ne 5) { throw 'ClawPanel legacy installer: expected exactly five redirections' }
    # 固定 vendor 的 Install-Uv 只替换两个原生调用节点；其余分支、日志及失败处理原样保留。
    $uvFunctions = @($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $true) | Where-Object { $_.Name -ceq 'Install-Uv' })
    if ($uvFunctions.Count -ne 1) { throw 'ClawPanel legacy installer: function count Install-Uv' }
    $uv = $uvFunctions[0]
    if ($uv.IsFilter -or $uv.IsWorkflow -or $uv.Parameters.Count -or $uv.Body.ParamBlock) { throw 'ClawPanel legacy installer: signature Install-Uv' }
    $commands = @($uv.Body.FindAll({param($n)
        $n -is [System.Management.Automation.Language.CommandAst] -and
        $n.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Ampersand
    }, $true))
    if ($commands.Count -ne 2) { throw 'ClawPanel legacy installer: expected exactly two UV invocations' }
    $sources = @('https://astral.sh/uv/install.ps1', 'https://github.com/astral-sh/uv/releases/latest/download/uv-installer.ps1')
    $sourceIds = @('astral','github'); $edits = @()
    for ($i = 0; $i -lt 2; $i++) {
        $command = $commands[$i]; $elements = $command.CommandElements
        if ($elements.Count -ne 5 -or
            $elements[0] -isnot [System.Management.Automation.Language.VariableExpressionAst] -or $elements[0].VariablePath.UserPath -cne 'psHostExe' -or
            $elements[1] -isnot [System.Management.Automation.Language.CommandParameterAst] -or $elements[1].ParameterName -cne 'ExecutionPolicy' -or
            $elements[2] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $elements[2].Value -cne 'ByPass' -or
            $elements[3] -isnot [System.Management.Automation.Language.CommandParameterAst] -or $elements[3].ParameterName -cne 'c' -or
            $elements[4] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $elements[4].Value -cne "irm $($sources[$i]) | iex" -or
            $command.Redirections.Count -ne 1 -or
            $command.Redirections[0] -isnot [System.Management.Automation.Language.MergingRedirectionAst] -or
            $command.Redirections[0].FromStream -ne [System.Management.Automation.Language.RedirectionStream]::Error -or
            $command.Redirections[0].ToStream -ne [System.Management.Automation.Language.RedirectionStream]::Output) { throw 'ClawPanel legacy installer: UV invocation shape' }
        $edits += @{Start=($command.Extent.StartOffset - $uv.Extent.StartOffset);Length=($command.Extent.EndOffset - $command.Extent.StartOffset);SourceId=$sourceIds[$i]}
    }
    $definition = $uv.Extent.Text
    foreach ($edit in ($edits | Sort-Object Start -Descending)) {
        $replacement = 'Invoke-ClawPanelPinnedUvInstaller -HostExe $psHostExe -SourceId ''' + $edit.SourceId + ''' 2>&1'
        $definition = $definition.Substring(0,$edit.Start) + $replacement + $definition.Substring($edit.Start + $edit.Length)
    }
    $definitions += $definition
    return @{ Definitions=$definitions; Redirections=$total; UvInvocations=$edits.Count }
}

function Assert-ClawPanelUvPrivatePath([string]$Path) {
    $root = [IO.Path]::GetFullPath($script:ClawPanelManagedHome).TrimEnd('\','/')
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -cne $root -and -not $full.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'ClawPanel pinned UV: path outside managed home' }
    # 对已存在的每一级父目录也核对，不将 HOME/缓存 junction 当作隔离目录。
    $current = $full
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ClawPanel pinned UV: reparse path' }
        $parent = Split-Path -Path $current -Parent
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $full
}

function Assert-ClawPanelPinnedUvBytes([string]$SourcePath) {
    $item = Get-Item -LiteralPath $SourcePath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ClawPanel pinned UV: non-regular installer' }
    if ($item.Length -ne 23285) { throw 'ClawPanel pinned UV: size mismatch' }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($item.FullName)))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($hash -cne 'f6c934a9926096f957615f9f5276efd3caeab58253eec613963a72d12b380e63') { throw 'ClawPanel pinned UV: SHA256 mismatch' }
}

function Get-ClawPanelPinnedUvInstaller([ValidateSet('astral','github')][string]$SourceId) {
    # 两个固定官方源对应同一 immutable release 原字节；每处原调用最多下载一次。
    $urls = @{
        astral='https://releases.astral.sh/github/uv/releases/download/0.13.1/uv-installer.ps1'
        github='https://github.com/astral-sh/uv/releases/download/0.13.1/uv-installer.ps1'
    }
    $directory = Assert-ClawPanelUvPrivatePath (Join-Path $script:ClawPanelManagedHome '.cache\clawpanel-installers')
    $null = [IO.Directory]::CreateDirectory($directory)
    $null = Assert-ClawPanelUvPrivatePath $directory
    $cache = Assert-ClawPanelUvPrivatePath (Join-Path $directory 'uv-0.13.1-f6c934a9926096f957615f9f5276efd3caeab58253eec613963a72d12b380e63.ps1')
    if (Test-Path -LiteralPath $cache) {
        Assert-ClawPanelPinnedUvBytes $cache
        return $cache
    }
    $partial = Assert-ClawPanelUvPrivatePath (Join-Path $directory ([Guid]::NewGuid().ToString('N') + '.partial'))
    try {
        $file = [IO.File]::Open($partial,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $file.Dispose()
        Invoke-WebRequest -Uri $urls[$SourceId] -OutFile $partial -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 5 -ErrorAction Stop
        $null = Assert-ClawPanelUvPrivatePath $partial
        Assert-ClawPanelPinnedUvBytes $partial
        $null = Assert-ClawPanelUvPrivatePath $cache
        [IO.File]::Move($partial,$cache)
        return $cache
    } finally {
        if (Test-Path -LiteralPath $partial) {
            $null = Assert-ClawPanelUvPrivatePath $partial
            [IO.File]::Delete($partial)
        }
    }
}

function Invoke-ClawPanelPinnedUvInstaller([string]$HostExe, [ValidateSet('astral','github')][string]$SourceId) {
    $saved = @{}
    try {
        $currentHost = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        if (-not [IO.Path]::IsPathRooted($HostExe) -or [IO.Path]::GetFullPath($HostExe) -ine $currentHost) { throw 'ClawPanel pinned UV: unexpected PowerShell host' }
        $installer = Get-ClawPanelPinnedUvInstaller $SourceId
        $binaryDirectory = Assert-ClawPanelUvPrivatePath (Join-Path $script:ClawPanelManagedHome 'bin')
        $configDirectory = Assert-ClawPanelUvPrivatePath (Join-Path $script:ClawPanelManagedHome '.config')
        # 仅本 worker 进程临时设置，finally 原值恢复；子进程不继承可改下载源/输出位置的覆盖项。
        $values = @{
            UV_NO_MODIFY_PATH='1';UV_INSTALL_DIR=$binaryDirectory;XDG_CONFIG_HOME=$configDirectory
            UV_DOWNLOAD_URL=$null;INSTALLER_DOWNLOAD_URL=$null;UV_INSTALLER_GHE_BASE_URL=$null;UV_INSTALLER_GITHUB_BASE_URL=$null
            UV_UNMANAGED_INSTALL=$null;CARGO_DIST_FORCE_INSTALL_DIR=$null;GITHUB_PATH=$null
        }
        foreach ($name in $values.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
            [Environment]::SetEnvironmentVariable($name,$values[$name],'Process')
        }
        & $HostExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -NoModifyPath
        $global:LASTEXITCODE = $LASTEXITCODE
        if ($LASTEXITCODE -ne 0) { Write-Output "ClawPanel pinned UV $SourceId child exited $LASTEXITCODE" }
    } catch {
        $global:LASTEXITCODE = 1
        # 保留原 Install-Uv 两次调用的返回语义：首源错误进入 Tee 日志，再由原分支尝试 mirror。
        Write-Output "ClawPanel pinned UV $SourceId failed: $_"
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    }
}

function Initialize-ClawPanelLegacyEnvironment([string]$HomePath, [string]$BasePath) {
    $script:ClawPanelManagedHome = [IO.Path]::GetFullPath($HomePath)
    $script:ClawPanelManagedBasePath = $BasePath
    $env:UV_NO_MODIFY_PATH = '1'
    $script:ClawPanelWingetAttempted = $false
}

function Sync-ClawPanelLegacyPath {
    # 每个 stage 都从受管目录及父进程传入 PATH 重建，不依赖 User/Machine 写入。
    $entries = @()
    foreach ($relative in @('bin','git\cmd','git\bin','git\usr\bin','node')) {
        $candidate = Join-Path $script:ClawPanelManagedHome $relative
        if (Test-Path -LiteralPath $candidate -PathType Container) { $entries += $candidate }
    }
    $entries += @($script:ClawPanelManagedBasePath -split ';')
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $ordered = @($entries | Where-Object { $_ -and $seen.Add($_) })
    $env:Path = $ordered -join ';'
}

function winget {
    # 在命令函数入口拦截，绝不调用系统 winget；上游 catch 也不能消除触发标记。
    $script:ClawPanelWingetAttempted = $true
    [Console]::Error.WriteLine('CLAWPANEL_MANAGED_INSTALL winget-blocked')
    throw 'ClawPanel managed install forbids system winget fallback'
}

function Invoke-ClawPanelManagedStage([scriptblock]$Action) {
    $frames = New-Object 'System.Collections.Generic.List[object]'
    $started = [DateTime]::UtcNow
    $failure = $null
    try { & $Action | ForEach-Object { $frames.Add($_) } } catch { $failure = $_ }
    if ($script:ClawPanelWingetAttempted) {
        # 原 worker 可能 catch 后声称 ok；保留日志但将其 stage frame 变为明确失败。
        $emitted = $false
        foreach ($frame in $frames) {
            try { $parsed = $frame | ConvertFrom-Json -ErrorAction Stop } catch { Write-Output $frame; continue }
            if ($parsed.PSObject.Properties.Name -contains 'stage' -and $parsed.PSObject.Properties.Name -contains 'ok') {
                $parsed.ok = $false; $parsed.skipped = $false
                $parsed.reason = 'ClawPanel managed install blocked system winget fallback'
                $parsed | ConvertTo-Json -Compress | Write-Output
                $emitted = $true
            } else { Write-Output $frame }
        }
        if (-not $emitted) {
            @{stage=$Stage;ok=$false;skipped=$false;reason='ClawPanel managed install blocked system winget fallback';duration_ms=[int]([DateTime]::UtcNow - $started).TotalMilliseconds} | ConvertTo-Json -Compress | Write-Output
        }
        throw 'ClawPanel managed install blocked system winget fallback after Invoke-Stage'
    }
    $frames | Write-Output
    if ($null -ne $failure) { throw $failure }
}

function Invoke-ClawPanelLegacyInstaller {
    Assert-ClawPanelLegacyStage $Stage
    if ($Branch -cne 'v2026.9.24' -or $Commit -cne 'f97608f178d1ffeca59860195ab7da295f7c8e5f' -or
        -not ($ForceCommit -and $SkipSetup -and $SkipComputerUse -and $NonInteractive -and $Json)) { throw 'ClawPanel legacy installer: fixed pin/flags required' }
    $homePath = [IO.Path]::GetFullPath($HermesHome).TrimEnd('\') + '\'
    foreach ($p in @($InstallerPath,$InstallDir)) {
        if (-not [IO.Path]::GetFullPath($p).StartsWith($homePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'ClawPanel legacy installer: path outside managed home' }
    }
    $source = Read-ClawPanelLegacyInstaller $InstallerPath
    $adapted = Get-ClawPanelLegacyDefinitions $source
    Initialize-ClawPanelLegacyEnvironment $HermesHome $env:Path
    $vendorArgs = @{HermesHome=$HermesHome;InstallDir=$InstallDir;Branch=$Branch;Commit=$Commit;ForceCommit=$true;SkipSetup=$true;SkipComputerUse=$true;NonInteractive=$true;Json=$true;Stage=$Stage}
    . $InstallerPath @vendorArgs
    foreach ($definition in $adapted.Definitions) { . ([ScriptBlock]::Create($definition)) }
    function Sync-EnvPath { Sync-ClawPanelLegacyPath }
    [Console]::Error.WriteLine("CLAWPANEL_MANAGED_INSTALL stage=$Stage redirections=5 uv-invocations=2 uv-version=0.13.1 vendor-sha256=0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2")
    $def = Get-InstallStage -Name $Stage
    if (-not $def) { throw 'ClawPanel legacy installer: missing official stage' }
    Step-OutOfInstallDir
    Invoke-ClawPanelManagedStage { Invoke-Stage -StageDef $def }
    # 即使未来 stage 层吞错，标记仍须导致进程失败。
    if ($script:ClawPanelWingetAttempted) { throw 'ClawPanel managed install forbidden fallback' }
}

# 供隔离解析/sink 测试加载函数；执行入口始终执行固定原版 hash 门禁。
if ($MyInvocation.InvocationName -eq '.') { return }
$script:ClawPanelWingetAttempted = $false
try {
    Assert-ClawPanelLegacyStage $Stage
} catch {
    @{stage=$Stage;ok=$false;reason='unknown or unmanaged stage'} | ConvertTo-Json -Compress | Write-Output
    exit 2
}
try {
    Invoke-ClawPanelLegacyInstaller
    exit 0
} catch {
    if (-not $script:_StageEmittedErrorFrame -and -not $script:ClawPanelWingetAttempted) {
        @{stage=$Stage;ok=$false;reason="$_"} | ConvertTo-Json -Compress | Write-Output
    }
    [Console]::Error.WriteLine("CLAWPANEL_MANAGED_INSTALL failed: $_")
    exit 1
}
