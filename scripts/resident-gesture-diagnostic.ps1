param([ValidateRange(1,120)][int]$Seconds=120)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$artifact=[IO.Path]::GetFullPath($PSScriptRoot)
$exe=Join-Path $artifact 'mogledge.exe'
$manifest=Get-Content -LiteralPath (Join-Path $artifact 'manifest.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $exe).Hash -cne $manifest.sha256){throw 'Trial binary hash mismatch'}
$targetProduct=(Get-Item -LiteralPath $exe).VersionInfo.ProductName
foreach($running in @(Get-CimInstance Win32_Process -Filter "Name='mogledge.exe'")){
 if(-not $running.ExecutablePath){throw 'Application identity unavailable; diagnostic not started'}
 $samePath=[IO.Path]::GetFullPath($running.ExecutablePath) -eq $exe
 $sameProduct=$targetProduct -match 'Resident Gesture' -and (Get-Item -LiteralPath $running.ExecutablePath).VersionInfo.ProductName -eq $targetProduct
 if($samePath -or $sameProduct -or (Get-FileHash -LiteralPath $running.ExecutablePath).Hash -ceq $manifest.sha256){throw 'Close this trial app using its tray Quit before starting a diagnostic. Other apps can remain open.'}
}
Import-Module (Join-Path $artifact 'qa-process-guard.psm1') -Force
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ResidentCaptureWindow {
 public delegate bool EnumWindow(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindow callback,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder name,int length);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode);
 public static IntPtr OwnedWindow(uint pid){
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,l)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid){var c=new StringBuilder(256);GetClassName(h,c,256);if(c.ToString()=="Tauri Window"){found=h;return false;}}return true;},IntPtr.Zero);
  return found;
 }
}
'@
$capture=Join-Path $artifact ('gesture-capture-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $capture | Out-Null
$stdout=Join-Path $capture 'temporary.stdout.log'
$stderr=Join-Path $capture 'temporary.stderr.log'
$guard=New-QaProcessGuard -EvidencePath (Join-Path $capture 'process-evidence.json') -SourceCommit $manifest.sourceCommit
$oldGesture=$env:MOGLEDGE_RESIDENT_GESTURE_DIAGNOSTICS
$oldRegistration=$env:MOGLEDGE_RESIDENT_DIAGNOSTICS
$env:MOGLEDGE_RESIDENT_GESTURE_DIAGNOSTICS='1'
$env:MOGLEDGE_RESIDENT_DIAGNOSTICS=$null
$started=[DateTime]::UtcNow
$failure=$null
Write-Host "DIAGNOSTIC START: maximum $Seconds seconds / 128 target records."
Write-Host 'Turn Resident mode ON, release all keys, then press/release left Shift, left Ctrl, left Shift while another app is foreground. Each press must be under 400ms; finish within 1.5 seconds.'
Write-Host 'No ordinary text or other app contents are recorded. This owned trial will stop automatically; other apps remain open.'
try {
 $app=Start-QaGuardedProcess -Guard $guard -FilePath $exe -WorkingDirectory $artifact -StandardOutput $stdout -StandardError $stderr
 $deadline=$started.AddSeconds($Seconds)
 $shown=$false
 do {
  if(-not $shown){$main=[ResidentCaptureWindow]::OwnedWindow([uint32]$app.Id);if($main -ne [IntPtr]::Zero){$null=[ResidentCaptureWindow]::ShowWindow($main,9);$shown=$true}}
  $null=Update-QaProcessGuard $guard
  if($app.HasExited){break}
  Start-Sleep -Milliseconds 500
 }while([DateTime]::UtcNow -lt $deadline)
}catch{$failure=$_.Exception.GetType().Name}
finally {
 $env:MOGLEDGE_RESIDENT_GESTURE_DIAGNOSTICS=$oldGesture
 $env:MOGLEDGE_RESIDENT_DIAGNOSTICS=$oldRegistration
 $summary=$null
 try {
 $cleanup=Complete-QaProcessGuard $guard
 $records=@()
 if(Test-Path -LiteralPath $stderr){
  foreach($line in Get-Content -LiteralPath $stderr -Encoding UTF8){
   if($line.StartsWith('resident-gesture-diagnostic ')){$records+=($line.Substring(28)|ConvertFrom-Json)}
  }
 }
 $counts=@{}
 $maxStep=0;$completed=0;$anonymous=$false;$blocking=$false;$maxHeld=0;$maximumTap=0;$downTimes=@{};$repeated=0;$rejected=0;$unmapped=0;$foregroundChecks=@()
 foreach($record in $records){
  $event=[string]$record.event
  if(-not $counts.ContainsKey($event)){$counts[$event]=0};$counts[$event]++
  if($event -eq 'modifier'){
   $d=$record.details
   $maxStep=[Math]::Max($maxStep,[int]$d.stepAfter)
   if($d.complete){$completed++}
   $anonymous=$anonymous -or [bool]$d.anonymousKeyHeld
   $blocking=$blocking -or [bool]$d.blockingModifierHeld
   $bits=([Convert]::ToString([int]$d.heldModifiers,2).ToCharArray()|Where-Object {$_ -eq '1'}).Count
   $maxHeld=[Math]::Max($maxHeld,$bits)
   $modifier=[string]$d.modifier
   if($d.down){if($downTimes.ContainsKey($modifier)){$repeated++}else{$downTimes[$modifier]=[double]$d.elapsedMs}}
   elseif($downTimes.ContainsKey($modifier)){$maximumTap=[Math]::Max($maximumTap,[double]$d.elapsedMs-$downTimes[$modifier]);$downTimes.Remove($modifier)}
  }
  if($event -eq 'modifier-rejected'){$rejected++}
  if($event -eq 'modifier-unmapped'){$unmapped++}
  if($event -eq 'restore-foreground-check'){$foregroundChecks+=[bool]$record.foregroundIsApp}
 }
 $summary=[ordered]@{sourceCommit=$manifest.sourceCommit;captureStartedUtc=$started.ToString('o');captureEndedUtc=[DateTime]::UtcNow.ToString('o');maximumSeconds=$Seconds;maximumRecords=128;recordsObserved=$records.Count;withinRecordLimit=($records.Count -le 128);stageCounts=$counts;maximumSequenceStep=$maxStep;sequenceCompletions=$completed;anonymousKeyHoldObserved=$anonymous;blockingModifierHoldObserved=$blocking;maximumHeldModifierCount=$maxHeld;maximumModifierTapMs=$maximumTap;repeatedModifierDowns=$repeated;rejectedModifierPackets=$rejected;unmappedModifierPackets=$unmapped;foregroundAfterQueuedFocus=$foregroundChecks;operationFailure=$failure;existingAppsPreserved=$cleanup.ExistingAppsPreserved;immediateProcessGuardPassed=$cleanup.Passed;remainingUncertainProcessCount=@($cleanup.RemainingUnstopped).Count;rawDiagnosticDeleted=$false}
 } catch {
  $summary=[ordered]@{sourceCommit=$manifest.sourceCommit;operationFailure='DiagnosticSummaryFailure';rawDiagnosticDeleted=$false}
 } finally {
 # A partial last JSON line must not leave raw input diagnostics on disk.
 foreach($temporary in @($stdout,$stderr)){
  if(-not [IO.Path]::GetFullPath($temporary).StartsWith([IO.Path]::GetFullPath($capture)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path'}
  if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary}
 }
 $records=$null;$downTimes=$null
 }
 $summary.rawDiagnosticDeleted=(-not (Test-Path -LiteralPath $stdout) -and -not (Test-Path -LiteralPath $stderr))
 [IO.File]::WriteAllText((Join-Path $capture 'summary.json'),($summary|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 Write-Host 'DIAGNOSTIC END: opt-in environment restored; raw diagnostic files deleted.'
 $summary|ConvertTo-Json -Depth 6
 Write-Host ('Summary: '+(Join-Path (Split-Path $capture -Leaf) 'summary.json'))
}
