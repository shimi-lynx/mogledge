# HTML document state storage

HTML mini apps can persist JSON input state separately from Mogledge's search index. The same asynchronous adapter works in an ordinary browser. It preserves the iframe sandbox and document-scoped permissions; it exposes no arbitrary Native IPC, SQL, filesystem paths or parent-window access.

From 0.9.0, dedicated-folder HTML uses a static `mogledge-document-id` UUID as its logical saved-input identity. Rename, hierarchy changes, movement between dedicated folders, restart and atomic replacement preserve input when that UUID is retained. Physical root/file identity still constrains every permission grant. Normal UUID restoration is automatic; missing, malformed, multiple or detected duplicate IDs hold saving rather than succeeding with empty state. The current workflow does not discover or inherit legacy physical records; existing records and backups remain intact. See [dedicated folders](registered-folders.md). The [earlier Mac identity record](macos-storage-identity.md#normal-mac-use-from-072) describes pre-UUID data and historical QA; it does not establish Native Mac verification of this change.

## Create or convert an HTML

Follow the repository's [HTML authoring skill](../.agents/skills/mogledge-html/SKILL.md). Mogledge requires no AI API or external service.

```sh
node scripts/build-knowledge-html.mjs .agents/skills/mogledge-html/assets/generated-sample.json tests/fixtures/knowledge/Storage/Generated.html
node scripts/build-knowledge-html.mjs .agents/skills/mogledge-html/assets/converted-sample.json tests/fixtures/knowledge/Storage/Converted.html
```

The generator accepts JSON with `title`, `body`, `script`, optional `style` and optional `documentId`. It inserts exactly one static `<meta name="mogledge-document-id" content="UUID">`. Explicit `documentId` accepts a canonical hyphenated non-nil UUID and normalizes hex case. When omitted, a new output gets `crypto.randomUUID()` v4; an existing output retains its valid UUID. Existing missing, malformed or multiple IDs and conflicting explicit IDs are refused before writing. Preserve `documentId` explicitly when regenerating an existing logical document to a new output. Choose a fresh ID only for an independent document, and never rotate IDs as a restore-error workaround. It inlines the canonical `assets/storage.js`, `assets/export.js` and `assets/template.html`. Generation uses the repository's Vite+ formatter and installed development dependencies. The resulting file runs outside the repository without npm, sibling scripts or network dependencies. The generator embeds trusted author-supplied HTML/JavaScript; it is not a sanitizer.

`Generated.html` demonstrates number, select and checkbox inputs. `Converted.html` converts the [legacy localStorage calculator](../.agents/skills/mogledge-html/assets/legacy-localstorage.html) to asynchronous restore/save. In an ordinary browser, its explicit import button maps the old `legacy-calculator-state` fields `number`/`operation`/`active` to `amount`/`mode`/`enabled`, preserving the old value. Browser state is not automatically imported into Native storage. Transparent compatibility with arbitrary direct localStorage code is outside this API.

The canonical JavaScript `appId`/`schemaVersion` API is unchanged and cannot select a document UUID. Native reads the static source metadata. A dedicated-folder ID is not part of the storage key; moving a logical document between registered dedicated folders retains its UUID and input. Preserve it across edits, rename/move, root changes, reboot and atomic replacement. A different file with a copied UUID requires the main app's explicit share-or-new choice; independent documents need new UUIDs. Missing metadata remains viewable but requires an explicit main add-ID action for Native storage; missing, malformed or multiple UUIDs block storage and preserve saved values. Deliberately copied UUIDs can share data within this PC/profile; they are not secrets or protection against approved HTML and do not synchronize across PCs.

For user-requested export of generated images, tables or text, use the separate [artifact export API](html-artifact-export.md). It does not export saved input state.

## JavaScript API

```js
const storage = MogledgeStorage.create({ appId: "calculator", schemaVersion: 1 });
const saved = await storage.read(); // JSON data, or null if no value is saved
// Validate and restore before calculating or enabling event-driven saves.
await storage.write({ amount: 12, mode: "double", enabled: true });
await storage.flush(); // Confirm completion before reporting a save or reloading.
```

New templates use `MogledgeStorage`. `MyKnowledgeStorage` remains an alias for existing inline HTML; it does not import an old profile or browser key. Preserve the document UUID, appId and schema when updating an existing file, and verify restoration before enabling saves.

| Method                             | Contract                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create({ appId, schemaVersion })` | Synchronously returns an adapter. `appId` is 1–80 ASCII letters, digits, dots, underscores or hyphens. `schemaVersion` is a positive safe integer. Invalid values throw `StorageError`.                           |
| `read()`                           | Returns a Promise of JSON data or `null`. A different saved schema rejects with `schema_mismatch` without deleting state. The author validates the application's data shape.                                      |
| `write(data)`                      | Returns a Promise of a revision. Takes a JSON snapshot before queuing, so later caller mutations cannot change it. Undefined data, circular structures and other invalid JSON inputs reject with `invalid_value`. |
| `remove()`                         | Deletes only this appId's state and returns a Promise of a revision. Other apps/documents remain intact.                                                                                                          |
| `flush()`                          | Waits for operations already submitted to this adapter. An unresolved failure rejects again until a successful write or remove clears it. It excludes the author's debounce timer and work not yet submitted.     |

API v1 consists of these asynchronous operations and the JSON envelope below. An incompatible future API needs a separate version. Unsupported Native descriptors must not trigger browser fallback. Authors must design explicit schema migrations; schema mismatch must not delete existing values.

One adapter executes reads, writes and removes in call order. Consecutive writes that have not started can coalesce to the latest snapshot; all their Promises resolve with that commit's revision. An executing write is not cancelled, and reads, removes and flushes are barriers. One resolved write does not confirm a later pending write. For rapid input, the sample's 100 ms debounce is a starting point. Save must cancel its timer, submit the latest value, and await both `write()` and `flush()`. Prevent editing while saving/reloading, or track input generations so an older success cannot label newer input as saved.

Disable editing while initial read is pending. Validate and restore before calculation or automatic saves. If initial read, schema or data validation fails, preserve saved values and disable saving; local calculation can remain available. Never write defaults over unverified state. On later failures, retain inputs and calculations, display the error and mark input unsaved. Asynchronous `unload`/`beforeunload` handlers and abnormal termination cannot guarantee save completion.

Adapter codes include `storage_unavailable`, `quota_exceeded`, `invalid_key`, `invalid_schema`, `invalid_value`, `invalid_response` and `schema_mismatch`. Native endpoint codes are returned unchanged: `InvalidRequest`, `StorageUnavailable`, `Revoked`, `IdentityChanged`, `QuotaExceeded`, `CapacityExceeded`, `ResourceUnavailable`, `StorageCorrupt`, `StorageBusy` and `MethodNotAllowed`.

## Native transport

Mogledge injects a frozen `globalThis.__MOGLEDGE_STORAGE_V1__` before original scripts, without changing the source HTML.

The old `__MY_KNOWLEDGE_STORAGE_V1__` descriptor and `__my_knowledge_storage_v1__` route are compatibility aliases to the same frozen grant and validated endpoint. They do not widen authority or select an old database. Authors use the canonical adapter instead of naming either route directly.

```js
// Injected by the app; authors do not construct URLs or tokens.
{ version: 1, endpoint: "<absolute HTTP URL for this view>", available: true, maximumDocumentBytes: 1000000000 }
```

`maximumDocumentBytes` is runtime SQLite document capacity, **not the configured quota**. The example's 1,000,000,000 bytes reflects the bundled connection's row capacity; authors must not hardcode it. The canonical adapter accepts positive safe-integer bytes. Older descriptors without the field and ordinary browsers retain a 5 MiB precheck. An invalid field fails closed. Do not add HTTP quota queries or a client quota cache: Native checks current quotas, capacity and resources for every operation.

A present descriptor selects Native HTTP only. `available: false`, unsupported descriptors, network errors, quota failures and revocation never fall back to localStorage. This prevents split state and writes to an unintended destination. Tokens grant access only to their served document/view, not other documents or parent IPC. Closing a view or revoking its grant invalidates its token.

Requests use `POST` with JSON:

```json
{
  "version": 1,
  "op": "write",
  "key": "calculator",
  "value": { "schemaVersion": 1, "data": { "amount": 12 } }
}
```

Operations are `read`, `write` and `delete`; read/delete omit `value`. Success returns `{"version":1,"value":<saved envelope or null>,"revision":<integer>}`. Non-2xx failure returns `{"version":1,"error":<stable code>}`. Invalid requests return 400, revoked/changed identity 403, size limits 413, busy 409, unavailable/corrupt/resource failure 503, and unsupported methods 405. Changing the endpoint grants no arbitrary path or SQL access.

State resides in `document-state/state.sqlite` under app local-data, independently of `search-index`. SQLite uses a DELETE rollback journal, `synchronous=FULL` and a 250 ms busy timeout. Success follows confirmed durable commit. Removing the last appId retains an identity/revision record. Moving HTML to trash and rebuilding the search index do not delete this database. See [data management](data-management.md) for explicit administration and backup.

Multiple views use the last successful server commit. Revisions confirm document commit order; they are not merge or compare-and-swap. Other views receive no automatic change notification and must read again when needed.

## Quotas and capacity

One MiB is 1,048,576 bytes. Logical document size is the server-serialized UTF-8 JSON of its entire map:

```json
{ "calculator": { "schemaVersion": 1, "data": { "amount": 12 } } }
```

Count all appIds, keys, schema/data envelopes, JSON syntax and escaping, rather than characters or one appId's raw data. Each appId does not get a separate document allowance. Updates subtract old map bytes and add new map bytes; deletes count the reduced map. An empty document retains the two bytes of `{}` and its revision record.

| Limit                                       | Default and scope                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Active JSON per physical document           | Default 5,242,880 B; whole-MiB steps from 1,048,576 to 9,007,199,253,692,416 B |
| Active JSON across all roots in one profile | Default 536,870,912 B; same range, at least the document limit                 |
| AppIds per document                         | 128; fixed                                                                     |
| Historical active identities                | 4,096; fixed                                                                   |
| Internal recovery area                      | Separate 512 MiB / 4,096 entries, including restored copies; fixed             |

The setting range keeps byte conversion within JavaScript safe integers. It is not actual capacity, memory reservation or a free-disk guarantee. Changes apply without restart to subsequent Native writes/imports/restores. Lowering total below active usage, or document below the largest active/recovery document, is rejected without changing values/settings; equality is allowed. Recovery totals are separate, but restore rechecks current active/document/count limits. A document above 512 MiB cannot be quarantined into recovery even when ordinary saving is allowed; refusal preserves its active value.

Active totals include old identities across all roots, including retained physical records that the UUID workflow no longer inherits. Atomic replacement with a preserved UUID uses the existing logical record. Removing every appId does not reduce identity count. At the count limit, writes/handoffs requiring a new record reject with `QuotaExceeded`. Document tokens have no cleanup/quarantine/restore authority. No automatic garbage collection, permanent purge or VACUUM operation is provided.

Logical totals differ from physical database size. Pages, indexes, free pages, journals, recovery copies and independent backups require disk capacity. Deletion need not shrink the database immediately. Failed transactions preserve values, revisions and accounting. `QuotaExceeded`, `CapacityExceeded` (including SQLite FULL/TOOBIG) and `ResourceUnavailable` (including allocation failure) are distinct. Administration uses corresponding `capacity_exceeded` / `resource_unavailable` diagnostics. A single-app precheck cannot guarantee a successful whole-document commit.

### Explicit settings and older-app compatibility

Only trusted main UI can call `get_storage_limits` / `set_storage_limits`. Requests bind to current Native `{viewId, workspaceId}`, limits revision and database generation. HTML HTTP remains read/write/delete; no settings IPC or SQL is exposed.

Under the lifecycle gate, database mutex and SQLite IMMEDIATE transaction, Native rechecks usage/revision/generation and commits setting revision and database generation together. Stale requests are refused; read current values again. Failure rolls back state/settings. A lost response requires reconciliation, not automatic reapplication.

Settings use the existing optional `storage_limits` table and strictly validated capped/wide whole-MiB DDL. Absent-table reads return 5 / 512 MiB. Reads and same-value writes preserve format without creating/rebuilding the table. The main-only snapshot and set request retain integer `documentMiB` / `totalMiB` fields. UI decimal units use powers of 1,000, accept only exact whole-MiB quantities and preserve stored bytes. This display/editor correction introduces no new DDL, migration or IPC shape; Native JSON accounting and adapter budgets are unchanged.

The first different setting that creates a table or rebuilds older DDL requires an **independent whole-profile backup and explicit acknowledgement of older-app incompatibility**. Format/settings change in one transaction without changing `user_version` v1/v2. Older apps rejecting unknown tables/DDL may no longer open the DB. Returning numbers to 5 / 512 MiB does not restore format or compatibility. No table deletion or automatic downgrade is provided. Internal recovery copies are not an independent backup.

The settings snapshot reports separate capabilities:

| Field                  | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `maximumDocumentBytes` | Current `sqlite3_limit(SQLITE_LIMIT_LENGTH, -1)` row/value capacity |
| `maximumRequestBytes`  | Document capacity plus 1 KiB HTTP overhead                          |
| `maximumDatabaseBytes` | Physical page capacity for current DB format/page size              |
| `recoveryBudgetBytes`  | Separate 512 MiB recovery budget                                    |

The bundled SQLite row limit is currently 1,000,000,000 bytes; the new-format page boundary is 4,294,967,294 times actual profile page size. Use connection/page information instead of recreating fixed app limits. Other columns and internal representation consume capacity, so an exact displayed limit is not a save guarantee. Older formats retain physical guards: 1 GiB for v1 without limits table, 2 GiB for older limits table or v2. The acknowledged current numeric DDL uses intrinsic SQLite page capacity. Writers set/read back format-appropriate `max_page_count`; DELETE/FULL remain unchanged.

### HTTP and memory boundaries

HTTP receives at most runtime document capacity plus 1 KiB. The canonical adapter sends UTF-8 `JSON.stringify` output with `value` as an object, without double-encoding. The single-app precheck leaves sufficient request overhead. Actual received bytes count regardless of Content-Length or chunking. Whitespace/redundant `\uXXXX` escapes count even if normalization makes them smaller. Over-budget bodies return 413. Body collection has a 30-second operational timeout; failure returns `ResourceUnavailable` before saving. It is not a quota or overall parse/commit/response deadline.

Admission allows four requests per storage destination. Full admission returns `StorageBusy` before body reading, without an unbounded queue. One processing slot is held from before body collection through parse, commit, response generation and consumption/disposal of the Body and transport slices. Up to three other admitted bodies remain uncollected, avoiding accumulation of four large app-owned bodies/responses. Invalid/revoked tokens are rejected before collection; identity/permission are rechecked under the commit gate. Responses use frames up to 64 KiB without copying their original bytes. Slow bodies/unconsumed responses can occupy processing; no wait-time guarantee follows. Retry explicitly after resolving failure, never via browser fallback.

Raw JSON processing and fallible buffer growth reduce whole-document value trees without preallocating the quota. SQLite TEXT materialization, validation, serialization, renderer and OS/client buffers remain. These limits do not guarantee constant RSS, OOM prevention or arbitrary huge-object support. Transport consumption is not proof of client receipt. A disconnected blocking worker holds its slot until completion. A write with a lost response may have committed: read again rather than assuming it never saved.

Generated Blob export stays separately capped at 5 MiB. HTML/assets and media delivery use separate budgets; none increases the input-state quota.

## File identity and previous input state

In a dedicated folder, exactly one inert source `<meta name="mogledge-document-id" content="UUID">` selects logical state. Canonical hyphenated non-nil ASCII hex UUIDs normalize to lowercase; version/variant bits do not restrict existing IDs. New IDs are v4. Comment text, scripts and template contents do not supply an ID. The logical key hashes a domain and UUID; it contains no folder ID, root identity or path. Source metadata is checked during admission and revalidated with the physical file on storage requests. JavaScript cannot request a UUID namespace through the storage API.

Missing IDs permit viewing, with an explicit main-UI action to add metadata before saving. Invalid or multiple IDs require manual correction. Known different files with the same UUID require an explicit share/new-document choice. New-document decisions create a fresh empty record and preserve old input. Adding/rotating metadata first saves an immutable HTML backup in the configuration profile, then uses guarded conditional replacement. Failure retains old records and backup; existing grants remain held or are revoked, and reopening establishes fresh authority. Edited instructions/HTML are never bulk rewritten.

Registration, folder selection, document opening and document-ID review do not scan saved-state rows to find legacy associations. They do not copy old input, even when a retained row matches the physical file or location. Adding an ID starts a UUID namespace without legacy inheritance; the document-ID UI has no legacy-recovery selector. Existing rows, HTML backups and old catalog fields are retained without rewriting or deletion. Current UUID reads, duplicate decisions, ordinary JSON transfer and administrative quarantine/restore retain their existing guards. Startup DB integrity validation remains enabled; removing legacy discovery does not remove current-data corruption checks. DB schema and quota accounting stay unchanged. Back up configuration records, HTML and the complete saved-input profile together. A copied known UUID is not an authentication mechanism against a malicious author, and this provides no cross-PC DB synchronization.

## Update an HTML or return to an older app

Old inline 64 KiB / 5 MiB / 8 MiB adapters are unaffected by app/quota updates. Regenerate original JSON with current canonical assets into a **new output**, or convert while preserving appId, schema, restore order and errors. Do not substitute a different transport, add Native fallback or bulk-rewrite user HTML/databases.

Preserve original HTML, generation JSON, configuration records and state DB. Verify a dedicated fixture before user-reviewed replacement and preserve its UUID. Pre-UUID input is not inherited by the current UUID workflow; preserve it independently. Ordinary JSON import into a selected current identity remains available with explicit confirmation and replacement backup. Different appId/schema requires a separately designed migration.

Before first saving more than 64 KiB, make an older-compatible backup. Fully stop app/related processes, then copy the entire `document-state` directory and corresponding HTML to a separate safe location. A DB-only copy with unconfirmed shutdown/commit is not consistent. Validate backup/restore on a fixture before real-profile operations.

Older versions used document 64 KiB / total 64 MiB and can reject larger records as `StorageCorrupt`. Schema v1 alone does not imply capacity compatibility. Before rollback, fully stop the app and separately preserve the newer DB/profile and corresponding HTML, then restore the older-compatible backup. Do not use a new large DB in an old app, truncate inputs, reset state or delete the new DB to hide errors. Changed HTML identity may still need confirmed handoff. Post-backup changes are absent from the old backup. See [the update guide](update-guide.md).

## Recovery and transfer

Explicit administrative upgrade adds recovery copies/tombstones in internal DB schema v2; document API/envelope remains v1. New DBs remain v1 and startup does not auto-upgrade. Quarantined identity read/write/delete and previous-state handoff reject with `Revoked` until administrative restore. Restore refuses to overwrite even an empty existing record and increases revision. A v2 DB cannot return to a v2-incompatible app.

Transfer exports one HTML's committed app map and imports into an explicitly selected current identity. Source identity is provenance, not destination authority. Replacing current values needs separate confirmation and a new portable plaintext backup. Transfer does not auto-convert schema, modify HTML or upgrade DB; quarantined identities remain blocked. Live transfer uses main-only prepare/confirm/cancel/reconcile and affected-grant revocation. Reconcile lost responses rather than replaying. See [data management](data-management.md). Real Native picker/WebView and real-user-data QA remain unverified without actual results.

## Ordinary browsers

Only an absent Native descriptor permits localStorage. The key is `mogledge:v1:<encodeURIComponent of document URL without query/hash>:<appId>`. The new adapter neither reads nor rewrites the old `my-knowledge:v1:` namespace; an existing HTML with an old inline adapter retains its original browser behavior until explicitly changed. Native/browser stores are independent. Origin, profile or URL changes change the namespace; URL rename/move creates a new key. Multiple tabs use the last localStorage write, without Native document-wide revision ordering.

localStorage's typical 5 MiB origin allowance counts UTF-16 keys/values, unlike Native UTF-8 map accounting. Other documents, URL keys and version/revision wrapping consume it; the adapter's 5 MiB precheck can still pass before `QuotaExceededError`. Private mode, policy, disabled storage or opaque origin can also deny access. Retain saved values/current input and report errors without changing stores. `file:` behavior depends on browser and needs separate verification from HTTP. Mogledge-served sandbox URLs and standalone files outside the repo are separate cases.

## Verification

```sh
node --test tests/storage/*.test.mjs
```

Focused tests cover canonical generation, restored controls, explicit legacy import, schema failure without overwrite, write coalescing/barriers, repeated flush errors, UTF-8 limits and forbidden fallback. jsdom/mock transport does not establish real WebView or disk durability.

Integration checks include:

- Generated/converted input save/reload, close/reopen and app restart, with calculation comparison.
- Separate roots/documents with the same appId, multiple views, rename/move/copy/replacement, revoked/foreign tokens and index rebuild.
- UUID-preserving replacement with automatic restoration; no legacy-row discovery or inheritance during registration, selection, review or opening; old-row and HTML-backup retention; refusal to overwrite current targets or recover via document API.
- Unavailable storage, quota/schema errors, corrupt responses and revoked grants while keeping input; explicit retry and flush failure.
- Rapid updates and immediate reload/close after save, without success for unconfirmed writes.
- Standalone HTTP and `file:` separately, with no fallback after present Native descriptors fail.
- Save counts, latency, CPU and memory under stated input/view/build conditions; no permanent timer or per-frame writes.

Record Chromium, Windows WebView2 and macOS WKWebView separately. Browser/harness success cannot replace Native QA. Small-form results do not establish large-state performance, crash durability or maximum capacity. See [testing](testing.md) and [known limitations](known-limitations.md).
