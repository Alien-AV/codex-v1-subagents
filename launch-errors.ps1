function Get-LaunchFailureMessage {
    param(
        [string] $Reason,
        [string] $LogFile,
        [string] $ConfigPath,
        [bool] $LaunchAttempted,
        [string] $LogText = ''
    )
    $backup = $ConfigPath + '.codex-v1-subagents.backup'
    $marker = $ConfigPath + '.codex-v1-subagents.transaction.json'
    $pending = (Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $marker)
    if ($pending) {
        $status = 'Config restoration is NOT confirmed. Recovery files were preserved.'
        if (Test-Path -LiteralPath $backup) { $status += "`r`nBackup: $backup" }
        $next = 'Fully quit Codex and close any editor using config.toml, then launch again to retry recovery. If it fails again, keep the recovery files and share the log; do not overwrite your config with the backup.'
    } elseif ($LaunchAttempted -and $LogText -match '(Restored original Codex config:|Recovered interrupted Codex config transaction:)') {
        $status = 'Your config was restored; the temporary launch settings were removed.'
        $next = 'Wait a moment, then launch again. If it keeps failing, update the launcher and share the log.'
    } elseif (-not $LaunchAttempted) {
        $status = 'This launch did not change your Codex config.'
        $next = 'Follow the instruction above, then launch again. If it persists, share the log.'
    } else {
        $status = 'Config restoration could not be confirmed. No backup or recovery marker was found.'
        $next = "Check $ConfigPath and the log before retrying."
    }
    return "Codex v1 Subagents could not start.`r`n`r`n$Reason`r`n`r`n$status`r`n`r`n$next`r`n`r`nLog: $LogFile"
}

function Write-LaunchFailure {
    param([string] $Reason, [string] $LogFile, [bool] $LaunchAttempted)
    $configRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $logText = if ($LaunchAttempted -and (Test-Path -LiteralPath $LogFile)) {
        Get-Content -LiteralPath $LogFile -Raw -ErrorAction SilentlyContinue
    } else { '' }
    $message = Get-LaunchFailureMessage -Reason $Reason -LogFile $LogFile -ConfigPath (Join-Path $configRoot 'config.toml') -LaunchAttempted $LaunchAttempted -LogText $logText
    Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format o) LAUNCH FAILED: $Reason" -ErrorAction SilentlyContinue
    if ($env:CODEX_V1_ERROR_FILE) {
        [IO.File]::WriteAllText($env:CODEX_V1_ERROR_FILE, $message, [Text.Encoding]::Unicode)
    }
    return $message
}
