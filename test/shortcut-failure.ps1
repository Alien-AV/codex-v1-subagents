$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($env:CODEX_V1_ERROR_FILE, "Windows could not access config.toml after 7 automatic attempts.`r`nYour config was restored.`r`nWait a moment, then launch again. Unicode: $([char]0x2713)", [Text.Encoding]::Unicode)
exit 1
