param(
    [string] $NodeExe,
    [string] $LogFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$running = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue
if ($running) {
    throw 'Codex is already running. Fully quit it from the tray, then run this launcher again.'
}

$package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) {
    throw 'The OpenAI.Codex Windows package is not installed.'
}
$codexExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$runtimePatch = Join-Path $PSScriptRoot 'runtime-patch.cjs'
$logFile = if ($LogFile) { $LogFile } else { Join-Path $PSScriptRoot 'runtime-patch.log' }
$pathNode = Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
$nodeCandidates = @(
    $NodeExe,
    $pathNode,
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
) | Where-Object { $_ }
$resolvedNode = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $resolvedNode) {
    throw 'A compatible Node.js runtime was not found.'
}

Write-Host 'Launching Codex with the v1 interactive-subagent runtime patch...'
Write-Host 'Keep this PowerShell window open while using Codex.'
Write-Host "Log: $logFile"
& $resolvedNode $runtimePatch $codexExe $logFile
if ($LASTEXITCODE -ne 0) {
    throw "The runtime patch failed. See $logFile"
}
