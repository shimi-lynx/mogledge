$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm run tauri -- build --bundles nsis
exit $LASTEXITCODE
