param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$FixtureRoot,
  [Parameter(Mandatory = $true)][string]$LegacyInstaller,
  [Parameter(Mandatory = $true)][string]$ExpectedSource,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$stage = 'hosted-source-guard'
trap {
  $kind = $_.Exception.GetType().Name
  $identifier = if ($_.FullyQualifiedErrorId -cmatch '^[A-Za-z0-9_.:,]+$') { $_.FullyQualifiedErrorId } else { 'unclassified' }
  Write-Output ('MOGLEDGE_PROBE_ERROR=' + (@{ stage = $stage; kind = $kind; errorId = $identifier } | ConvertTo-Json -Compress))
  exit 1
}
$binarySource = if ($env:PROBE_EXISTING_SOURCE_SHA -ceq '69c207b383c4289fa9045af647dcef3020cd37cb') { $env:PROBE_EXISTING_SOURCE_SHA } else { $env:GITHUB_SHA }
# Refuse before reading a profile or registry. This is not a local test helper.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:CI -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:RUNNER_ARCH -cne 'X64' -or $env:GITHUB_REPOSITORY -cne 'shimi-lynx/mogledge' -or
    -not $env:RUNNER_TEMP -or -not $env:RUNNER_NAME -or
    $env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$' -or
    $ExpectedSource -cnotmatch '^[a-f0-9]{40}$' -or $ExpectedSource -cne $binarySource -or
    $env:GITHUB_SHA -cne $env:EXPECTED_SOURCE_SHA -or $ExpectedVersion -cne $env:EXPECTED_VERSION -or
    $ExpectedVersion -cnotmatch '^0\.\d+\.\d+$' -or $ExpectedVersion -ceq '0.9.1') {
  throw 'Disposable matching approved GitHub-hosted Windows runner required'
}
$stage = 'fixture-guard'
$temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
$expectedFixture = Join-Path $temporary "mogledge-native-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)-windows-x64"
if ($fixture -cne $expectedFixture -or -not (Test-Path -LiteralPath $fixture -PathType Container) -or
    ((Get-Item -LiteralPath $fixture).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'An exclusive ordinary runner temporary fixture is required'
}
$stage = 'candidate-output-guard'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
    [IO.Path]::GetFullPath($OutputDirectory),
    [IO.Path]::GetFullPath((Join-Path $repo '.tools/distribution/output')))) {
  throw 'Only the current candidate output is accepted'
}
$stage = 'candidate-manifest-guard'
$manifest = Get-Content -LiteralPath (Join-Path $OutputDirectory 'manifest.json') -Raw | ConvertFrom-Json
$config = Get-Content -LiteralPath (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
if ($manifest.sourceSha -cne $ExpectedSource -or $manifest.version -cne $ExpectedVersion -or
    $manifest.platform -cne 'windows-x64' -or $manifest.identifier -cne 'com.shimilynx.mogledge' -or
    $manifest.updater -ne $true -or $config.identifier -cne $manifest.identifier -or
    $config.version -cne $ExpectedVersion -or $config.mainBinaryName -cne 'mogledge' -or
    $manifest.updateArchive -cne [IO.Path]::GetFileName($manifest.updateArchive) -or
    $manifest.updateArchive -notlike '*-setup.exe' -or
    $manifest.executableSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $manifest.updateArchiveSha256 -cnotmatch '^[a-f0-9]{64}$') {
  throw 'Candidate manifest/configuration mismatch'
}
$stage = 'installer-hash-guard'
$installer = Join-Path $OutputDirectory $manifest.updateArchive
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.updateArchiveSha256 -or
    [IO.Path]::GetFullPath($LegacyInstaller) -cne (Join-Path $fixture 'Mogledge_0.9.1_windows-x64_unsigned_updater_b07f0bab242a-setup.exe') -or
    (Get-FileHash -LiteralPath $LegacyInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -cne '64e5cce0274d16655ab6f1f263b84739b35fed4ca1e655b006ab78d93c8815ba') {
  throw 'Candidate or pinned legacy installer hash mismatch'
}
$stage = 'environment-profile-paths'
$oldId = 'com.shimilynx.myknowledge'
$newId = 'com.shimilynx.mogledge'
$uninstallBase = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$publisher = $config.identifier.Split('.')[1]
$productBase = "Software\$publisher"
if ($env:APPDATA -ine [Environment]::GetFolderPath('ApplicationData') -or
    $env:LOCALAPPDATA -ine [Environment]::GetFolderPath('LocalApplicationData')) {
  throw 'Redirected environment profile roots are not accepted'
}
foreach ($directory in @($env:USERPROFILE, (Join-Path $env:USERPROFILE 'AppData'), $env:APPDATA, $env:LOCALAPPDATA)) {
  if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Profile parent must not be an alias'
  }
}
$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$links = @((Join-Path $programs 'Mogledge.lnk'), (Join-Path $programs 'My Knowledge.lnk'),
  (Join-Path $desktop 'Mogledge.lnk'), (Join-Path $desktop 'My Knowledge.lnk'))
$profiles = @()
foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
  foreach ($id in @('com.shimilynx.aiwiki', $oldId, $newId)) { $profiles += Join-Path $base $id }
}
$checks = [Collections.Generic.List[string]]::new()
$stage = 'preflight'
$ownedProcess = $null
$ownedStarted = $null
$ownedExecutable = $null
# The pinned NSIS SetContext macro selects Registry64 for x64/currentUser.
# Explicit views keep verification independent of the PowerShell host bitness.
function Read-RegistryValue([string]$Subkey, [string]$Name) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $base.OpenSubKey($Subkey)
    if (-not $key) { return $null }
    try { return $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Write-OwnedRun([string]$Name, [string]$Value) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $base.CreateSubKey($runKey)
    try { $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Assert-NoRegistry([string]$Identity) {
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      try {
        foreach ($subkey in @("$uninstallBase\$Identity", "$productBase\$Identity")) {
          $key = $base.OpenSubKey($subkey)
          if ($key) { $key.Dispose(); throw 'Preexisting formal product registration; probe refused' }
        }
      } finally { $base.Dispose() }
    }
  }
}
function Assert-Executable([string]$File) {
  $item = Get-Item -LiteralPath $File
  if ($item.VersionInfo.ProductName -cne 'Mogledge' -or
      $item.VersionInfo.ProductVersion -notmatch ('^' + [regex]::Escape($ExpectedVersion) + '(\.0)?$') -or
      (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.executableSha256) {
    throw 'Installed candidate executable mismatch'
  }
}
function Invoke-OwnedInstaller([string]$File, [string[]]$Arguments, [bool]$ExpectSuccess = $true) {
  $identity = Get-Item -LiteralPath $File
  $process = Start-Process -FilePath $identity.FullName -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  $started = $process.StartTime.ToUniversalTime()
  try {
    if (-not $process.WaitForExit(120000)) { throw 'Owned installer exceeded its bounded timeout' }
    if (($ExpectSuccess -and $process.ExitCode -ne 0) -or (-not $ExpectSuccess -and $process.ExitCode -eq 0)) {
      throw 'Unexpected owned installer result'
    }
  } finally {
    $current = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
    if ($current -and $current.Path -ceq $identity.FullName -and $current.StartTime.ToUniversalTime() -eq $started) {
      Stop-Process -Id $current.Id
    }
  }
}
function Assert-Shortcut([string]$File, [string]$Target) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw 'Expected owned shortcut is absent' }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($File)
  $shell = New-Object -ComObject Shell.Application
  $item = $shell.Namespace((Split-Path $File -Parent)).ParseName((Split-Path $File -Leaf))
  if ($shortcut.TargetPath -ine $Target -or $shortcut.Arguments -cne '' -or
      $item.ExtendedProperty('System.AppUserModel.ID') -cne $newId) {
    throw 'Shortcut target, arguments or AppUserModelID mismatch'
  }
}
function Assert-CurrentInstall([string]$Directory) {
  $executable = Join-Path $Directory 'mogledge.exe'
  Assert-Executable $executable
  if ((Read-RegistryValue "$uninstallBase\Mogledge" 'MainBinaryName') -cne 'mogledge.exe' -or
      (Read-RegistryValue "$uninstallBase\Mogledge" 'DisplayVersion') -cne $ExpectedVersion -or
      (Read-RegistryValue "$uninstallBase\Mogledge" 'Publisher') -cne $publisher -or
      (Read-RegistryValue "$uninstallBase\Mogledge" 'InstallLocation') -cne ('"' + $Directory + '"') -or
      (Read-RegistryValue "$uninstallBase\Mogledge" 'UninstallString') -cne ('"' + (Join-Path $Directory 'uninstall.exe') + '"') -or
      (Read-RegistryValue "$productBase\Mogledge" '') -cne $Directory) {
    throw 'Current product registration mismatch'
  }
  Assert-Shortcut (Join-Path $programs 'Mogledge.lnk') $executable
}
function Get-SentinelSnapshot([string[]]$Roots) {
  $records = foreach ($root in $Roots) {
    foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName) {
      if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected fixture alias' }
      [ordered]@{ root = [Array]::IndexOf($Roots, $root); name = [IO.Path]::GetRelativePath($root, $file.FullName);
        hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
    }
  }
  return ConvertTo-Json -InputObject @($records) -Compress -Depth 4
}
function Get-LegacyRegistrationSnapshot {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $records = foreach ($subkey in @("$productBase\My Knowledge", "$uninstallBase\My Knowledge")) {
      $key = $base.OpenSubKey($subkey)
      if (-not $key) { throw 'Expected owned predecessor registration is absent' }
      try {
        foreach ($name in $key.GetValueNames() | Sort-Object) {
          [ordered]@{ key = $subkey; name = $name; kind = [string]$key.GetValueKind($name);
            value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        }
      } finally { $key.Dispose() }
    }
  } finally { $base.Dispose() }
  return ConvertTo-Json -InputObject @($records) -Compress -Depth 5
}
try {
  foreach ($identity in @('My Knowledge', 'Mogledge')) {
    Assert-NoRegistry $identity
    if ($null -ne (Read-RegistryValue $runKey $identity)) { throw 'Preexisting formal startup registration; probe refused' }
  }
  foreach ($file in @($profiles) + @($links) + @(
    (Join-Path $env:LOCALAPPDATA 'My Knowledge'), (Join-Path $env:LOCALAPPDATA 'Mogledge'),
    (Join-Path $env:LOCALAPPDATA 'Programs/My Knowledge'), (Join-Path $env:LOCALAPPDATA 'Programs/Mogledge'),
    (Join-Path $env:ProgramFiles 'My Knowledge'), (Join-Path $env:ProgramFiles 'Mogledge'))) {
    if (Test-Path -LiteralPath $file) { throw 'Preexisting formal app, profile or shortcut; probe refused' }
  }
  if (Get-Process -Name 'mogledge', 'my-knowledge' -ErrorAction SilentlyContinue) { throw 'Preexisting formal app process; probe refused' }
  $checks.Add('empty-runner-preflight')
  $stage = 'fresh-install'
  $fresh = Join-Path $fixture 'fresh-install'
  Invoke-OwnedInstaller $installer @('/S', "/D=$fresh")
  Assert-CurrentInstall $fresh
  $checks.Add('fresh-nsis-install-executable-registry-shortcut-appid')
  $stage = 'owned-fresh-uninstall'
  Invoke-OwnedInstaller (Join-Path $fresh 'uninstall.exe') @('/S', "_?=$fresh")
  Assert-NoRegistry 'Mogledge'
  if (Test-Path -LiteralPath (Join-Path $fresh 'mogledge.exe')) { throw 'Owned fresh uninstall left its executable' }
  $checks.Add('owned-fresh-uninstall')
  $stage = 'pinned-old-install'
  $installed = Join-Path $fixture 'fixed-install'
  Invoke-OwnedInstaller $LegacyInstaller @('/S', "/D=$installed")
  $oldExecutable = Join-Path $installed 'my-knowledge.exe'
  if ((Read-RegistryValue "$productBase\My Knowledge" '') -cne $installed -or
      (Read-RegistryValue "$uninstallBase\My Knowledge" 'MainBinaryName') -cne 'my-knowledge.exe' -or
      (Read-RegistryValue "$uninstallBase\My Knowledge" 'Publisher') -cne $publisher -or
      (Read-RegistryValue "$uninstallBase\My Knowledge" 'UninstallString') -cne ('"' + (Join-Path $installed 'uninstall.exe') + '"') -or
      (Get-Item -LiteralPath $oldExecutable).VersionInfo.ProductVersion -notmatch '^0\.9\.1(\.0)?$') {
    throw 'Pinned legacy installation did not match its exact predecessor identity'
  }
  $oldHash = (Get-FileHash -LiteralPath $oldExecutable -Algorithm SHA256).Hash
  $oldProfiles = @((Join-Path $env:APPDATA $oldId), (Join-Path $env:LOCALAPPDATA $oldId))
  foreach ($profile in $oldProfiles) {
    New-Item -ItemType Directory -Path $profile | Out-Null
    [IO.File]::WriteAllText((Join-Path $profile 'native-probe-sentinel.json'), '{"synthetic":true,"preserve":"0.9.1"}')
  }
  $sentinels = Get-SentinelSnapshot $oldProfiles
  $legacyLink = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'My Knowledge.lnk'))
  $legacyLink.TargetPath = $oldExecutable
  $legacyLink.Save()
  $foreignTarget = Join-Path $fixture 'foreign-shortcut-target.txt'
  [IO.File]::WriteAllText($foreignTarget, 'Synthetic shortcut target; never execute')
  $foreignLinkPath = Join-Path $desktop 'Mogledge.lnk'
  if (Test-Path -LiteralPath $foreignLinkPath) {
    $existingLink = (New-Object -ComObject WScript.Shell).CreateShortcut($foreignLinkPath)
    if ($existingLink.TargetPath -ine $oldExecutable) { throw 'Unexpected desktop shortcut appeared in the owned fixture' }
  }
  $foreignLink = (New-Object -ComObject WScript.Shell).CreateShortcut($foreignLinkPath)
  $foreignLink.TargetPath = $foreignTarget
  $foreignLink.Arguments = ''
  $foreignLink.Description = 'Synthetic foreign shortcut preservation fixture'
  $foreignLink.Save()
  $foreignLinkHash = (Get-FileHash -LiteralPath $foreignLinkPath -Algorithm SHA256).Hash
  $checks.Add('pinned-091-owned-install-and-synthetic-old-profile')
  $stage = 'unsupported-startup-command-stop'
  $unsupportedRun = '"' + $oldExecutable + '" --unsupported-native-probe'
  Write-OwnedRun 'My Knowledge' $unsupportedRun
  $registrationBefore = Get-LegacyRegistrationSnapshot
  $linkHashes = @{}
  foreach ($link in $links) {
    if (Test-Path -LiteralPath $link) { $linkHashes[$link] = (Get-FileHash -LiteralPath $link -Algorithm SHA256).Hash }
  }
  Invoke-OwnedInstaller $installer @('/S', '/UPDATE', "/D=$installed") $false
  if ((Read-RegistryValue $runKey 'My Knowledge') -cne $unsupportedRun -or
      (Get-FileHash -LiteralPath $oldExecutable -Algorithm SHA256).Hash -cne $oldHash -or
      (Get-LegacyRegistrationSnapshot) -cne $registrationBefore -or
      (Read-RegistryValue "$uninstallBase\My Knowledge" 'MainBinaryName') -cne 'my-knowledge.exe' -or
      (Test-Path -LiteralPath (Join-Path $installed 'mogledge.exe'))) {
    throw 'Unsupported startup command did not preserve the predecessor'
  }
  Assert-NoRegistry 'Mogledge'
  foreach ($link in $linkHashes.Keys) {
    if (-not (Test-Path -LiteralPath $link) -or (Get-FileHash -LiteralPath $link -Algorithm SHA256).Hash -cne $linkHashes[$link]) {
      throw 'Unsupported startup command changed an owned shortcut'
    }
  }
  $checks.Add('unsupported-legacy-startup-command-stops-before-replacement')
  $stage = 'same-location-update'
  Write-OwnedRun 'My Knowledge' ('"' + $oldExecutable + '"')
  Invoke-OwnedInstaller $installer @('/S', '/UPDATE', "/D=$installed")
  Assert-CurrentInstall $installed
  Assert-NoRegistry 'My Knowledge'
  $ownedExecutable = Join-Path $installed 'mogledge.exe'
  if ((Test-Path -LiteralPath $oldExecutable) -or
      $null -ne (Read-RegistryValue $runKey 'My Knowledge') -or
      (Read-RegistryValue $runKey 'Mogledge') -cne ('"' + $ownedExecutable + '"')) {
    throw 'Legacy executable, startup or shortcut registration was not transitioned'
  }
  # A new-label link owned by another target must retain its exact bytes. The
  # verified old-label link remains as the functional, updated fallback.
  if ((Get-FileHash -LiteralPath $foreignLinkPath -Algorithm SHA256).Hash -cne $foreignLinkHash) {
    throw 'Identity update overwrote a foreign desktop shortcut'
  }
  Assert-Shortcut (Join-Path $desktop 'My Knowledge.lnk') $ownedExecutable
  $checks.Add('foreign-new-label-shortcut-preserved-old-label-fallback-retargeted')
  if ((Get-SentinelSnapshot $oldProfiles) -cne $sentinels) { throw 'Legacy synthetic profile changed during update' }
  foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
    if (Test-Path -LiteralPath (Join-Path $base $newId)) { throw 'Installer created the current profile before owned app launch' }
  }
  $checks.Add('091-same-location-update-registry-run-shortcuts-appid-old-data-preserved')
  $stage = 'ordinary-candidate-native-launch'
  $ownedProcess = Start-Process -FilePath $ownedExecutable -PassThru
  $ownedStarted = $ownedProcess.StartTime.ToUniversalTime()
  $ready = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $ownedProcess.Refresh()
    if ($ownedProcess.HasExited) { break }
    if ($ownedProcess.Path -cne $ownedExecutable -or $ownedProcess.StartTime.ToUniversalTime() -ne $ownedStarted) { throw 'Owned launch identity changed' }
    if ($ownedProcess.MainWindowHandle -ne 0 -and $ownedProcess.MainWindowTitle -ceq 'Mogledge' -and
        (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "$newId/document-state/state.sqlite"))) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Native main window and initialized current profile were not observed' }
  if ((Get-SentinelSnapshot $oldProfiles) -cne $sentinels) { throw 'Legacy synthetic profile changed during launch' }
  foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
    if (Test-Path -LiteralPath (Join-Path $base "$newId/native-probe-sentinel.json")) { throw 'Legacy sentinel copied into current profile' }
  }
  $checks.Add('ordinary-candidate-native-window-current-profile-no-legacy-copy')
  $stage = 'owned-normal-exit'
  if (-not $ownedProcess.CloseMainWindow() -or -not $ownedProcess.WaitForExit(15000)) { throw 'Owned candidate did not exit normally' }
  $checks.Add('owned-normal-window-close')
  @{ status = 'passed'; checks = $checks.ToArray() } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $fixture 'windows-result.json') -Encoding utf8
  Write-Output 'Disposable Windows Native probe passed'
} catch {
  @{ status = 'failed'; failedStage = $stage; checks = $checks.ToArray() } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $fixture 'windows-result.json') -Encoding utf8
  Write-Error "Disposable Windows Native probe failed at $stage; remaining checks are unverified"
  exit 1
} finally {
  if ($ownedProcess -and $ownedStarted -and $ownedExecutable) {
    $current = Get-Process -Id $ownedProcess.Id -ErrorAction SilentlyContinue
    if ($current -and $current.Path -ceq $ownedExecutable -and $current.StartTime.ToUniversalTime() -eq $ownedStarted) {
      Stop-Process -Id $current.Id
    }
  }
}
