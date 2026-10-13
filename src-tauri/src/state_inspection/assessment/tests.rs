use super::*;

const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DOCUMENT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SNAPSHOT: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn clock(elapsed_ms: u64) -> ClockObservation {
    ClockObservation {
        epoch: 3,
        elapsed_ms,
    }
}

fn assess_at(
    source: SourceEvidence<'_>,
    activity: Activity,
    elapsed_ms: u64,
) -> CandidateAssessment {
    assess_candidate(source, activity, clock(elapsed_ms))
}

fn check_at(
    selection: Selection<'_>,
    current: RecordSnapshot<'_>,
    elapsed_ms: u64,
) -> Result<(), PreflightError> {
    check_selection(selection, current, clock(elapsed_ms))
}

fn first() -> AbsenceObservation<'static> {
    AbsenceObservation {
        root_identity: ROOT,
        document_identity: DOCUMENT,
        root_epoch: 7,
        scan_id: 1,
        clock_epoch: 3,
        observed_elapsed_ms: 1000,
        complete_identity_scan: true,
    }
}

fn second() -> AbsenceObservation<'static> {
    AbsenceObservation {
        scan_id: 2,
        observed_elapsed_ms: 1000 + ABSENCE_RECHECK_MS,
        ..first()
    }
}

fn missing(second: AbsenceObservation<'_>, activity: Activity, now: u64) -> CandidateAssessment {
    assess_at(
        SourceEvidence::Absence {
            first: first(),
            second,
        },
        activity,
        now,
    )
}

#[test]
fn missing_requires_complete_repeated_identity_evidence_and_fenced_activity() {
    let second = second();
    assert_eq!(
        missing(second, Activity::FencedInactive, second.observed_elapsed_ms),
        CandidateAssessment::ReviewStableAbsence
    );
    assert_eq!(
        missing(second, Activity::Unknown, second.observed_elapsed_ms),
        CandidateAssessment::HoldActivityUnknown
    );
    assert_eq!(
        missing(second, Activity::InUse, second.observed_elapsed_ms),
        CandidateAssessment::HoldInUse
    );
}

#[test]
fn root_replacement_movement_incomplete_or_replayed_scans_are_not_absence() {
    let valid = second();
    let cases = [
        AbsenceObservation {
            root_identity: DOCUMENT,
            ..valid
        },
        AbsenceObservation {
            document_identity: ROOT,
            ..valid
        },
        AbsenceObservation {
            root_epoch: 8,
            ..valid
        },
        AbsenceObservation {
            scan_id: 1,
            ..valid
        },
        AbsenceObservation {
            complete_identity_scan: false,
            ..valid
        },
        AbsenceObservation {
            observed_elapsed_ms: valid.observed_elapsed_ms - 1,
            ..valid
        },
        AbsenceObservation {
            observed_elapsed_ms: 999,
            ..valid
        },
    ];
    for value in cases {
        assert_eq!(
            missing(value, Activity::FencedInactive, valid.observed_elapsed_ms),
            CandidateAssessment::HoldUnstableAbsence
        );
    }
    let mut first = first();
    first.complete_identity_scan = false;
    assert_eq!(
        assess_at(
            SourceEvidence::Absence {
                first,
                second: valid
            },
            Activity::FencedInactive,
            valid.observed_elapsed_ms
        ),
        CandidateAssessment::HoldUnstableAbsence
    );
}

#[test]
fn stale_future_and_invalid_identity_evidence_remain_on_hold() {
    let second = second();
    assert_eq!(
        missing(
            second,
            Activity::FencedInactive,
            second.observed_elapsed_ms + EVIDENCE_FRESHNESS_MS
        ),
        CandidateAssessment::ReviewStableAbsence
    );
    for now in [
        second.observed_elapsed_ms - 1,
        second.observed_elapsed_ms + EVIDENCE_FRESHNESS_MS + 1,
    ] {
        assert_eq!(
            missing(second, Activity::FencedInactive, now),
            CandidateAssessment::HoldUnstableAbsence
        );
    }
    let mut first = first();
    first.root_identity = "invalid";
    let mut second = second;
    second.root_identity = "invalid";
    assert_eq!(
        assess_at(
            SourceEvidence::Absence { first, second },
            Activity::FencedInactive,
            second.observed_elapsed_ms
        ),
        CandidateAssessment::HoldUnstableAbsence
    );
}

#[test]
fn disconnected_offline_denied_syncing_and_unknown_are_never_missing() {
    assert_eq!(
        assess_at(SourceEvidence::NotChecked, Activity::FencedInactive, 0),
        CandidateAssessment::HoldNotChecked
    );
    for reason in [
        UnavailableReason::RootDisconnected,
        UnavailableReason::OfflineOrNotHydrated,
        UnavailableReason::AccessDenied,
        UnavailableReason::BusyOrSyncing,
        UnavailableReason::UnsafePath,
        UnavailableReason::IncompleteScan,
    ] {
        assert_eq!(
            assess_at(
                SourceEvidence::Unavailable(reason),
                Activity::FencedInactive,
                0
            ),
            CandidateAssessment::HoldUnavailable(reason)
        );
    }
}

#[test]
fn same_identity_rename_hardlink_and_replacement_history_are_preserved() {
    assert_eq!(
        assess_at(
            SourceEvidence::SameIdentity { relocated: false },
            Activity::FencedInactive,
            0
        ),
        CandidateAssessment::PreserveSameIdentity
    );
    assert_eq!(
        assess_at(
            SourceEvidence::SameIdentity { relocated: true },
            Activity::FencedInactive,
            0
        ),
        CandidateAssessment::PreserveRelocatedIdentity
    );
    assert_eq!(
        assess_at(
            SourceEvidence::DifferentIdentityAtPath,
            Activity::FencedInactive,
            0
        ),
        CandidateAssessment::PreserveRecoveryHistory
    );
}

fn snapshot() -> RecordSnapshot<'static> {
    RecordSnapshot {
        database_id: ROOT,
        snapshot_id: SNAPSHOT,
        root_identity: ROOT,
        document_identity: DOCUMENT,
        revision: 2,
        record_generation: 4,
        database_generation: 9,
        logical_bytes: 20,
        profile_epoch: 3,
        lifecycle_epoch: 7,
    }
}

fn selection() -> Selection<'static> {
    Selection {
        expected: snapshot(),
        clock_epoch: 3,
        issued_elapsed_ms: 100,
        expires_elapsed_ms: 100 + SELECTION_LIFETIME_MS,
    }
}

#[test]
fn selection_detects_update_root_switch_reopen_and_metadata_remap() {
    let expected = snapshot();
    assert_eq!(check_at(selection(), expected, 100), Ok(()));
    let changes = [
        RecordSnapshot {
            database_id: DOCUMENT,
            ..expected
        },
        RecordSnapshot {
            snapshot_id: ROOT,
            ..expected
        },
        RecordSnapshot {
            root_identity: DOCUMENT,
            ..expected
        },
        RecordSnapshot {
            document_identity: ROOT,
            ..expected
        },
        RecordSnapshot {
            revision: 3,
            ..expected
        },
        RecordSnapshot {
            record_generation: 5,
            ..expected
        },
        RecordSnapshot {
            database_generation: 10,
            ..expected
        },
        RecordSnapshot {
            logical_bytes: 21,
            ..expected
        },
        RecordSnapshot {
            profile_epoch: 4,
            ..expected
        },
        RecordSnapshot {
            lifecycle_epoch: 8,
            ..expected
        },
    ];
    for current in changes {
        assert_eq!(
            check_at(selection(), current, 100),
            Err(PreflightError::ChangedSnapshot)
        );
    }
}

#[test]
fn selection_expiry_clock_rollback_and_invalid_metadata_are_rejected() {
    let selection = selection();
    for now in [99, selection.expires_elapsed_ms, u64::MAX] {
        assert_eq!(
            check_at(selection, snapshot(), now),
            Err(PreflightError::ExpiredSelection)
        );
    }
    for expires_elapsed_ms in [100, 99, selection.expires_elapsed_ms + 1] {
        assert_eq!(
            check_at(
                Selection {
                    expires_elapsed_ms,
                    ..selection
                },
                snapshot(),
                100
            ),
            Err(PreflightError::ExpiredSelection)
        );
    }
    let invalid = [
        RecordSnapshot {
            document_identity: "INVALID",
            ..snapshot()
        },
        RecordSnapshot {
            revision: 0,
            ..snapshot()
        },
        RecordSnapshot {
            record_generation: 0,
            ..snapshot()
        },
        RecordSnapshot {
            database_generation: 3,
            ..snapshot()
        },
        RecordSnapshot {
            logical_bytes: crate::storage_limits::maximum_document_bytes() as i64 + 1,
            ..snapshot()
        },
    ];
    for expected in invalid {
        assert_eq!(
            check_at(
                Selection {
                    expected,
                    ..selection
                },
                expected,
                100
            ),
            Err(PreflightError::InvalidMetadata)
        );
    }
}

#[test]
fn restore_never_overwrites_and_obeys_exact_byte_record_and_app_limits() {
    assert_eq!(
        check_restore_budget(MAX_TOTAL_BYTES - 2, MAX_RECORDS - 1, 2, 0, false),
        Ok(())
    );
    assert_eq!(
        check_restore_budget(
            0,
            0,
            (crate::storage_limits::maximum_document_bytes() as i64).min(MAX_TOTAL_BYTES),
            128,
            false
        ),
        Ok(())
    );
    assert_eq!(
        check_restore_budget(0, 0, 2, 0, true),
        Err(PreflightError::RestoreConflict)
    );
    for (bytes, count) in [(MAX_TOTAL_BYTES - 1, 0), (0, MAX_RECORDS)] {
        assert_eq!(
            check_restore_budget(bytes, count, 2, 0, false),
            Err(PreflightError::QuotaExceeded)
        );
    }
    for (bytes, count, restored, apps) in [
        (-1, 0, 2, 0),
        (0, -1, 2, 0),
        (i64::MAX, 0, 2, 0),
        (0, MAX_RECORDS + 1, 2, 0),
        (0, 0, 1, 0),
        (
            0,
            0,
            crate::storage_limits::maximum_document_bytes() as i64 + 1,
            0,
        ),
        (0, 0, 2, 129),
    ] {
        assert_eq!(
            check_restore_budget(bytes, count, restored, apps, false),
            Err(PreflightError::InvalidMetadata)
        );
    }
}

#[test]
fn restart_or_changed_clock_epoch_invalidates_absence_and_selection() {
    let valid = second();
    let source = SourceEvidence::Absence {
        first: first(),
        second: valid,
    };
    let changed_clock = ClockObservation {
        epoch: 4,
        elapsed_ms: valid.observed_elapsed_ms,
    };
    assert_eq!(
        assess_candidate(source, Activity::FencedInactive, changed_clock),
        CandidateAssessment::HoldUnstableAbsence
    );
    assert_eq!(
        missing(
            AbsenceObservation {
                clock_epoch: 4,
                ..valid
            },
            Activity::FencedInactive,
            valid.observed_elapsed_ms
        ),
        CandidateAssessment::HoldUnstableAbsence
    );
    assert_eq!(
        check_selection(
            selection(),
            snapshot(),
            ClockObservation {
                epoch: 4,
                elapsed_ms: 100
            }
        ),
        Err(PreflightError::ExpiredSelection)
    );
}

#[test]
fn monotonic_elapsed_controls_recheck_and_expiry_boundaries() {
    // No wall-clock field enters policy. Model wall-clock movement while the
    // Native monotonic clock advances normally, including after expiration.
    let mut second = second();
    second.observed_elapsed_ms = first().observed_elapsed_ms + 1;
    assert_eq!(
        missing(second, Activity::FencedInactive, second.observed_elapsed_ms),
        CandidateAssessment::HoldUnstableAbsence
    );
    let selection = selection();
    for elapsed_ms in [
        selection.expires_elapsed_ms,
        selection.expires_elapsed_ms + 1,
    ] {
        assert_eq!(
            check_at(selection, snapshot(), elapsed_ms),
            Err(PreflightError::ExpiredSelection)
        );
    }
}
