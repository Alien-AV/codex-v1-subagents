param(
    [string] $NodeExe,
    [string] $LogFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$logFile = if ($LogFile) { [IO.Path]::GetFullPath($LogFile) } else { Join-Path $PSScriptRoot 'runtime-patch.log' }
$launchAttempted = $false
. (Join-Path $PSScriptRoot 'launch-errors.ps1')
trap {
    $reason = $_.Exception.Message
    try { $message = Write-LaunchFailure -Reason $reason -LogFile $logFile -LaunchAttempted $launchAttempted }
    catch { $message = "$reason`r`nCould not write the failure report: $($_.Exception.Message)" }
    [Console]::Error.WriteLine($message)
    exit 1
}

$running = Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue
if ($running) {
    throw 'Codex is already running. Fully quit it from the tray, then run this launcher again.'
}

$package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) {
    throw 'The OpenAI.Codex Windows package is not installed.'
}
$codexExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$codexCli = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -ExpandProperty FullName -First 1
if (-not $codexCli) {
    throw 'The Codex CLI runtime was not found. Launch normal Codex once, let it finish loading, quit it, and retry.'
}
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
$environment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $environment[$entry.Key] = $entry.Value
}
$startup = @{
    executable = $codexExe
    logPath = [IO.Path]::GetFullPath($logFile)
    codexCli = $codexCli
    cwd = $PSScriptRoot
    environment = $environment
} | ConvertTo-Json -Depth 4 -Compress
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'package-launch.cs')
    # Clear stale diagnostics only after the already-running/preflight checks.
    [IO.File]::WriteAllText($logFile, '')
    $launchAttempted = $true
    $exitCode = [CodexV1Subagents.PackageLauncher]::Run(
        $resolvedNode, (Join-Path $PSScriptRoot 'package-runtime.cjs'),
        ($package.PackageFamilyName + '!App'), $package.PackageFullName, $startup)
} catch {
    $message = "Couldn't launch Codex with its Windows package identity: $($_.Exception.GetBaseException().Message)"
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) PATCH FAILED: $message"
    throw $message
}
if ($exitCode -ne 0) {
    $failureLine = Get-Content -LiteralPath $logFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ' PATCH FAILED: ' } |
        Select-Object -Last 1
    if ($failureLine) {
        $message = $failureLine -replace '^.* PATCH FAILED: ', ''
        throw $message
    }
    throw "Codex v1 Subagents could not start, but no detailed failure was recorded. See $logFile"
}
