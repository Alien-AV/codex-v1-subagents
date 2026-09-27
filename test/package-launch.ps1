param([switch] $CompileOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $root 'package-launch.cs')
if ([CodexV1Subagents.PackageLauncher]::QuoteArgument('C:\a b\') -cne '"C:\a b\\"') { throw 'Trailing slash quoting failed' }
if ([CodexV1Subagents.PackageLauncher]::QuoteArgument('a"b') -cne '"a\"b"') { throw 'Embedded quote escaping failed' }
if ($CompileOnly) { return }
$package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw 'This optional integration test requires Codex installed' }
$environment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $environment[$entry.Key] = $entry.Value }
$environment.CODEX_V1_LAUNCH_TEST = 'preserved "quoted" value'
$settings = @{ environment = $environment; cwd = $root } | ConvertTo-Json -Depth 4 -Compress
$nodePath = (Get-Command node).Source
$code = [CodexV1Subagents.PackageLauncher]::Run($nodePath, (Join-Path $PSScriptRoot 'package-launch-probe.cjs'),
    ($package.PackageFamilyName + '!App'), $package.PackageFullName, $settings)
if ($code -ne 0) { throw "Packaged launcher test failed: $code" }
