param([switch]$Release)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows Native.' }
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPreviousLocation = Get-Location
$taskPreviousPath = $env:PATH
$taskTranscriptStarted = $false
$taskResults = [Collections.Generic.List[object]]::new()
$taskFailure = $null
$taskSummaryPath = $null

function Invoke-ValidationCommand {
    param([string]$Program, [string[]]$Arguments)
    $taskCommand = $Program + ' ' + ($Arguments -join ' ')
    Write-Host ('Running: ' + $taskCommand)
    $taskStarted = Get-Date
    # npm.ps1 reparses invocation text and breaks dynamic argument splatting.
    $taskExecutable = if ($Program -eq 'npm') { 'npm.cmd' } else { $Program }
    & $taskExecutable @Arguments
    $taskExit = $LASTEXITCODE
    $taskResults.Add([ordered]@{
        command = $taskCommand
        exitCode = $taskExit
        durationSeconds = [Math]::Round(((Get-Date) - $taskStarted).TotalSeconds, 3)
    })
    if ($taskExit -ne 0) { throw ('Failed (' + $taskExit + '): ' + $taskCommand) }
}

try {
    Set-Location -LiteralPath $taskRoot
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    $taskSha = (& git -c "safe.directory=$taskRoot" rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine validation commit.' }
    $taskDirty = @(& git -c "safe.directory=$taskRoot" status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine working tree state.' }
    if ($taskDirty.Count -gt 0) { throw 'Commit or preserve pending changes before final PR validation.' }
    $taskLogDirectory = Join-Path $taskRoot ('.tools\validation\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $taskSha.Substring(0, 12))
    [IO.Directory]::CreateDirectory($taskLogDirectory) | Out-Null
    $taskSummaryPath = Join-Path $taskLogDirectory 'summary.json'
    Start-Transcript -LiteralPath (Join-Path $taskLogDirectory 'run.log') | Out-Null
    $taskTranscriptStarted = $true
    $taskOS = Get-CimInstance Win32_OperatingSystem
    $taskVersion = [ordered]@{
        node = (& node --version | Out-String).Trim()
        npm = (& npm --version | Out-String).Trim()
        rust = (& rustc --version | Out-String).Trim()
    }
    if ($env:MY_KNOWLEDGE_TEST_BINARY -or $env:MY_KNOWLEDGE_BENCH_ROOT) {
        throw 'Clear MY_KNOWLEDGE_TEST_BINARY / MY_KNOWLEDGE_BENCH_ROOT to validate the current application and fixtures.'
    }
    if (-not (Get-Command tauri-driver -ErrorAction SilentlyContinue)) {
        throw 'Install the Windows driver first: cargo install tauri-driver --locked'
    }
    Invoke-ValidationCommand 'npm' @('run', 'check')
    Invoke-ValidationCommand 'npm' @('test')
    Invoke-ValidationCommand 'cargo' @('fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check')
    Invoke-ValidationCommand 'cargo' @('test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets')
    Invoke-ValidationCommand 'cargo' @('clippy', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings')
    # Build after cargo tests: the Tauri CLI embeds the UI needed by Native E2E.
    Invoke-ValidationCommand 'npm' @('run', 'tauri', '--', 'build', '--debug', '--features', 'e2e', '--no-bundle')
    Invoke-ValidationCommand 'npm' @('run', 'test:e2e')
    if ($Release) {
        Invoke-ValidationCommand 'npm' @('run', 'tauri', '--', 'build', '--bundles', 'nsis')
        Invoke-ValidationCommand 'npm' @('run', 'test:production')
    }
    $taskFinalSha = (& git -c "safe.directory=$taskRoot" rev-parse HEAD).Trim()
    $taskFinalDirty = @(& git -c "safe.directory=$taskRoot" status --porcelain)
    if ($taskFinalSha -ne $taskSha -or $taskFinalDirty.Count -gt 0) {
        throw 'Commit or working tree changed during validation; results do not validate the final diff.'
    }
} catch {
    $taskFailure = $_.Exception.Message
    Write-Host ('Validation failed: ' + $taskFailure)
} finally {
    if ($taskSummaryPath) {
        $taskSummary = [ordered]@{
            testedCommit = $taskSha
            completedAt = (Get-Date).ToUniversalTime().ToString('o')
            os = if ($taskOS) { $taskOS.Caption + ' / ' + $taskOS.Version } else { 'Windows' }
            toolVersions = $taskVersion
            releaseRequested = [bool]$Release
            passed = ($null -eq $taskFailure)
            failure = $taskFailure
            checks = @($taskResults.ToArray())
            installer = if ($Release -and (Test-Path -LiteralPath 'src-tauri\target\release\bundle\nsis\Mogledge_0.8.0_x64-setup.exe')) {
                [ordered]@{
                    path = 'src-tauri/target/release/bundle/nsis/Mogledge_0.8.0_x64-setup.exe'
                    sha256 = (Get-FileHash -LiteralPath 'src-tauri\target\release\bundle\nsis\Mogledge_0.8.0_x64-setup.exe').Hash.ToLowerInvariant()
                    installedBinaryTest = 'Not run by this script; perform separately when installer behavior changes.'
                }
            } else { $null }
        }
        [IO.File]::WriteAllText($taskSummaryPath, ($taskSummary | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    }
    if ($taskTranscriptStarted) { Stop-Transcript | Out-Null }
    $env:PATH = $taskPreviousPath
    Set-Location -LiteralPath $taskPreviousLocation
}
if ($taskFailure) { throw $taskFailure }
Write-Host ('Validation passed. Evidence: ' + $taskSummaryPath)
