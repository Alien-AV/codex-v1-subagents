$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'launch-errors.ps1')
$directory = Join-Path ([IO.Path]::GetTempPath()) ('codex-launch-error-test-' + [Guid]::NewGuid().ToString('N'))
$previousConfigHome = $env:CODEX_HOME
$previousErrorFile = $env:CODEX_V1_ERROR_FILE
New-Item -ItemType Directory -Path $directory | Out-Null
try {
    $config = Join-Path $directory 'config.toml'
    $log = Join-Path $directory 'runtime-patch.log'
    $message = Get-LaunchFailureMessage 'Windows could not access config.toml after 7 automatic attempts.' $log $config $true 'Restored original Codex config: test'
    if ($message -notmatch 'Your config was restored' -or $message -notmatch 'launch again') { throw 'Missing restored status/action' }
    [IO.File]::WriteAllText(($config + '.codex-v1-subagents.backup'), 'backup')
    $message = Get-LaunchFailureMessage 'Temporary setting changed' $log $config $true 'Restored original Codex config: stale'
    if ($message -notmatch 'NOT confirmed' -or $message -notmatch 'Backup:' -or $message -notmatch 'do not overwrite') { throw 'Missing recovery warning/action' }
    Remove-Item -LiteralPath ($config + '.codex-v1-subagents.backup')
    $message = Get-LaunchFailureMessage 'Codex is already running. Fully quit it.' $log $config $false 'Restored original Codex config: stale'
    if ($message -match 'Your config was restored' -or $message -notmatch 'did not change') { throw 'Stale log was trusted' }
    $message = Get-LaunchFailureMessage 'Unexpected error' $log $config $true ''
    if ($message -notmatch 'could not be confirmed') { throw 'Unknown status incorrectly presented as safe' }

    # Evaluate only the installer's generated-script expressions; never install shortcuts.
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/install.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw $parseErrors[0] }
    $powershell = (Get-Process -Id $PID).Path
    $fixture = Join-Path $PSScriptRoot 'shortcut-failure.ps1'
    $vbsCommand = ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f $powershell, $fixture).Replace('"', '""')
    $vbsLog = $log.Replace('"', '""')
    $vbsInstallRoot = $directory.Replace('"', '""')
    $vbsCodexExe = 'C:\not-a-running-codex.exe'
    $assignment = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$vbs' }, $true)
    $vbs = Invoke-Expression $assignment.Right.Extent.Text
    $vbs = $vbs.Replace('shell.Popup failureMessage, 0, "Codex v1 Subagents", 16', 'WScript.Echo failureMessage')
    $vbsPath = Join-Path $directory 'test.vbs'
    [IO.File]::WriteAllText($vbsPath, $vbs, [Text.Encoding]::Unicode)
    $output = & (Join-Path $env:WINDIR 'System32\cscript.exe') //Nologo $vbsPath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $output -notmatch '7 automatic attempts' -or $output -notmatch 'Your config was restored' -or $output -notmatch 'launch again') { throw "Shortcut did not show the detailed failure: $output" }
    if (@(Get-ChildItem -LiteralPath $directory -Filter '*.tmp').Count) { throw 'Shortcut left a failure-report file behind' }

    $escapedNpx = (Join-Path $directory 'missing-npx.cmd').Replace("'", "''")
    $escapedLog = $log.Replace("'", "''")
    $assignment = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$autoLauncherSource' }, $true)
    $autoSource = Invoke-Expression $assignment.Right.Extent.Text
    [void][Management.Automation.Language.Parser]::ParseInput($autoSource, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw $parseErrors[0] }

    # Exercise launch.ps1's real preflight trap, with an isolated config root.
    $env:CODEX_HOME = $directory
    $env:CODEX_V1_ERROR_FILE = Join-Path $directory 'failure.txt'
    [IO.File]::WriteAllText($log, 'Restored original Codex config: stale attempt')
    $launch = (Join-Path $root 'launch.ps1').Replace("'", "''")
    $command = "function Get-Process { [pscustomobject]@{ Id = 123 } }; & '$launch' -LogFile '$escapedLog'"
    $ErrorActionPreference = 'Continue'
    & $powershell -NoProfile -Command $command 2>$null
    $preflightExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $report = [IO.File]::ReadAllText($env:CODEX_V1_ERROR_FILE)
    if ($preflightExit -ne 1 -or $report -notmatch 'Codex is already running' -or $report -notmatch 'did not change' -or $report -match 'Your config was restored') { throw 'Preflight did not report a fresh, actionable error' }

    $autoPath = Join-Path $directory 'auto.ps1'
    [IO.File]::WriteAllText($autoPath, $autoSource)
    $ErrorActionPreference = 'Continue'
    & $powershell -NoProfile -File $autoPath 2>$null
    $autoExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($autoExit -eq 0 -or [IO.File]::ReadAllText($env:CODEX_V1_ERROR_FILE) -cne $report) { throw 'Auto-update wrapper overwrote the detailed launcher error' }
    Remove-Item -LiteralPath $env:CODEX_V1_ERROR_FILE
    $ErrorActionPreference = 'Continue'
    & $powershell -NoProfile -File $autoPath 2>$null
    $autoExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $report = [IO.File]::ReadAllText($env:CODEX_V1_ERROR_FILE)
    if ($autoExit -eq 0 -or $report -notmatch 'Could not download or run' -or $report -notmatch 'Check your internet connection' -or $report -notmatch 'restoration was not checked') { throw 'Missing npm-failure guidance' }
    Write-Output 'Launch error messages and generated shortcut failure path passed.'
} finally {
    $env:CODEX_HOME = $previousConfigHome
    $env:CODEX_V1_ERROR_FILE = $previousErrorFile
    $resolved = [IO.Path]::GetFullPath($directory)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'codex-launch-error-test-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
