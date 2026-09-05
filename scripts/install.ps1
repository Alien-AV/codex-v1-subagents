param(
    [string] $PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string] $NodeExe,
    [switch] $AutoUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) {
    throw 'The OpenAI.Codex Windows package is not installed.'
}

$pathNode = Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
$nodeCandidates = @(
    $NodeExe,
    $pathNode,
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
) | Where-Object { $_ }
$resolvedNode = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $resolvedNode) {
    throw 'Node.js 18 or newer is required. Install Node.js, then run this installer again.'
}

$installRoot = Join-Path $env:LOCALAPPDATA 'CodexV1Subagents'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PackageRoot 'runtime-patch.cjs') -Destination $installRoot -Force
Copy-Item -LiteralPath (Join-Path $PackageRoot 'launch.ps1') -Destination $installRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $installRoot -Force

$launchScript = Join-Path $installRoot 'launch.ps1'
$logFile = Join-Path $installRoot 'runtime-patch.log'
$launchMode = 'locally installed files'
if ($AutoUpdate) {
    $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
    if (-not $npxCommand) {
        throw 'Auto-update mode requires npx.cmd on PATH. Install Node.js/npm or omit --auto-update.'
    }

    $autoLauncher = Join-Path $installRoot 'launch-latest.ps1'
    $escapedNpx = $npxCommand.Replace("'", "''")
    $escapedLog = $logFile.Replace("'", "''")
    $autoLauncherSource = @"
`$ErrorActionPreference = 'Stop'
try {
    & '$escapedNpx' --yes 'codex-v1-subagents@latest' run --log-file '$escapedLog'
    if (`$LASTEXITCODE -ne 0) {
        throw "npx launcher exited with code `$LASTEXITCODE"
    }
} catch {
    Add-Content -LiteralPath '$escapedLog' -Value "`$(Get-Date -Format o) AUTO-UPDATE FAILED: `$_"
    throw
}
"@
    Set-Content -LiteralPath $autoLauncher -Value $autoLauncherSource -Encoding utf8
    $launchScript = $autoLauncher
    $launchMode = 'npm @latest on every launch'
}

$powershellExe = (Get-Process -Id $PID).Path
$hiddenLauncher = Join-Path $installRoot 'launch-hidden.vbs'
$command = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f $powershellExe, $launchScript
$vbsCommand = $command.Replace('"', '""')
$vbsLog = $logFile.Replace('"', '""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run("$vbsCommand", 0, True)
If exitCode <> 0 Then
  shell.Popup "Codex v1 Subagents failed to start." & vbCrLf & "See: $vbsLog", 0, "Codex v1 Subagents", 16
End If
"@
Set-Content -LiteralPath $hiddenLauncher -Value $vbs -Encoding ascii

$codexExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$shortcutName = 'Codex - v1 Subagents.lnk'
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $shortcutName),
    (Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName)
)
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = '"{0}"' -f $hiddenLauncher
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.IconLocation = "$codexExe,0"
    $shortcut.Description = 'Launch Codex with interactive legacy subagent task tabs'
    $shortcut.Save()
}

Write-Host 'Installed Codex - v1 Subagents.'
Write-Host "Desktop shortcut: $($shortcutPaths[0])"
Write-Host "Start Menu shortcut: $($shortcutPaths[1])"
Write-Host "Update mode: $launchMode"
Write-Host 'The normal Codex shortcut remains unchanged.'
