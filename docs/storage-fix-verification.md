# Nested paths, UUID imports and new-document corrections

The final policy below supersedes the earlier legacy-review behavior: current UUID storage remains supported, while automatic legacy matching, copying and its dedicated recovery UI are removed. Earlier measurements and preview records describe their stated source revisions.

The 0.9.1 patch corrects two failures reproduced with artificial fixtures against main `d2e6334c920046ae4562c18a8eec3fd86f7c65cc`. The affected runtime code is unchanged from the published 0.9.0 product source. This work is an unmerged Draft PR and an isolated Windows preview, with no release, installer, Actions run or formal-app replacement.

## Scope

Windows reconstructed canonical parent paths through `PathBuf`, producing backslashes when multiple parent components were present. Guarded UUID admission, document-ID editing and offline target inspection now retain the validated slash-delimited API path. External backslashes, traversal, absolute paths and hidden components remain rejected. The separator failure is Windows-specific; no platform permission or root guards are removed.

Stopped-profile UUID import incorrectly compared a physical file identity with the logical UUID storage key. The shared transfer implementation now checks the logical namespace separately and captures the physical file identity at preview time. Both confirmation and the final transaction check reject changed UUIDs and same-UUID file replacements. Existing input-file proofs, snapshots, quotas, backup rules and rollback remain in force. This logic is shared across OSes; actual macOS execution remains untested.

## Focused evidence

Before the fix, the nested Windows admission and unchanged root-level UUID import regressions failed. Existing physical-key import and explicit legacy-recovery controls passed. All fixtures used synthetic HTML, IDs, inputs and disposable profiles.

- `cargo test --manifest-path tests/backend/Cargo.toml --lib uuid_import_ --locked --offline -j 1 -- --test-threads=1`: 3 passed. Root-level and two-parent Unicode targets retain the full numeric, selection, checkbox, array, nested and auxiliary app maps after reopening. Source and previous physical-key rows remain unchanged. Changed UUIDs and same-UUID file replacements are refused; a final transaction refusal rolls back writes and quota changes.
- `cargo test --manifest-path tests/backend/Cargo.toml --lib document_identity::tests --locked --offline -j 1 -- --test-threads=1`: 9 passed, including nested Unicode admission, guarded ID addition with original HTML backup, rejected external backslashes/traversal, legacy recovery, duplicate decisions and retained state across moves/restart.
- The final focused transfer run passed 9 cases: `uuid_import_`, `export_replace_backup_restart_verify`, `cancelled_forged_expired`, `changed_input_target_root`, `schema_conflict_and_empty`, `interruption_and_expired` and `interrupted_import_begin`. This rerun includes the final bounded import-plan representation. Existing non-UUID import, required backups, stale inputs/targets/roots, empty-record preservation and interruption behavior remain covered.
- Application and backend `cargo clippy --lib --locked --offline -j 1 -- -D warnings` passed. Rust formatting, changed-file prose formatting, local links and `git diff --check` passed.

## Isolated Windows preview

The application-only x64 debug preview built successfully from clean commit `fbbb4c9238720a72f3f6c6f3f07d7df602d504d2`. This record's later completion edit changes documentation only. The PE reports 0.9.1 and the dedicated preview product name. Its SHA-256 is `34f637d61bd34e5bb5210a0ac9bb88ba0753cb16359efbb54a0607c939112b24`.

The compiled identifier is `com.shimilynx.mogledge.storagefixpreview20261015`. A fresh profile and disposable dedicated folders were created through the production backend. In the actual Windows WebView, `資料/二階層/Calculator.html` restored saved amount 7, square mode and the enabled checkbox, displayed 49 and reported restoration complete. A window capture and Native accessibility observation agree. The actual settings, SQLite and WebView data paths were verified beneath the preview identifier; the private artifact manifest retains their exact locations and launch ownership.

Existing caches were reused with one Rust job and sequential heavy checks. A transient progress-record sharing failure interrupted the first supervisor; the original compiler completed, and the same cached Tauri command then returned 0 with verified artifacts. The final process guard passed, preserved the pre-existing app and left no build descendants. The final monitored build retained at least 1,488 MiB free RAM. No user app was stopped or replaced.

This establishes synthetic Native startup restoration on Windows, not manual input/save/restart, live-UI import, full device QA or macOS behavior. No installer was generated and no signing, Actions, release publication or formal-app update was performed.

No real HTML, UUID, source JSON, saved-input database or stopped backup is modified by these checks. Successful synthetic import does not establish that a particular user's old records have been recovered. Existing QA tracking remains open in #25, including platform and real-device conditions. No full suite, macOS Native QA or real-data recovery is claimed.

## Document-scoped legacy review

The later authorized correction removes the profile-wide hold for a valid new UUID when unresolved legacy rows belong to other documents. Same-root/exact-path unresolved rows still require a decision, and physical/object proofs retain their existing migration rules. Location never authorizes automatic copying. Missing-ID review, duplicate UUID decisions, old-row retention and refusal to overwrite an existing target remain intact. No UUID is rewritten merely to make an unrelated new document usable.

The affected `document_identity::tests` group passed 10 cases. The new/updated fixtures cover a same-name row in another root, an unrelated path in the same root, normal save/reload without UUID edits or inherited old input, missing-ID explicit recovery, and a true same-location unresolved row held until an explicit new-document decision with the old data/revision preserved. Existing same-UUID sharing/new-ID decisions, stale grants, exact legacy migration, nested Windows paths and restart behavior passed in that run.

The previous 9 focused transfer results are reused: `state_transfer`, its tests, `ConnectedRoot` and guarded physical identity functions are unchanged, and its key resolver does not call the changed admission/status/new-decision predicates. Application/backend Clippy passed again with `--lib --locked --offline -j 1 -- -D warnings`. No full suite is repeated. The patch remains 0.9.1 within the same Draft PR; this is not another release increment. The replacement preview's exact source/activation evidence is added after completion.

### Updated Native preview

The replacement preview built from clean commit `ea90580f3475b6b3af98c3414068ec1b4ec0ef3d`, with SHA-256 `aa0fe28b96eabd42a8b2889f2b7d8776d9ef4de56326779dbf90b98685101bb7`. It retains 0.9.1, x64, the same preview product name, compiled identifier and profile. The application build returned 0; its process guard passed, preserved existing apps and left no build descendants. One Rust job reused the same cache, with at least 2,040 MiB free RAM.

Before replacement, the canonical synthetic document's Save action reported completion, and the previous preview exited through its normal window-close/session-flush flow. The old executable, complete stopped configuration/local-data profile and artificial HTML/assets were independently retained as one previous generation. No process was forcibly terminated. The regular installed app was not updated or stopped.

A retained artificial legacy row was then added to the isolated profile alongside a new UUID document at `資料/二階層/Fresh Document.html`. Existing session items were retained and the artificial tab appended. In the actual updated Windows WebView, the new document reported no saved value and had no DB row before its first explicit Save. Native accessibility invoked its Save and Save/reload buttons: completion and restoration were observed, with amount 2, double mode, the enabled checkbox and result 4. A screenshot agrees. Read-only SQLite fingerprints confirm the previous preview rows and the unrelated legacy row remain unchanged; the new HTML and UUID remain byte-identical.

The app was left running at the same preview location. Actual settings, SQLite and WebView paths were reverified under the same isolated identifier. The artifact manifest records exact source, hash, profile and launch identity. This adds Native button-driven save/reload evidence; physical input/IME, fresh-input restoration after another full process restart, live-UI import, macOS Native QA and real-data recovery remain unrun. Later edits to this evidence record are documentation-only and do not change the binary's build source.

## HTML selection latency follow-up

Source inspection found two existing costs in UUID admission. Opening a document with a never-saved UUID read and parsed all retained payloads twice. Duplicate checking opened registered roots even when no other object claimed that UUID. Both paths also exist on main; this is not evidence that the latest legacy-scope correction introduced them. Corrected nested-path admission can expose work that previously ended early with a storage hold.

Admission now reuses one validated row snapshot for physical/object proofs and unresolved-location review. Duplicate checking opens registered roots only when another object claims the same UUID. Actual conflicts still verify the registry, root and object; exact copying still uses its revision-checked transaction. Catalog compare-and-swap, management-file identity checks, quotas and existing-target protection remain unchanged. No cross-process transaction guarantee is added.

Synthetic Windows debug-backend measurements used disposable profiles, one registered root and a small valid HTML file. The larger profile held 128 unrelated legacy rows of 64 KiB each, approximately 8 MiB total. The baseline was `ccee37bd0be72238b1cb49735852939032dd34d3`. Repeated opens were measured after phase probes, with three baseline samples and six corrected samples across two runs:

| Retained legacy payloads | Baseline median (range) | Corrected median (range) |
| ------------------------ | ----------------------- | ------------------------ |
| None                     | 0.875 s (0.693–0.900 s) | 0.206 s (0.172–0.295 s)  |
| Approximately 8 MiB      | 1.553 s (1.250–1.791 s) | 0.886 s (0.591–2.278 s)  |

First admission in fresh fixture instances took 0.184–0.226 s without legacy payloads and 0.678–1.368 s with them. After explicit saving, opens took 0.148–0.256 s and 0.281–0.494 s respectively; existing saved UUIDs bypass the full legacy scan. These are backend timings, not WebView render or perceived click latency. OS caches were not flushed. The 2.278 s outlier and changing metadata-I/O times show that the remaining jitter is not resolved by this small correction.

The unchanged full-row scan still scales with retained payload bytes. Admission holds the lifecycle/workspace locks while performing guarded I/O, so concurrent operations can queue; the serial fixture does not measure a user's actual lock wait. Registered-root verification is not an HTML-tree content scan. Existing read-error retries were not exercised by successful fixture reads. No real HTML or saved inputs were read or changed. Existing apps remained running without UI interactions.

All 11 `document_identity::tests` regression cases passed with the timing probe, including the new no-candidate I/O guard and existing duplicate, exact-proof migration, same-location hold, unrelated-row, backup, nested-path and restart cases. Timing instrumentation is excluded from the final source. Application/backend Clippy passed again with `--lib --locked --offline -j 1 -- -D warnings`; Rust formatting and diff checks passed. Independent source review found no changed inheritance or duplicate decision. The earlier transfer evidence remains applicable because its resolver does not use the changed admission/duplicate helpers.

The running preview remains the earlier `ea90580f3475b6b3af98c3414068ec1b4ec0ef3d` build and does not include this performance correction. A rebuilt preview, GUI latency checks and any application replacement remain unrun; merge and release are still on hold.

## Final UUID-only policy

The full legacy lookup originated in 0.9.0 PR #36, main commit `37b3032a4aeb327960bbc630baeda0109cb2e882`, to connect old physical saved records to new UUID identities and hold ambiguous inheritance. It copied and parsed saved JSON bodies, not only metadata. PR #41 did not introduce that mechanism.

The final correction removes that compatibility path rather than optimizing its discovery. Folder registration, document selection/open and document-ID status no longer read retained `documents` or `recovery_records` rows to discover old input. ID addition creates a fresh UUID without copying old input. Old-record review/recovery controls and their IPC fields are removed; missing/invalid ID handling and copied-UUID new/shared decisions remain. Ordinary current-UUID JSON import, quota and quarantine management are unchanged.

No DB rows, files or backups are deleted, initialized or migrated by this cleanup. Unused catalog proof fields remain readable and round-trip through existing catalogs, but do not authorize inheritance. Management-file identities, guarded physical reads, catalog compare-and-swap, conditional HTML replacement/backups, revocation, current saved-JSON validation and quotas remain enforced. Startup still performs its separate current-database integrity validation; this is not a claim that all startup data reads are removed.

The focused Windows backend group passed 10 cases. The new SQL-authorizer regression rejects every read of `documents` and `recovery_records` during registration, selection, ID status and open, with 0 rows, one small row and 128 rows of 64 KiB each. Even an exact physical row and retained object proof are not inherited. After removing the test read denial, the current UUID saves and reloads normally while old row contents/revisions and source HTML remain unchanged. Existing duplicate/share/new-ID, nested path, replacement, restart and HTML-backup cases passed. The dedicated UI group passed 7 cases, and `npm run check` passed. No full suite is repeated.

After independent review retained lightweight management-file checks in ID changes and registration, the three affected selection/save/duplicate cases passed again. Final application/backend Clippy passed with `--lib --locked --offline -j 1 -- -D warnings`. Canonical kit regeneration, its focused reproduction test, changed-file formatting, local links and diff checks passed; template and adapter bytes are unchanged.

The earlier timing table predates this final policy and does not measure it. The one-build replacement preview's exact source, hash and minimal startup evidence are recorded after completion; broader GUI performance and macOS Native checks remain unrun. Merge, Actions, installer and release publication remain outside this update.
