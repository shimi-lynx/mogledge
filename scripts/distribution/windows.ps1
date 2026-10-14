param(
  [Parameter(Mandatory = $true)][ValidateSet('verify', 'archive', 'verify-installer', 'unpack-installer')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Expected,
  [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'unpack-installer') {
  if (Test-Path -LiteralPath $Output) { throw 'Installer inspection requires a new output directory' }
  $sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
  $sevenZip = if ($sevenZipCommand) { $sevenZipCommand.Source } else { Join-Path $env:ProgramFiles '7-Zip/7z.exe' }
  if (-not (Test-Path -LiteralPath $sevenZip)) { throw 'Existing 7-Zip is required for non-executing NSIS inspection' }
  & $sevenZip x '-y' ("-o" + $Output) $Source | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'NSIS archive inspection failed' }
  exit 0
}
if ($Action -eq 'archive') {
  [System.IO.Compression.ZipFile]::CreateFromDirectory($Source, $Output, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $extracted = Join-Path (Split-Path (Split-Path $Output -Parent) -Parent) 'extracted'
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Output, $extracted)
  exit 0
}
$item = Get-Item -LiteralPath $Source
if ($Action -eq 'verify-installer') {
  if ($item.Name -cne ("Mogledge_" + $Expected + "_x64-setup.exe") -or
      $item.VersionInfo.ProductName -cne 'Mogledge' -or
      $item.VersionInfo.ProductVersion -notmatch ('^' + [regex]::Escape($Expected) + '(\.0)?$') -or
      $item.VersionInfo.FileVersion -notmatch ('^' + [regex]::Escape($Expected) + '(\.0)?$') -or
      (Get-AuthenticodeSignature -LiteralPath $Source).Status -ne 'NotSigned') {
    throw 'Unexpected unsigned NSIS identity/version/name'
  }
  @{ productName = 'Mogledge'; version = $Expected; architecture = 'x64 payload'; signature = 'unsigned'; format = 'nsis' } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $Output -Encoding utf8
  exit 0
}
if ($item.VersionInfo.ProductName -cne 'Mogledge' -or $item.VersionInfo.FileDescription -cne 'Mogledge') {
  throw 'Unexpected PE product identity'
}
if ($item.VersionInfo.ProductVersion -notmatch ('^' + [regex]::Escape($Expected) + '(\.0)?$')) {
  throw 'Unexpected PE product version'
}
if ($item.VersionInfo.FileVersion -notmatch ('^' + [regex]::Escape($Expected) + '(\.0)?$')) { throw 'Unexpected PE file version' }
if ((Get-AuthenticodeSignature -LiteralPath $Source).Status -ne 'NotSigned') {
  throw 'Expected an unsigned Windows executable'
}
$bytes = [System.IO.File]::ReadAllBytes($item.FullName)
if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Invalid DOS header' }
$offset = [BitConverter]::ToInt32($bytes, 0x3c)
if ($offset -lt 64 -or $offset -gt $bytes.Length - 6) { throw 'Invalid PE offset' }
if ([BitConverter]::ToUInt32($bytes, $offset) -ne 0x00004550 -or [BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x8664) {
  throw 'Expected an x64 PE executable'
}
@{ productName = 'Mogledge'; version = $Expected; architecture = 'x64'; signature = 'unsigned' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Output -Encoding utf8
