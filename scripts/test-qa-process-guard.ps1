param([string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Run on Windows; no application binaries are launched.' }
$repo = Split-Path -Parent $PSScriptRoot
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $repo ('.tools/validation/qa-process-guard-' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss')) }
[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
Import-Module (Join-Path $PSScriptRoot 'qa-process-guard.psm1') -Force
$cases = [Collections.Generic.List[object]]::new()

function Assert-Case {
    param([string]$Name, [bool]$Condition, [string]$Kind = 'mock')
    $cases.Add(@{ Name = $Name; Passed = $Condition; Kind = $Kind })
    if (-not $Condition) { throw ('Failed: ' + $Name) }
}

function Fixture-Identity {
    param([int]$Id, [string]$Time, [string]$Path = 'C:\qa-fixture\helper.exe', [int]$Parent = 1)
    [pscustomobject]@{ ProcessId = $Id; CreatedUtc = $Time; ExecutablePath = $Path; Name = 'helper.exe'; ParentProcessId = $Parent; SessionId = 1 }
}

$failure = $null
$protectedHelper = $null
$protectedHandle = $null
$nativeGuard = $null
try {
    $original = Fixture-Identity 100 '2026-10-06T10:00:00.000000Z'
    $reused = Fixture-Identity 100 '2026-10-06T10:01:00.000000Z'
    $decision = Get-QaStopDecision $original $original @() $true $original
    Assert-Case 'direct handle plus matching identity permits only the launched root' $decision.Allowed
    $decision = Get-QaStopDecision $original $original @() $false $original
    Assert-Case 'a matching PID and path without a launch handle cannot stop' (-not $decision.Allowed)
    $decision = Get-QaStopDecision $original $original @($original) $true $original
    Assert-Case 'before-run application is excluded even if a handle is claimed' (-not $decision.Allowed)
    $decision = Get-QaStopDecision $original $reused @() $true $original
    Assert-Case 'reused PID with a new creation time cannot stop' (-not $decision.Allowed)
    $changedPath = Fixture-Identity 100 $original.CreatedUtc 'C:\other\helper.exe'
    $decision = Get-QaStopDecision $original $changedPath @() $true $original
    Assert-Case 'changed executable identity cannot stop' (-not $decision.Allowed)
    $decision = Get-QaStopDecision $original $null @() $true $original
    Assert-Case 'unavailable current identity cannot stop' (-not $decision.Allowed)
    $decision = Get-QaStopDecision $original $original @() $true $reused
    Assert-Case 'mismatched retained-handle identity cannot stop' (-not $decision.Allowed)

    # Override only the read-only provider in module scope, then unload that scope.
    $guardModule = Get-Module qa-process-guard
    & $guardModule {
        param($original, $reused, $evidenceDirectory, $cases)
        $script:fixtureSnapshot = @()
        function Get-CimInstance { param($ClassName, $ErrorAction); return $script:fixtureSnapshot }
        function To-CimFixture($identity) {
            [pscustomobject]@{ ProcessId = $identity.ProcessId; CreationDate = [datetime]$identity.CreatedUtc; ExecutablePath = $identity.ExecutablePath; Name = $identity.Name; ParentProcessId = $identity.ParentProcessId; SessionId = $identity.SessionId }
        }
        function New-MockGuard($name) {
            $path = Join-Path $evidenceDirectory ($name + '.json')
            [IO.Directory]::CreateDirectory($path + '.snapshots') | Out-Null
            [pscustomobject]@{ SourceCommit = 'mock-fixture'; StartedUtc = [datetime]::UtcNow.ToString('o'); EvidencePath = $path; SnapshotDirectory = ($path + '.snapshots'); EvidenceSequence = 0; BeforeApps = @(); RootIdentity = $original; Handle = $null; Candidates = [Collections.Generic.List[object]]::new(); Observations = [Collections.Generic.List[object]]::new(); ObservationKeys = [Collections.Generic.HashSet[string]]::new(); StopActions = [Collections.Generic.List[object]]::new(); Result = $null }
        }
        $mockGuard = New-MockGuard 'mock-ancestry'
        $child = [pscustomobject]@{ ProcessId = 101; CreatedUtc = '2026-10-06T10:02:00.000000Z'; ExecutablePath = 'C:\qa-fixture\child.exe'; Name = 'child.exe'; ParentProcessId = 100; SessionId = 1 }
        $script:fixtureSnapshot = @((To-CimFixture $reused), (To-CimFixture $child))
        Update-QaProcessGuard $mockGuard | Out-Null
        $ok = $mockGuard.Candidates.Count -eq 0 -and $mockGuard.Observations[0].ExclusionReason -eq 'unrelated-reused-parent' -and $mockGuard.Observations[0].CurrentParentIdentity.CreatedUtc -ceq $reused.CreatedUtc
        $cases.Add(@{ Name = 'a reused parent PID never adopts its new child'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'Reused ancestry was accepted.' }
        $mockGuard.Observations.Clear()
        $script:fixtureSnapshot = @((To-CimFixture $original), (To-CimFixture $child))
        Update-QaProcessGuard $mockGuard | Out-Null
        $ok = $mockGuard.Candidates.Count -eq 1 -and $mockGuard.Observations[0].ExclusionReason -eq 'observed-descendant-without-direct-handle' -and $mockGuard.StopActions.Count -eq 0
        $cases.Add(@{ Name = 'verified ancestry is diagnostic only and never grants cleanup ownership'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'Descendant observation granted stop ownership.' }
        $result = Complete-QaProcessGuard $mockGuard
        $ok = -not $result.Passed -and $result.RemainingUnstopped.Count -eq 1 -and $mockGuard.StopActions.Count -eq 0
        $cases.Add(@{ Name = 'a surviving unowned descendant fails closed and is reported without stopping'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'Unowned remaining process was hidden or stopped.' }
        $unknownGuard = New-MockGuard 'mock-unknown'
        $child.ExecutablePath = $null
        $script:fixtureSnapshot = @((To-CimFixture $original), (To-CimFixture $child))
        Update-QaProcessGuard $unknownGuard | Out-Null
        $result = Complete-QaProcessGuard $unknownGuard
        $ok = -not $result.Passed -and $result.RemainingUnstopped.Count -gt 0 -and $unknownGuard.StopActions.Count -eq 0
        $cases.Add(@{ Name = 'a live descendant with unavailable image identity is reported and never stopped'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'Live unknown process was accepted.' }
        $transientGuard = New-MockGuard 'mock-transient'
        Update-QaProcessGuard $transientGuard | Out-Null
        $snapshot = Join-Path $transientGuard.SnapshotDirectory '000001.json'
        $mapping = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($snapshot, [IO.FileMode]::Open, [NullString]::Value, 0, [IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
        try { Update-QaProcessGuard $transientGuard | Out-Null } finally { $mapping.Dispose() }
        $cases.Add(@{ Name = 'a mapped previous evidence snapshot is never truncated or replaced'; Passed = $true; Kind = 'Windows file mapping' })
        $script:fixtureSnapshot = @()
        $result = Complete-QaProcessGuard $transientGuard
        $ok = $result.Passed -and $result.RemainingUnstopped.Count -eq 0 -and $transientGuard.StopActions.Count -eq 0
        $cases.Add(@{ Name = 'naturally exited unknown processes stay excluded without hiding a live residual'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'Exited diagnostic candidate affected cleanup.' }
        $unrelatedGuard = New-MockGuard 'mock-unrelated-new-parent'
        $child.ExecutablePath = 'C:\qa-fixture\child.exe'
        $script:fixtureSnapshot = @((To-CimFixture $reused), (To-CimFixture $child))
        $result = Complete-QaProcessGuard $unrelatedGuard
        $ok = $result.Passed -and $result.RemainingUnstopped.Count -eq 0 -and $unrelatedGuard.StopActions.Count -eq 0
        $cases.Add(@{ Name = 'live children proven to belong to a new parent generation remain excluded'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'An unrelated reused-parent child blocked the run.' }
        $olderGuard = New-MockGuard 'mock-pre-existing-child'
        $child.CreatedUtc = '2026-10-05T10:00:00.000000Z'
        $script:fixtureSnapshot = @((To-CimFixture $original), (To-CimFixture $child))
        $result = Complete-QaProcessGuard $olderGuard
        $ok = $result.Passed -and $olderGuard.Observations[0].Unrelated -and $olderGuard.StopActions.Count -eq 0
        $cases.Add(@{ Name = 'a surviving child older than every recorded parent is never a run residual'; Passed = $ok; Kind = 'mock' })
        if (-not $ok) { throw 'A pre-existing unrelated process was treated as owned.' }
    } $original $reused $EvidenceDirectory $cases
    Remove-Module qa-process-guard
    Import-Module (Join-Path $PSScriptRoot 'qa-process-guard.psm1') -Force

    $shell = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $shell)) { $shell = Join-Path $PSHOME 'powershell.exe' }
    $helperArguments = @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30')
    $protectedHelper = Start-Process -FilePath $shell -ArgumentList $helperArguments -WindowStyle Hidden -PassThru
    $protectedHandle = [MogledgeQa.RetainedProcess]::new($protectedHelper)
    $nativeGuard = New-QaProcessGuard -EvidencePath (Join-Path $EvidenceDirectory 'native-processes.json') -AdditionalProtectedProcessIds @($protectedHelper.Id)
    $root = Start-QaGuardedProcess -Guard $nativeGuard -FilePath $shell -ArgumentList $helperArguments -WorkingDirectory $repo -StandardOutput (Join-Path $EvidenceDirectory 'helper.stdout.log') -StandardError (Join-Path $EvidenceDirectory 'helper.stderr.log')
    Update-QaProcessGuard $nativeGuard | Out-Null
    $result = Complete-QaProcessGuard $nativeGuard
    Assert-Case 'real direct helper is stopped through its retained handle' ($root.WaitForExit(3000) -and $nativeGuard.StopActions.Count -eq 1 -and $nativeGuard.StopActions[0].Stopped) 'Windows helper'
    Assert-Case 'pre-existing disposable helper remains running after guard cleanup' (-not $protectedHandle.HasExited) 'Windows helper'
    Assert-Case 'existing application identities are preserved' $result.ExistingAppsPreserved 'Windows helper'
    Assert-Case 'normal direct-helper run has no unknown remaining process' $result.Passed 'Windows helper'
    $proof = Get-Content -LiteralPath (Join-Path $EvidenceDirectory 'native-processes.json') -Raw | ConvertFrom-Json
    Assert-Case 'local evidence records protected identities and attempted stop identity' ($proof.beforeApps.Count -ge 1 -and $proof.protectedExclusions.Count -ge 1 -and $proof.stopActions[0].Attempted -and $proof.stopActions[0].Identity.CreatedUtc -and $proof.stopActions[0].Identity.ExecutablePath) 'Windows helper'
} catch { $failure = $_.Exception.Message }
finally {
    # This is a second directly created disposable test helper, never a user app.
    if ($protectedHandle) { try { if (-not $protectedHandle.HasExited) { $protectedHandle.Stop() | Out-Null } } finally { $protectedHandle.Dispose() } }
    if ($nativeGuard -and -not $nativeGuard.Result) { Complete-QaProcessGuard $nativeGuard | Out-Null }
    $summary = [ordered]@{ SourceCommit = (& git -c "safe.directory=$repo" -C $repo rev-parse HEAD).Trim(); CompletedUtc = [datetime]::UtcNow.ToString('o'); Passed = ($null -eq $failure); Failure = $failure; Cases = @($cases.ToArray()); AppBinariesLaunched = $false; SecurityPolicyChanged = $false }
    [IO.File]::WriteAllText((Join-Path $EvidenceDirectory 'summary.json'), ($summary | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $summary | ConvertTo-Json -Depth 6
}
if (-not $summary.Passed) { exit 1 }
