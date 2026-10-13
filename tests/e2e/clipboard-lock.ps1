param([Parameter(Mandatory=$true)][string]$FixtureDirectory)
$ErrorActionPreference='Stop'
$fixture=[IO.Path]::GetFullPath($FixtureDirectory)
$allowed=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.tools/clipboard-locks'))+[IO.Path]::DirectorySeparatorChar
if(-not $fixture.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or -not(Test-Path -LiteralPath (Join-Path $fixture '.clipboard-qa-marker'))){throw 'Owned clipboard fixture required'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ClipboardQaLock {
 [DllImport("user32.dll",SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);
 [DllImport("user32.dll")] public static extern bool CloseClipboard();
}
'@
if(-not [ClipboardQaLock]::OpenClipboard([IntPtr]::Zero)){throw 'Cannot acquire clipboard test lock'}
try {
 [Console]::WriteLine('LOCKED')
 $until=[DateTime]::UtcNow.AddSeconds(15)
 while(-not(Test-Path -LiteralPath (Join-Path $fixture '.clipboard-qa-release')) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 50}
} finally { [ClipboardQaLock]::CloseClipboard() | Out-Null }
