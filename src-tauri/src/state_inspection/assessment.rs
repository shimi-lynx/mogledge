//! Pure preflight policy for a future trusted host. No evidence collector,
//! approval issuer, storage value, filesystem access or mutation authority.
use super::{MAX_RECORDS, MAX_TOTAL_BYTES};

/// Proposed conservative defaults, not a background schedule or purge deadline.
pub const ABSENCE_RECHECK_MS: u64 = 24 * 60 * 60 * 1000;
pub const EVIDENCE_FRESHNESS_MS: u64 = 5 * 60 * 1000;
pub const SELECTION_LIFETIME_MS: u64 = 5 * 60 * 1000;

/// A future Native collector uses a monotonic clock in one runtime epoch.
/// These fields are not proof of provenance and must never come from AI/JSON.
/// Restart/epoch change invalidates observations and outstanding selections.
#[derive(Debug, Clone, Copy)]
pub struct ClockObservation {
    pub epoch: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    RootDisconnected,
    OfflineOrNotHydrated,
    AccessDenied,
    BusyOrSyncing,
    UnsafePath,
    IncompleteScan,
}

/// Produced by a trusted bounded identity scan of an explicitly connected root.
/// A missing path, HTTP 404 or an index miss cannot construct this evidence.
#[derive(Debug, Clone, Copy)]
pub struct AbsenceObservation<'a> {
    pub root_identity: &'a str,
    pub document_identity: &'a str,
    pub root_epoch: u64,
    pub scan_id: u64,
    pub clock_epoch: u64,
    pub observed_elapsed_ms: u64,
    pub complete_identity_scan: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum SourceEvidence<'a> {
    NotChecked,
    Unavailable(UnavailableReason),
    /// Includes a hardlink or rename/move inside the same physical root.
    SameIdentity {
        relocated: bool,
    },
    /// Old state remains recovery material; replacement is not proof of disuse.
    DifferentIdentityAtPath,
    Absence {
        first: AbsenceObservation<'a>,
        second: AbsenceObservation<'a>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Unknown,
    InUse,
    /// Only valid after views/grants/workers are fenced by the trusted host.
    FencedInactive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateAssessment {
    HoldNotChecked,
    HoldUnavailable(UnavailableReason),
    HoldActivityUnknown,
    HoldInUse,
    HoldUnstableAbsence,
    PreserveSameIdentity,
    PreserveRelocatedIdentity,
    PreserveRecoveryHistory,
    /// A reason to explain and request selection, never permission to execute.
    ReviewStableAbsence,
}

/// Deliberately has no last-viewed threshold: age alone is not a cleanup reason.
pub fn assess_candidate(
    source: SourceEvidence<'_>,
    activity: Activity,
    clock: ClockObservation,
) -> CandidateAssessment {
    use CandidateAssessment::*;
    match source {
        SourceEvidence::NotChecked => HoldNotChecked,
        SourceEvidence::Unavailable(reason) => HoldUnavailable(reason),
        SourceEvidence::SameIdentity { relocated: false } => PreserveSameIdentity,
        SourceEvidence::SameIdentity { relocated: true } => PreserveRelocatedIdentity,
        SourceEvidence::DifferentIdentityAtPath => PreserveRecoveryHistory,
        SourceEvidence::Absence { first, second } => {
            if !super::digest_id(first.root_identity)
                || !super::digest_id(first.document_identity)
                || first.root_identity != second.root_identity
                || first.document_identity != second.document_identity
                || first.root_epoch != second.root_epoch
                || first.clock_epoch != second.clock_epoch
                || second.clock_epoch != clock.epoch
                || first.scan_id == second.scan_id
                || !first.complete_identity_scan
                || !second.complete_identity_scan
                || second
                    .observed_elapsed_ms
                    .checked_sub(first.observed_elapsed_ms)
                    .is_none_or(|elapsed| elapsed < ABSENCE_RECHECK_MS)
                || clock
                    .elapsed_ms
                    .checked_sub(second.observed_elapsed_ms)
                    .is_none_or(|elapsed| elapsed > EVIDENCE_FRESHNESS_MS)
            {
                return HoldUnstableAbsence;
            }
            match activity {
                Activity::Unknown => HoldActivityUnknown,
                Activity::InUse => HoldInUse,
                Activity::FencedInactive => ReviewStableAbsence,
            }
        }
    }
}

/// Metadata bound to one selected record. Whole-snapshot comparison is
/// intentionally conservative, including unrelated writes and location remaps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordSnapshot<'a> {
    pub database_id: &'a str,
    pub snapshot_id: &'a str,
    pub root_identity: &'a str,
    pub document_identity: &'a str,
    pub revision: i64,
    pub record_generation: i64,
    pub database_generation: i64,
    pub logical_bytes: i64,
    pub profile_epoch: u64,
    pub lifecycle_epoch: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct Selection<'a> {
    pub expected: RecordSnapshot<'a>,
    pub clock_epoch: u64,
    pub issued_elapsed_ms: u64,
    pub expires_elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightError {
    InvalidMetadata,
    ExpiredSelection,
    ChangedSnapshot,
    RestoreConflict,
    QuotaExceeded,
}

/// Checks a selection's binding only. Success does not prove confirmation,
/// inactivity, source absence, durable backup, lease ownership or authorization.
pub fn check_selection(
    selection: Selection<'_>,
    current: RecordSnapshot<'_>,
    clock: ClockObservation,
) -> Result<(), PreflightError> {
    let expected = selection.expected;
    if ![
        expected.database_id,
        expected.snapshot_id,
        expected.root_identity,
        expected.document_identity,
    ]
    .into_iter()
    .all(super::digest_id)
        || expected.revision <= 0
        || expected.record_generation <= 0
        || expected.database_generation < expected.record_generation
        || !(2..=crate::storage_limits::maximum_document_bytes() as i64)
            .contains(&expected.logical_bytes)
    {
        return Err(PreflightError::InvalidMetadata);
    }
    if selection.clock_epoch != clock.epoch
        || clock.elapsed_ms < selection.issued_elapsed_ms
        || clock.elapsed_ms >= selection.expires_elapsed_ms
        || selection
            .expires_elapsed_ms
            .checked_sub(selection.issued_elapsed_ms)
            .is_none_or(|elapsed| elapsed == 0 || elapsed > SELECTION_LIFETIME_MS)
    {
        return Err(PreflightError::ExpiredSelection);
    }
    if expected != current {
        return Err(PreflightError::ChangedSnapshot);
    }
    Ok(())
}

/// Initial restore policy: add only into an absent record, preserving empty
/// records as conflicts too. The executor must validate the actual JSON/app
/// envelopes and quota again inside its transaction; these are metadata checks.
pub fn check_restore_budget(
    current_bytes: i64,
    current_records: i64,
    restored_bytes: i64,
    restored_app_count: usize,
    target_record_exists: bool,
) -> Result<(), PreflightError> {
    check_restore_budget_with_limits(
        current_bytes,
        current_records,
        restored_bytes,
        restored_app_count,
        target_record_exists,
        crate::storage_limits::Limits {
            document_bytes: crate::storage_limits::maximum_document_bytes(),
            total_bytes: MAX_TOTAL_BYTES,
            revision: 0,
        },
    )
}

pub(crate) fn check_restore_budget_with_limits(
    current_bytes: i64,
    current_records: i64,
    restored_bytes: i64,
    restored_app_count: usize,
    target_record_exists: bool,
    limits: crate::storage_limits::Limits,
) -> Result<(), PreflightError> {
    if target_record_exists {
        return Err(PreflightError::RestoreConflict);
    }
    if !(0..=crate::storage_limits::MAX_SAFE_BYTES).contains(&current_bytes)
        || !(0..=MAX_RECORDS).contains(&current_records)
        || !(2..=crate::storage_limits::maximum_document_bytes() as i64).contains(&restored_bytes)
        || restored_app_count > 128
    {
        return Err(PreflightError::InvalidMetadata);
    }
    if restored_bytes > limits.document_bytes as i64
        || current_bytes
            .checked_add(restored_bytes)
            .is_none_or(|total| total > limits.total_bytes)
        || current_records >= MAX_RECORDS
    {
        return Err(PreflightError::QuotaExceeded);
    }
    Ok(())
}

#[cfg(test)]
#[path = "assessment/tests.rs"]
mod tests;
