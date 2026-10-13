# Windows QA only. Product code must not import this module.
Set-StrictMode -Version Latest

if (-not ('MyKnowledgeQa.RetainedProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MyKnowledgeQa {
    public sealed class RetainedProcess : IDisposable {
        private readonly SafeProcessHandle handle;
        public int ProcessId { get; private set; }
        public string CreatedUtc { get; private set; }
        public string ExecutablePath { get; private set; }

        // Duplicate the handle returned by our own launch. Never reopen a PID.
        public RetainedProcess(Process launched) {
            SafeProcessHandle duplicate;
            IntPtr current = GetCurrentProcess();
            if (!DuplicateHandle(current, launched.SafeHandle, current, out duplicate, 0, false, 2))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            handle = duplicate;
            try {
                ProcessId = checked((int)GetProcessId(handle));
                if (ProcessId == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                long created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                // CIM exposes microseconds; discard only the extra FILETIME digit.
                CreatedUtc = DateTime.FromFileTimeUtc(created).ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'");
                StringBuilder image = new StringBuilder(32768);
                int length = image.Capacity;
                if (!QueryFullProcessImageName(handle, 0, image, ref length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                ExecutablePath = image.ToString();
            } catch { handle.Dispose(); throw; }
        }
        public bool HasExited {
            get {
                uint result = WaitForSingleObject(handle, 0);
                if (result == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
                return result == 0;
            }
        }
        public bool Stop() {
            if (HasExited) return false;
            if (!TerminateProcess(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return WaitForSingleObject(handle, 3000) == 0;
        }
        public void Dispose() { handle.Dispose(); }
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, SafeProcessHandle source, IntPtr targetProcess, out SafeProcessHandle target, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder image, ref int length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeProcessHandle process, uint code);
    }
}
'@
}

function ConvertTo-QaProcessIdentity {
    param([Parameter(Mandatory)]$Process)
    [pscustomobject]@{
        ProcessId = [int]$Process.ProcessId
        CreatedUtc = if ($Process.CreationDate) { $Process.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'") } else { $null }
        ExecutablePath = $Process.ExecutablePath
        Name = $Process.Name
        ParentProcessId = [int]$Process.ParentProcessId
        SessionId = [int]$Process.SessionId
    }
}

function Test-QaSameIdentity {
    param($Expected, $Actual)
    return ($null -ne $Expected -and $null -ne $Actual -and
        $Expected.CreatedUtc -and $Expected.ExecutablePath -and
        $Expected.ProcessId -eq $Actual.ProcessId -and
        $Expected.CreatedUtc -ceq $Actual.CreatedUtc -and
        [string]::Equals($Expected.ExecutablePath, $Actual.ExecutablePath, [StringComparison]::OrdinalIgnoreCase))
}

function Get-QaStopDecision {
    param($Identity, $Current, [object[]]$BeforeApps, [bool]$HasDirectHandle, $HandleIdentity)
    $reason = if (@($BeforeApps | Where-Object ProcessId -eq $Identity.ProcessId).Count -gt 0) { 'protected-before-run' }
        elseif (-not $HasDirectHandle) { 'no-direct-launch-handle' }
        elseif (-not (Test-QaSameIdentity $Identity $HandleIdentity)) { 'handle-identity-unverified' }
        elseif (-not $Current) { 'current-identity-unavailable' }
        elseif (-not (Test-QaSameIdentity $Identity $Current)) { 'pid-reused-or-identity-changed' }
        else { 'verified-direct-launch-handle' }
    [pscustomobject]@{ Allowed = ($reason -eq 'verified-direct-launch-handle'); Reason = $reason }
}

function Write-QaProcessEvidence {
    param([Parameter(Mandatory)]$Guard, [switch]$Final)
    $Guard.EvidenceSequence++
    $evidence = [ordered]@{
        schemaVersion = 1
        snapshotSequence = $Guard.EvidenceSequence
        sourceCommit = $Guard.SourceCommit
        startedUtc = $Guard.StartedUtc
        updatedUtc = [datetime]::UtcNow.ToString('o')
        beforeApps = @($Guard.BeforeApps)
        protectedExclusions = @($Guard.BeforeApps | ForEach-Object { @{ Identity = $_; Reason = 'protected-before-run' } })
        directLaunch = $Guard.RootIdentity
        observations = @($Guard.Observations.ToArray())
        stopActions = @($Guard.StopActions.ToArray())
        result = $Guard.Result
    }
    # Immutable snapshots avoid truncating a file held by a Windows reader/scanner.
    # Paths are local diagnostic evidence. Do not publish these files verbatim.
    $json = $evidence | ConvertTo-Json -Depth 12
    $snapshot = Join-Path $Guard.SnapshotDirectory ($Guard.EvidenceSequence.ToString('D6') + '.json')
    $stream = [IO.File]::Open($snapshot, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    if ($Final) {
        $stream = [IO.File]::Open($Guard.EvidencePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
}

function New-QaProcessGuard {
    param([Parameter(Mandatory)][string]$EvidencePath, [int[]]$AdditionalProtectedProcessIds = @(), [string]$SourceCommit)
    if ($env:OS -ne 'Windows_NT') { throw 'This QA guard requires Windows.' }
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { ConvertTo-QaProcessIdentity $_ })
    $before = @($all | Where-Object { $_.Name -eq 'my-knowledge.exe' -or $_.ProcessId -in $AdditionalProtectedProcessIds })
    if (@($before | Where-Object { -not $_.CreatedUtc -or -not $_.ExecutablePath }).Count) { throw 'Protected application identity unavailable; do not launch.' }
    $directory = Split-Path -Parent ([IO.Path]::GetFullPath($EvidencePath))
    $snapshotDirectory = [IO.Path]::GetFullPath($EvidencePath) + '.snapshots'
    if ((Test-Path -LiteralPath $EvidencePath) -or (Test-Path -LiteralPath $snapshotDirectory)) { throw 'Evidence already exists; choose a new run path.' }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    [IO.Directory]::CreateDirectory($snapshotDirectory) | Out-Null
    $guard = [pscustomobject]@{
        SourceCommit = if ($SourceCommit) { $SourceCommit } else { (& git -c "safe.directory=$(Split-Path -Parent $PSScriptRoot)" -C (Split-Path -Parent $PSScriptRoot) rev-parse HEAD).Trim() }
        StartedUtc = [datetime]::UtcNow.ToString('o')
        EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
        SnapshotDirectory = $snapshotDirectory
        EvidenceSequence = 0
        BeforeApps = $before
        RootIdentity = $null
        Handle = $null
        RootProcess = $null
        Candidates = [Collections.Generic.List[object]]::new()
        Observations = [Collections.Generic.List[object]]::new()
        ObservationKeys = [Collections.Generic.HashSet[string]]::new()
        StopActions = [Collections.Generic.List[object]]::new()
        Result = $null
    }
    Write-QaProcessEvidence $guard
    return $guard
}

function Start-QaGuardedProcess {
    param([Parameter(Mandatory)]$Guard, [Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList,
        [Parameter(Mandatory)][string]$WorkingDirectory, [Parameter(Mandatory)][string]$StandardOutput,
        [Parameter(Mandatory)][string]$StandardError)
    if ($Guard.RootProcess) { throw 'One direct launch per guard.' }
    $launch = @{FilePath=$FilePath;WorkingDirectory=$WorkingDirectory;WindowStyle="Hidden";PassThru=$true;RedirectStandardOutput=$StandardOutput;RedirectStandardError=$StandardError}
    if ($ArgumentList -and $ArgumentList.Count) { $launch.ArgumentList=$ArgumentList }
    $launched = Start-Process @launch
    $Guard.RootProcess = $launched
    try {
        $Guard.Handle = [MyKnowledgeQa.RetainedProcess]::new($launched)
        $Guard.RootIdentity = [pscustomobject]@{
            ProcessId = $Guard.Handle.ProcessId
            CreatedUtc = $Guard.Handle.CreatedUtc
            ExecutablePath = $Guard.Handle.ExecutablePath
        }
        Write-QaProcessEvidence $Guard
        return $launched
    } catch {
        $Guard.Result = @{ Passed = $false; Reason = 'launch-handle-unavailable'; LaunchedProcessId = $launched.Id }
        Write-QaProcessEvidence $Guard
        # An unverified launch remains untouched; never fall back to its PID.
        throw
    }
}

function Update-QaProcessGuard {
    param([Parameter(Mandatory)]$Guard)
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { ConvertTo-QaProcessIdentity $_ })
    if (-not $Guard.RootIdentity) { return $all }
    $rootCurrent = $all | Where-Object ProcessId -eq $Guard.RootIdentity.ProcessId | Select-Object -First 1
    if (Test-QaSameIdentity $Guard.RootIdentity $rootCurrent) {
        $Guard.RootIdentity | Add-Member -Force -NotePropertyName SessionId -NotePropertyValue $rootCurrent.SessionId
        $Guard.RootIdentity | Add-Member -Force -NotePropertyName ParentProcessId -NotePropertyValue $rootCurrent.ParentProcessId
    }
    $knownByPid = @{}
    foreach ($known in @($Guard.RootIdentity) + @($Guard.Candidates.ToArray())) {
        $knownByPid[$known.ProcessId] = @($knownByPid[$known.ProcessId]) + @($known)
    }
    $currentByPid = @{}
    foreach ($current in $all) { $currentByPid[$current.ProcessId] = $current }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($candidate in $all) {
            if (@($knownByPid[$candidate.ProcessId] | Where-Object { Test-QaSameIdentity $_ $candidate }).Count) { continue }
            $parent = @($knownByPid[$candidate.ParentProcessId] | Where-Object { $null -ne $_ })
            if (-not $parent.Count) { continue }
            $liveParent = $currentByPid[$candidate.ParentProcessId]
            $verifiedParent = @($parent | Where-Object { Test-QaSameIdentity $_ $liveParent })
            $parentDates = @($parent | Where-Object CreatedUtc | Sort-Object CreatedUtc)
            $predatesEveryParent = $candidate.CreatedUtc -and $parentDates.Count -and $candidate.CreatedUtc -lt $parentDates[0].CreatedUtc
            $newParentGeneration = $liveParent -and $liveParent.CreatedUtc -and
                -not @($parent | Where-Object CreatedUtc -CEQ $liveParent.CreatedUtc).Count
            $belongsToNewParent = $newParentGeneration -and $candidate.CreatedUtc -and $candidate.CreatedUtc -gt $liveParent.CreatedUtc
            $unrelated = $predatesEveryParent -or $belongsToNewParent
            $reason = if ($predatesEveryParent) { 'child-predates-parent' }
                elseif ($belongsToNewParent) { 'unrelated-reused-parent' }
                elseif (-not $verifiedParent.Count) { 'parent-pid-reused-or-unavailable' }
                elseif (-not $candidate.CreatedUtc -or -not $candidate.ExecutablePath) { 'child-identity-unavailable' }
                elseif ($candidate.CreatedUtc -lt $verifiedParent[0].CreatedUtc) { 'parent-generation-ambiguous' }
                else { 'observed-descendant-without-direct-handle' }
            $key = '{0}|{1}|{2}|{3}|{4}' -f $candidate.ProcessId, $candidate.CreatedUtc, $candidate.ExecutablePath, $candidate.ParentProcessId, $reason
            if ($Guard.ObservationKeys.Add($key)) {
                $Guard.Observations.Add([pscustomobject]@{ ObservedUtc = [datetime]::UtcNow.ToString('o'); Identity = $candidate; ParentIdentity = @($parent); CurrentParentIdentity = $liveParent; Unrelated = [bool]$unrelated; ExclusionReason = $reason })
            }
            if ($reason -eq 'observed-descendant-without-direct-handle') {
                $Guard.Candidates.Add($candidate)
                $knownByPid[$candidate.ProcessId] = @($knownByPid[$candidate.ProcessId]) + @($candidate)
                $changed = $true
            }
        }
    }
    Write-QaProcessEvidence $Guard
    return $all
}

function Complete-QaProcessGuard {
    param([Parameter(Mandatory)]$Guard)
    $lost = @(); $remaining = @(); $failure = $null; $comparisonCompleted = $false
    try {
        $all = @(Update-QaProcessGuard $Guard)
        if ($Guard.Handle -and -not $Guard.Handle.HasExited) {
            $current = $all | Where-Object ProcessId -eq $Guard.RootIdentity.ProcessId | Select-Object -First 1
            $handleIdentity = [pscustomobject]@{ ProcessId = $Guard.Handle.ProcessId; CreatedUtc = $Guard.Handle.CreatedUtc; ExecutablePath = $Guard.Handle.ExecutablePath }
            $decision = Get-QaStopDecision $Guard.RootIdentity $current $Guard.BeforeApps $true $handleIdentity
            $action = [pscustomobject]@{ Identity = $Guard.RootIdentity; RequestedUtc = [datetime]::UtcNow.ToString('o'); Reason = $decision.Reason; Attempted = $false; Stopped = $false }
            $Guard.StopActions.Add($action)
            Write-QaProcessEvidence $Guard
            if ($decision.Allowed) {
                $action.Attempted = $true
                Write-QaProcessEvidence $Guard
                $action.Stopped = $Guard.Handle.Stop()
            }
        } elseif ($Guard.Handle) {
            $Guard.StopActions.Add([pscustomobject]@{ Identity = $Guard.RootIdentity; RequestedUtc = [datetime]::UtcNow.ToString('o'); Reason = 'direct-launch-already-exited'; Attempted = $false; Stopped = $false })
        }
        $all = @(Update-QaProcessGuard $Guard)
        $lost = @($Guard.BeforeApps | Where-Object { $prior = $_; -not (Test-QaSameIdentity $prior ($all | Where-Object ProcessId -eq $prior.ProcessId | Select-Object -First 1)) })
        $comparisonCompleted = $true
        $remaining = @($Guard.Candidates.ToArray() | Where-Object { $prior = $_; Test-QaSameIdentity $prior ($all | Where-Object ProcessId -eq $prior.ProcessId | Select-Object -First 1) })
        if ($Guard.Handle -and -not $Guard.Handle.HasExited) { $remaining += $Guard.RootIdentity }
        foreach ($observation in $Guard.Observations.ToArray()) {
            if ($observation.Unrelated) { continue }
            if ($observation.ExclusionReason -eq 'observed-descendant-without-direct-handle') { continue }
            $prior = $observation.Identity
            $current = $all | Where-Object ProcessId -eq $prior.ProcessId | Select-Object -First 1
            # An incomplete identity never grants ownership. If it has naturally
            # disappeared, there is no surviving unknown process to clean up.
            if ($current -and (-not $prior.CreatedUtc -or $prior.CreatedUtc -ceq $current.CreatedUtc)) {
                $remaining += [pscustomobject]@{ Identity = $current; ExclusionReason = $observation.ExclusionReason }
            }
        }
        if ($remaining.Count) { $failure = 'Unowned or uncertain process remains; no such process was stopped.' }
    } catch { $failure = $_.Exception.Message }
    finally {
        $Guard.Result = [pscustomobject]@{ Passed = ($null -eq $failure -and $lost.Count -eq 0 -and $remaining.Count -eq 0 -and $null -ne $Guard.RootIdentity); Failure = $failure; ExistingAppsPreserved = ($comparisonCompleted -and $lost.Count -eq 0); LostBeforeApps = $lost; RemainingUnstopped = $remaining }
        Write-QaProcessEvidence $Guard -Final
        if ($Guard.Handle) { $Guard.Handle.Dispose() }
    }
    return $Guard.Result
}

Export-ModuleMember -Function New-QaProcessGuard, Start-QaGuardedProcess, Update-QaProcessGuard, Complete-QaProcessGuard, Get-QaStopDecision, Test-QaSameIdentity
