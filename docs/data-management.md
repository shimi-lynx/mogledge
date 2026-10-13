# Data management

Mogledge keeps HTML and assets in the selected knowledge folder, and committed document input in a separate SQLite database. An HTML document must use the [document storage API](document-storage.md) to restore its saved input. Arbitrary JavaScript state, Canvas contents and unflushed input are not automatic backups.

Use the running app's settings and document menus for ordinary management. The advanced CLIs below operate on explicitly selected local directories; they do not discover profiles or connect to a running app. Read [known limitations](known-limitations.md) before relying on an operation that has not been verified on your OS.

## Back up and recover a profile

A portable export contains one document's committed input. It does not contain the HTML, assets, settings, search index, browser localStorage or the entire profile. Internal recovery copies share the active database and cannot protect against losing or corrupting that database.

Before an update, database format change or recovery operation, make an independent backup:

1. Confirm any pending document saves, then fully quit Mogledge and related processes. Closing the window may leave the resident app running. Close external browser views as well.
2. Preserve the knowledge folder and assets, the current configuration profile, the entire `document-state` directory and the current application binary. Do not treat a copy of a running SQLite file as a consistent backup.
3. If identifier migration has occurred, preserve the whole `identifier-migration-v1` bundle, including its `config`, `document-state` and migration marker. Preserve WebView data separately if browser-backed preferences matter.
4. Keep the backup outside the active profile and verify the files before changing the original.

The current product identifier is `com.shimilynx.myknowledge`. Configuration and local data use the OS directories for that identifier; a migrated database may instead live under `identifier-migration-v1/document-state`. Use the actual active profile, rather than assuming a location from the application name. See the [update guide](update-guide.md) and [identifier migration contract](identifier-migration.md).

Normal startup can ask SQLite to recover an existing current-profile rollback journal while holding the profile lease. Read-only inspection and stopped-profile management do not perform this recovery. If they reject a journal, WAL/SHM file, unknown entry, unsafe link, busy database or unsupported schema, preserve the files and investigate. Deleting a sidecar or migration lock to make inspection pass is not a recovery procedure. Search indexes are rebuildable caches; document input and configuration are persistent data.

If only the saved knowledge root is unavailable, the app can open its ordinary folder-selection screen with a recovery notice without deleting data or creating the missing folder. Check its name, location, drive connection and access permissions. Return the same physical folder to its saved location and retry, or explicitly select a root. A different folder at the same path does not inherit the old root's state. Cancelling selection preserves the notice and existing data. Older path-only settings require one explicit selection before reconnecting; invalid settings or failed profile/database initialization remain errors.

## Inspect, quarantine and restore in the app

On Mac from 0.7.2, use **Settings → Saved data → Open saved-data confirmation tool** when prompted about storage identity, or before using a new root/HTML document. Save unsaved HTML input first; a Native confirmation quits the app and opens its separate stopped-profile tool. Select an independent backup destination, acknowledge the root, then explicitly assign a retained record or new empty state to each HTML. Unknown or conflicting ownership remains held, with the old data and backups retained. Quit the tool and reopen the ordinary app. See [normal Mac confirmation](macos-storage-identity.md#normal-mac-use-from-072). The owner confirmed Intel Mac saved-input restoration after reboot; wider storage QA remains incomplete. After the separate close-menu startup correction, the owner confirmed ordinary Mac operation, resident recall and Cmd+W tab closing; their exact tested binary version/hash is not stated.

Open **Settings → Saved data** to request a metadata inspection. The list has pages of up to 20 records and starts with no selection. It distinguishes active logical bytes and record counts, internal recovery bytes and counts, database and journal sizes, and free database pages. Free pages are not space already returned to the OS. Last-use information is unknown; age, a missing file or an index miss never authorizes cleanup.

To use recovery, explicitly preview and confirm the database upgrade from schema v1 to v2. This adds recovery records and tombstones without changing active input or its quota. New databases start at v1. An older application that cannot read v2 will refuse this database; no automatic downgrade is provided.

Select one eligible record and review its identity, affected saved input, recovery conditions and quota effect before confirming quarantine. Quarantine copies the whole document's app map into the same SQLite database, removes its active record and records a tombstone in one transaction. The HTML is unchanged. Further saves to that quarantined identity are rejected with `Revoked` until management restores it.

Restore is allowed only to the same physical root and document identity, within the current quotas. Any existing active record, including an empty `{}`, is a conflict and will not be overwritten. Restoration increases the active revision and retains the recovery copy. There is no permanent purge, retention-based deletion or VACUUM operation. Quarantine frees active logical quota; it does not promise smaller disk usage.

Live management requires a complete metadata scan confirming the same path and physical identity. It holds records that are registered in active or hidden tabs, external browser sessions or unfinished opens. Missing, moved, offline, replaced, inaccessible or incompletely observed sources remain on hold. It does not close views for you. Closing an external browser may leave its registration on hold because the app cannot detect that closure; restart the app and inspect again if necessary. The stopped CLI has a broader same-identity rename/move check, described below.

Preparation is a preview. Confirmation rechecks the root, context, database snapshot and selected record before committing. Plans expire after five minutes and cannot be carried across a restart or changed context. After a lost response, use the explicit result inquiry; do not automatically repeat the operation. A cancellation request alone does not prove rollback: a commit may already have passed its final decision. Quarantine/restore operation IDs can be checked in the database; an upgrade's current schema alone does not prove that a particular request succeeded.

## Export and import committed input

Use an HTML file's tree context menu to **Export saved input** or **Import saved input**. Select a file through the native picker, inspect the preview and confirm the operation. Export writes the committed database snapshot, rather than the current contents of every input field or JavaScript object.

Import replaces the target document's **entire app map**. App IDs absent from the incoming file are removed from active state. A shared app ID with a different `schemaVersion` is rejected; import does not merge or convert schemas. The target is explicitly selected and checked by physical identity, rather than inferred from the export's source path.

When a target has an existing record, even an empty map, choose a new backup file and separately acknowledge replacement and the plaintext backup. The backup must be flushed and published before the database changes. Existing export and backup destinations are never overwritten. A target without an existing record needs no replacement backup. To return to a backup, import it through a new preview, making a new backup of any current record; the target revision increases rather than reverting to the source revision.

The preview also identifies affected active/hidden views, external browser grants and unfinished opens. Saving acknowledgement is **unknown**; a dirty flag, file timestamp or database revision does not establish that all input was flushed. If stopping/reloading views is necessary, the UI asks for a separate acknowledgement that unsaved input may be lost. Import revokes affected grants, retains tabs, and reloads only still-matching real app views. It does not automatically issue new external-browser grants or activate hidden placeholders.

Exports and replacement backups are **plaintext**. They contain saved values, the source relative path and identity metadata. Choose their location and sharing permissions accordingly. Input/output files must be ordinary local files outside the active profile; links, hardlinked inputs, Cloud files and existing output destinations are rejected. Transfer does not encrypt, upload, synchronize or automatically delete these files.

On failure, existing input, revision and quota are preserved by rollback, while an already published backup is retained. Revoked grants are not silently revived. After a lost response or cancellation request, explicitly check operation status or compare the chosen file with the current target. A matching current value proves equality now, not that a past operation ran exactly once. Transfer plans and receipts do not survive an app restart; repeat only through a new preview and confirmation. Windows directory-flush durability and power-loss behavior require separate verification.

### Portable JSON format

The UTF-8 format is `my-knowledge-saved-state`, `formatVersion: 1`. Its fields are `format`, `formatVersion`, `appVersion`, `source` and `apps`. `source` contains `rootIdentity`, `documentIdentity`, `relativePath`, `revision` and `generation`. Each `apps` entry contains only `schemaVersion` and `data`. The file's source identity is provenance, not authorization to write that source or another target.

Root/document identities are 64 lowercase hexadecimal characters; relative paths are safe UTF-8 paths of at most 4,096 bytes. Source revision is a positive signed 64-bit integer and generation is nonnegative. App IDs use 1–80 ASCII letters, digits, `.`, `-` or `_`, with at most 128 IDs. `schemaVersion` is a positive JavaScript-safe integer. An empty app map is valid. Unknown fields, duplicate keys at any depth, invalid UTF-8, non-finite numbers, excessive nesting and trailing data are rejected. The raw portable file has a finite runtime document-capacity budget plus 16 KiB for its wrapper; passing that check does not guarantee import fits the current quota or available resources.

## Logical quotas and runtime capacity

One MiB is 1,048,576 bytes. Logical usage counts the UTF-8 JSON for the **whole document app map**, including IDs, envelopes, keys, quoting, escapes and syntax. It is neither character count nor database file size.

| Limit                                         | Current contract                                                  |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Active input per physical document            | Default 5 MiB; configurable in whole MiB from 1 to 8,589,934,591  |
| Active input across every root in one profile | Default 512 MiB; the same range, at least the document limit      |
| Active identities / app IDs                   | 4,096 identities per profile / 128 app IDs per document           |
| Internal recovery area                        | Separate fixed 512 MiB / 4,096 entries, including restored copies |

Change the logical limits in **Settings → Saved data**. They take effect for the next save, import or restore without a restart. Lowering the total below current active usage, or the document limit below the largest active or recovery document, is rejected without trimming data. Empty active records still consume identity slots.

The first different setting that creates the limits table, or changes its older numeric format, requires an explicit compatibility acknowledgement and an independent profile backup. Reading limits or setting the same values does not change the format. Returning to 5/512 MiB does not remove the table or restore old-version compatibility. This format change is separate from the v2 recovery upgrade. Consult the [document storage contract](document-storage.md) before reverting an application or HTML adapter.

The large numeric range only keeps the MiB-to-byte conversion within JavaScript safe integers. It does not reserve disk or memory, or guarantee saving that quantity. The settings snapshot separately reports:

| Capability             | Meaning                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `maximumDocumentBytes` | Current SQLite row/value length capacity                             |
| `maximumRequestBytes`  | Document capacity plus 1 KiB for the HTTP request wrapper            |
| `maximumDatabaseBytes` | Physical page capacity for the current database format and page size |
| `recoveryBudgetBytes`  | Fixed 512 MiB internal recovery budget                               |

The bundled SQLite currently reports a row limit of 1,000,000,000 bytes. Other columns and SQLite representation consume part of that capacity. The new numeric format uses SQLite's intrinsic page capacity, with a page-count boundary of 4,294,967,294; older formats retain the existing 1 GiB guard for v1 without a limits table, or 2 GiB for the older limits table/v2. Indexes, free pages, journals, backups and recovery copies also use disk.

Quota failures (`QuotaExceeded`), SQLite/disk capacity failures (`CapacityExceeded`) and resource-allocation failures (`ResourceUnavailable`) are distinct. They preserve the last successful value and revision instead of truncating or initializing data. A document over 512 MiB may fit ordinary active quota but cannot be quarantined into the fixed recovery budget; that operation safely refuses and retains its active input. Older recovery copies are not evicted to make room.

Native HTTP receives a finite body bounded by runtime document capacity plus 1 KiB, with a 30-second body-collection timeout. Four requests can be admitted per store, with one processing slot held from collection through response consumption. These limits do not bound renderer/OS memory or total operation time. Existing HTML with an older inline adapter retains its own limit until explicitly regenerated and verified. Without a Native descriptor, the canonical browser adapter uses 5 MiB, subject to the browser's own origin/localStorage policies. Native settings do not enlarge ordinary browser storage.

## Advanced stopped-profile CLIs

These binaries are defined in `src-tauri/Cargo.toml` and `tests/backend/Cargo.toml`. Developer builds can run the same Rust entry points with `cargo run --locked --manifest-path tests/backend/Cargo.toml --bin <binary> -- <arguments>`. They are separate tools, not commands sent to the Mogledge executable. Their parsers reject unknown and duplicate options; there is no separate `--help` command. Replace all placeholders with explicitly selected absolute paths and IDs returned by the immediately preceding response.

### Read-only inspection

```sh
state-inspection-cli inspect --state-dir "<absolute-document-state-directory>" --limit 20 --offset 0 --format json
state-inspection-cli inspect --state-dir "<absolute-document-state-directory>" --limit 20 --offset 20 --snapshot-id "<snapshot-id>"
```

`--state-dir` is the existing directory containing `state.sqlite`, not the whole profile. `--limit` accepts 1–100 (default 20), `--offset` accepts 0–4,096 (default 0), and the only format is JSON. Success writes one JSON report to stdout and exits 0; failure writes a fixed code/message to stderr and exits 2.

Inspection opens read-only/no-follow, validates schema and metadata in one read transaction, and checks physical database/directory identities. It does not create, migrate, repair, roll back a journal, scan HTML or reclaim space. Busy, missing, corrupt or unsupported state and sidecars are reasons to stop. A busy wait is limited to 250 ms and queries have a two-second budget; OS I/O has no strict elapsed-time guarantee.

The report distinguishes `schemaVersion` (report contract) from `databaseSchemaVersion`, and supplies `databaseId`, `snapshotId` and generation. If the snapshot changes while paging, start inspection again. It checks declared versus actual UTF-8 byte lengths without parsing every saved JSON value; metadata completeness is not business-schema validation. Sources are `not_checked`, activity is unknown, candidates are on hold and `cleanupAuthorized` is false. Backup size, per-table disk usage and reclaimable space are unknown. No saved values, HTML, private absolute paths or existing tokens are printed. `knowledge-cli` is a separate search tool, not a state-management command.

### Explicit management session

Fully quit the app before opening a session. It holds the same profile lease as the app and an exclusive SQLite connection until `quit` or EOF, rejecting another app/session/writer. Opening it neither creates a database nor upgrades its schema.

```sh
state-inspection-cli manage --profile-dir "<absolute-current-local-data-profile>" --root "<absolute-knowledge-root>"
```

`--root` is optional for metadata inspection; without a safely connected root, record operations remain on hold. `--profile-dir` is the existing current identifier's local-data directory, including when it contains a migration bundle. The root and profile cannot contain one another. Send one JSON command per line:

```json
{"command":"inspect","offset":0,"limit":20}
{"command":"prepare_upgrade"}
{"command":"confirm","plan_id":"<upgrade-plan-id>","confirmation":"<upgrade-plan-id>"}
{"command":"inspect"}
{"command":"prepare_quarantine","document_identity":"<selected-document-id>","snapshot_id":"<current-snapshot-id>"}
{"command":"confirm","plan_id":"<quarantine-plan-id>","confirmation":"<quarantine-plan-id>"}
{"command":"list_recovery","offset":0,"limit":20}
{"command":"operation_status","operation_id":"<quarantine-plan-id>"}
{"command":"inspect"}
{"command":"prepare_restore","recovery_id":"<selected-recovery-id>","snapshot_id":"<current-snapshot-id>"}
{"command":"confirm","plan_id":"<restore-plan-id>","confirmation":"<restore-plan-id>"}
{"command":"quit"}
```

Skip upgrade if the database is already v2. `prepare_*` only previews. Review each response and obtain the user's explicit choice before sending its confirmation; an AI must not turn an inspection candidate into consent. Matching strings are a protocol check, not proof of human approval. There is no management-session `cancel` command; an unconfirmed plan is not applied and expires or is discarded with the session.

The root collector observes physical identities without reading HTML bodies. It can recognize the same document after a rename/move, but a different identity at the old path, one absent scan, an unavailable root or incomplete observation remains on hold. It never automatically cleans orphan records or downloads Cloud placeholders. Limits are 10,000 entries, depth 32, 4 MiB of metadata and a two-second scan budget.

Plans last five minutes and bind the profile, database/root/document identities, revision, generation and metadata snapshot. Changes consume/reject a stale plan instead of refreshing it implicitly. Repeated successful confirmation within the same session returns its receipt; after restarting, query quarantine/restore with `operation_status`. Upgrade requires a new schema inspection. The session accepts 16 KiB per command, at most 4,096 commands, 16 pending management plans and a 1 MiB response. Inputs use snake_case; result fields use camelCase. Responses are `{"ok":true,"result":...}` or `{"ok":false,"error":...}`; `quit`/EOF exits 0 without a result, while startup/output failures exit 2.

### Portable transfer session

```sh
state-transfer-cli session --profile-dir "<absolute-current-local-data-profile>" --root "<absolute-connected-knowledge-root>"
```

Both paths are required. This session uses the stopped-profile lease and exclusive database connection, supports v1/v2, and does not migrate or repair the profile. A quarantined target must be restored through management first. Export example:

```json
{"command":"inspect","offset":0,"limit":20}
{"command":"prepare_export","document_identity":"<selected-document-identity>","snapshot_id":"<snapshotId>","output_path":"<absolute-new-export.json>"}
{"command":"confirm","plan_id":"<planId>","confirmation":"<planId>"}
{"command":"quit"}
```

Import over an existing record:

```json
{"command":"inspect","offset":0,"limit":20}
{"command":"inspect_target","relative_path":"selected.html"}
{"command":"prepare_import","file_path":"<absolute-export.json>","relative_path":"selected.html","target_identity":"<documentIdentity>","snapshot_id":"<snapshotId>","backup_path":"<absolute-new-before-import.json>"}
{"command":"confirm","plan_id":"<planId>","confirmation":"<planId>","replace_confirmation":"<planId>"}
{"command":"quit"}
```

Use the identity returned by `inspect_target`; the target must be a regular `.html`/`.htm` file. If no target record exists, omit `backup_path` and `replace_confirmation`; unnecessary backup selection is rejected. These optional commands discard a pending plan or compare a portable file with the current target after reopening a session:

```json
{"command":"cancel","plan_id":"<planId>"}
{"command":"verify_import","file_path":"<absolute-export.json>","relative_path":"selected.html","target_identity":"<current-document-identity>"}
```

Transfer follows the plaintext, backup-before-replacement, no-overwrite and lost-response rules above. It binds plans to the input file identity/hash and target/root/database snapshot; five-minute expiry or any change requires a new preview. It allows eight pending plans, 16 KiB per command, 4,096 commands and 1 MiB responses. Open input descriptors, including rejected aliases, are retained for SQLite lock safety, with a limit of 128 opens per session; quit and start a new session when exhausted. Saved values go only into selected files, never the metadata response. Do not use the stopped CLI while the app is running; the app's live UI uses its own existing connection and lifecycle gate.
