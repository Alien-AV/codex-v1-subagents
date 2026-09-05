$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$shortcutName = 'Codex - v1 Subagents.lnk'
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $shortcutName),
    (Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName)
)
foreach ($shortcutPath in $shortcutPaths) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
}

$installRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexV1Subagents'))
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
if (-not $installRoot.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing unsafe uninstall path: $installRoot"
}
if ((Split-Path -Leaf $installRoot) -ne 'CodexV1Subagents') {
    throw "Refusing unexpected uninstall path: $installRoot"
}
if (Test-Path -LiteralPath $installRoot) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
}

Write-Host 'Uninstalled Codex - v1 Subagents. The official Codex installation was not changed.'
