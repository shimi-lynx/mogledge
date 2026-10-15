# macOS storage identity

## Normal Mac use from 0.7.2

Ordinary Mac builds enable persistent volume/object/birth identities by default. Windows and Linux retain their existing identities. Intel Mac saved-input restoration after reboot has been reported by the owner. That report does not establish all filesystems, Apple Silicon, interruption or crash behavior; see [known limitations](known-limitations.md).

Preserve the previous app and independently back up HTML, committed input, configuration and any identifier-migration bundle before updating. Source integration does not create a downloadable binary or release.

An existing uncertain Mac root remains subject to saved-data confirmation. Folder browsing and storage ownership are separate: the app frame shows the hold reason and provides **Open saved-data confirmation tool**; unresolved storage does not return a successful empty value. A healthy, positively validated empty profile can enroll its first registration without assigning any old data. See [registered and displayed folders](registered-folders.md#mac-saved-input-admission) for fresh admission and display restoration.

Save unsaved HTML input before opening the confirmation tool. The Native confirmation explains that Mogledge quits completely, then opens the same app's standalone tool. Opening the tool performs no profile inspection or migration. Its first explicit inspection acquires the exclusive stopped-profile lease; if another process remains active, it refuses access.

Select the knowledge root and an independent backup parent. Separately acknowledge backup/preview creation and the exact root operation. For each HTML document, explicitly choose a retained saved record or new empty state. Path hints alone never assign old values. Newly created, copied or replaced HTML under a legacy-confirmed root, or with conflicting retained identity/path records, also requires confirmation before storage reads, writes or deletes. Only nonconflicting new documents under a positively validated fresh registration have automatic empty admission. Unresolved restoration is a failure, not a successful empty value. Conflicts, unsafe files and uncertain outcomes stay held; original rows, preferences and backups remain available.

Quit the tool and reopen the ordinary app. Ordinary display switching stays within the registered root and preserves its identities and open tabs. Changing the registered root is a separate Settings operation; uncertain retained data still requires explicit confirmation. If backup, confirmation, startup or saving is refused, preserve the files and diagnostic; do not delete/reset a database, sidecar or lock, or automatically retry an uncertain mutation. See [data management](data-management.md) for backup scope and stopped-profile CLI operations.

## Identity and ownership boundary

Mac persisted root/document IDs use volume UUID, object ID and birth time, with separate domain tags. Paths and mount-session device numbers are excluded. Live retained-handle guards still use device/inode checks to reject replaced roots/files. Missing UUID, zero object ID, zero birth time or unsupported volume capabilities have no path or device-number fallback. A cloned volume with identical metadata remains an ambiguity limitation; UUID is not authentication.

Old rows contain hashed identities and relative paths, without sufficient persistent-volume provenance. Neither a matching path nor a guessed old device number proves ownership. Do not automatically rebind legacy rows. Explicit confirmation binds the current physical root/document, selected source, revision, database generation and verified independent backup.

## Backup, confirmation and recovery

The production transition uses the existing management-profile lease, exclusive SQLite lock and no-follow filesystem guards. The application must be completely stopped. The separate confirmation window does not initialize the ordinary Core, resident hooks, document server or preference flushing. Its migration commands belong only to the bundled storage-transition capability; HTML receives no migration authority.

Explicit root confirmation upgrades schema v1/v2 to v3 and records the physical root, scheme, operation and verified backup hash. Fresh empty registration uses the same metadata format with a distinct domain-separated admission marker in the historical `backup_hash` column; it does not create or attest an independent backup. Existing IDs, values, revisions and accounting remain unchanged; older binaries reject v3. Settings publish after the durable database decision. A publication failure retains old settings and holds startup until explicitly reviewed repair.

Each preview copies and verifies the saved-input database, active settings, resident/workspace preferences and tree-order files in a newly created independent backup directory. Identifier-migrated profiles also retain completion metadata and original database layout. Search caches, runtime leases, HTML and unpublished staging are excluded. This is not a backup of the complete knowledge folder. See the [backup guide](data-management.md#back-up-and-recover-a-profile).

Document confirmation copies a selected retained record to a current record at revision one; both count toward quota. Explicit empty confirmation does not delete legacy rows. Existing targets, stale previews, changed files/backups, quarantined records and unsupported identities refuse the operation. A lost response requires operation-status inspection and fresh review, not replay.

HTTP storage holds unresolved reads/writes/deletes with `409 StorageIdentityConfirmationRequired`. Recovery and transfer imports also require target confirmation. Failed restoration must never save blank defaults. Preference recovery copies only explicitly selected preferences and updates document references only when unique durable confirmations and current physical identities agree; unresolved/folder references retain old identities.

Rollback is a separate reviewed operation using an exact verified independent backup. It first backs up current state, preserves the lease and database inode, and publishes old settings last. Changed originals, unknown settings, cancellation and uncertain publication remain held. Both backups are retained. There is no automatic rollback, profile cleanup or installed-app restart.

## Resource and verification limits

Database validation/copying uses SQLite's intrinsic bound, 64 KiB chunks and a size-dependent processing budget: 30 seconds plus one second per 4 MiB. Settings inventory is bounded at 1 MiB per file, 4,096 files and 256 MiB total. Review expires after five minutes; acknowledged work receives a separate processing budget while identity/hash/lease checks remain active. These are not product storage quotas or whole-process memory/durability guarantees.

Synthetic tests cover source preservation, quota accounting, unconfirmed access, stale/changed previews, cancellation, database-first/settings-last publication and recovery. They do not establish real Mac UUID persistence, every filesystem, multi-gigabyte backup, crash/disk-full behavior or Apple Silicon. The isolated handle-API probe is available as:

```sh
cargo test --locked --manifest-path tests/backend/Cargo.toml --lib --jobs 1 macos_native_candidate_probe -- --test-threads=1
```

Use disposable fixtures and the [Native QA policy](testing.md#native-qa). No production profile migration or new Native validation is performed by repository preparation.
