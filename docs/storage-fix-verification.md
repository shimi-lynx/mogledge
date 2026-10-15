# Nested paths and UUID import corrections

The 0.9.1 patch corrects two failures reproduced with artificial fixtures against main `d2e6334c920046ae4562c18a8eec3fd86f7c65cc`. The affected runtime code is unchanged from the published 0.9.0 product source. This work is an unmerged Draft PR and an isolated Windows preview, with no release, installer, Actions run or formal-app replacement.

## Scope

Windows reconstructed canonical parent paths through `PathBuf`, producing backslashes when multiple parent components were present. Guarded UUID admission, document-ID editing and offline target inspection now retain the validated slash-delimited API path. External backslashes, traversal, absolute paths and hidden components remain rejected. The separator failure is Windows-specific; no platform permission or root guards are removed.

Stopped-profile UUID import incorrectly compared a physical file identity with the logical UUID storage key. The shared transfer implementation now checks the logical namespace separately and captures the physical file identity at preview time. Both confirmation and the final transaction check reject changed UUIDs and same-UUID file replacements. Existing input-file proofs, snapshots, quotas, backup rules and rollback remain in force. This logic is shared across OSes; actual macOS execution remains untested.

## Focused evidence

Before the fix, the nested Windows admission and unchanged root-level UUID import regressions failed. Existing physical-key import and explicit legacy-recovery controls passed. All fixtures used synthetic HTML, IDs, inputs and disposable profiles.

- `cargo test --manifest-path tests/backend/Cargo.toml --lib uuid_import_ --locked --offline -j 1 -- --test-threads=1`: 3 passed. Root-level and two-parent Unicode targets retain the full numeric, selection, checkbox, array, nested and auxiliary app maps after reopening. Source and previous physical-key rows remain unchanged. Changed UUIDs and same-UUID file replacements are refused; a final transaction refusal rolls back writes and quota changes.
- `cargo test --manifest-path tests/backend/Cargo.toml --lib document_identity::tests --locked --offline -j 1 -- --test-threads=1`: 9 passed, including nested Unicode admission, guarded ID addition with original HTML backup, rejected external backslashes/traversal, legacy recovery, duplicate decisions and retained state across moves/restart.
- The final focused transfer run passed 9 cases: `uuid_import_`, `export_replace_backup_restart_verify`, `cancelled_forged_expired`, `changed_input_target_root`, `schema_conflict_and_empty`, `interruption_and_expired` and `interrupted_import_begin`. This rerun includes the final bounded import-plan representation. Existing non-UUID import, required backups, stale inputs/targets/roots, empty-record preservation and interruption behavior remain covered.
- Application and backend `cargo clippy --lib --locked --offline -j 1 -- -D warnings` passed. Rust formatting, changed-file prose formatting and `git diff --check` passed. Preview execution is recorded after completion.

No real HTML, UUID, source JSON, saved-input database or stopped backup is modified by these checks. Successful synthetic import does not establish that a particular user's old records have been recovered. Existing QA tracking remains open in #25, including platform and real-device conditions. No full suite, macOS Native QA or real-data recovery is claimed.
