# Mogledge HTML authoring guide

Kit version 3 · Document storage API v1 · Artifact export API v1

The adjacent `template.html` is a complete example with saved-input restoration. Copy it to a new output and adapt its inputs, presentation and calculations. Authoring and execution need no Mogledge source repository, npm, external scripts or network assets. These instructions apply only to the requested HTML; the user's existing policies and explicit instructions take precedence.

## Start from the complete template

1. Read this guide and the adjacent [template.html](template.html). Copy the complete HTML into a **new output file chosen by the user**. For a new independent document, replace its `REPLACE_WITH_NEW_UUID` placeholder in the `mogledge-document-id` meta content with a fresh UUID v4 from `crypto.randomUUID()` using an authoring tool; do not add runtime UUID generation to the HTML. Keep the kit template unchanged, so ownership checks remain meaningful. Do not overwrite an existing HTML, instruction file or saved state to get started.
2. Choose the fields to persist and a stable `appId`. Use ASCII letters, digits, dot, underscore or hyphen, 1–80 characters. The supplied calculator uses `generated-calculator`; give a different app in the same document its own identifier. Keep `appId` and `schemaVersion` unchanged when modifying an existing app unless you design an explicit migration.
3. Keep the first two inline scripts, which define `MogledgeStorage` and `MogledgeExport`, intact and in order. Change only the last script's UI, validation, restore and calculation functions for the requested app. Do not reimplement the transport or add a CDN, sibling JavaScript dependency, direct Native IPC, parent-window access, filesystem access or sandbox relaxation.
4. Restore and validate the saved data **before calculation or event-driven saves**. The template disables editing while restoration is pending. When restoration fails, it permits local calculation but disables saving and does not write defaults. Retain this ordering when changing the UI.
5. Save into the selected HTML output. The result must run as one complete HTML file without the kit present. Use text labels, status feedback and keyboard-accessible controls. Preserve user-entered text, filenames and paths as data; do not evaluate them as code or insert them with `innerHTML`.

The bundled template deliberately uses `REPLACE_WITH_NEW_UUID`, which cannot save in Native until replaced with a valid unique UUID. Never reuse that placeholder or a fixed example UUID in finished independent documents.

## Logical document identity

Keep exactly one static `<meta name="mogledge-document-id" content="UUID">` in the HTML head. Its value must be a canonical hyphenated non-nil UUID; lowercase is preferred. Preserve it when editing, regenerating, renaming, moving between roots or atomically replacing the same logical document. Native reads this source metadata; the JavaScript API cannot select another UUID.

A copied HTML retains its UUID. The main app requires an explicit share-or-new-document choice for a different file with the same UUID. Confirm sharing only when the files should use the same input; assign a fresh UUID for independent data. Within this PC's app profile, a deliberately copied UUID can share data, so do not treat it as a secret or an access boundary against other approved HTML. This is not cross-PC synchronization. Ordinary-browser storage still follows URL and appId.

HTML without metadata remains viewable, but Native saving requires the main app's explicit action to add an ID. Missing, malformed or multiple IDs block Native storage without deleting saved input. Never silently replace an invalid UUID or write defaults after a failed restore. The UUID workflow does not discover or inherit legacy physical records. Existing records and backups remain intact; there is no legacy-recovery selector in the document-ID UI. Ordinary JSON import into a selected current identity remains available with explicit confirmation and replacement backup.

## Storage API

```js
const storage = MogledgeStorage.create({ appId: "my-mini-app", schemaVersion: 1 });
const saved = await storage.read(); // JSON data, or null when no state is saved
// Validate the application's own data shape and restore it before calculations.
await storage.write({ amount: 12, mode: "double", enabled: true });
await storage.flush(); // Confirm all operations already given to this adapter.
```

| Method                             | Contract                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create({ appId, schemaVersion })` | Synchronously creates the adapter. `schemaVersion` is a positive safe integer. Invalid identifiers or schema values throw a `StorageError`.                                                          |
| `read()`                           | Resolves to application JSON data or `null`. A different saved schema rejects with `schema_mismatch` and preserves the saved value. Validate your own fields as well.                                |
| `write(data)`                      | Resolves to a revision after persistence. JSON snapshotting isolates pending writes from later mutations. Undefined values and circular structures reject with `invalid_value`.                      |
| `remove()`                         | Explicitly removes only this appId's state. Do not call it to conceal restore errors or as startup initialization.                                                                                   |
| `flush()`                          | Waits for previously queued adapter operations. It does **not** include an application's pending debounce timer. An unresolved failure keeps rejecting until a successful write or remove clears it. |

For a Save button, cancel any pending debounce timer, call `await write(latestState)` and then `await flush()`. Show “saved” only after these succeed. Prevent editing while saving and reloading, or track input generations so an older success cannot mark newer inputs as saved. Avoid many writes for rapid input; the template's 100 ms debounce is a starting point. Do not promise that asynchronous unload or abnormal termination finishes saving.

## Native and normal browser behavior

Mogledge injects a document-specific descriptor before the scripts. The canonical adapter detects it and uses only that document's Native HTTP endpoint. Authors do not create or alter its endpoint or token. Presence of a descriptor selects Native transport even if it is unavailable: **a failed Native read/write must never silently fall back to localStorage**.

A normal browser without that descriptor uses its own localStorage, separated by document URL and appId. This does not import or share the Native database. Moving a browser HTML to another URL changes its storage namespace. `file:` URLs, browser policy, private mode or quota can deny storage. Display the error and keep the input; do not announce success or switch to another hidden store.

Handle `StorageError.code` and retain useful diagnostics. Adapter errors include `storage_unavailable`, `quota_exceeded`, `invalid_key`, `invalid_schema`, `invalid_value`, `invalid_response` and `schema_mismatch`. Native errors can include `InvalidRequest`, `StorageUnavailable`, `Revoked`, `IdentityChanged`, `QuotaExceeded`, `CapacityExceeded`, `ResourceUnavailable`, `StorageCorrupt`, `StorageBusy` and `MethodNotAllowed`. A failed initial read or data validation must leave saved state untouched and prevent subsequent automatic writes. A failed later write must retain the user's latest input and show that it is unsaved.

Native defaults are **5 MiB per logical document / 512 MiB of active JSON across all roots in one app profile**. Only the main app settings can explicitly select document and active-total limits of 1–8,589,934,591 whole MiB, total at least document. This range keeps the byte conversion within JavaScript safe integers; it is not a promise that the runtime can save that much. Count the entire document’s UTF-8 JSON: all appIds, keys, schema/data envelopes and escaping. Keep 128 appIds per document and 4,096 active historical identities. Internal recovery copies retain their separate 512 MiB / 4,096-entry budget. Quarantining a single document above 512 MiB is safely refused with the active value preserved; that is not the normal-write document limit. Lower limits below active usage or the largest active/recovery document are refused without truncation or copy deletion. Logical quotas do not reserve memory or guarantee database, journal, backup or free-disk capacity.

The new Native descriptor’s `maximumDocumentBytes` is the **runtime SQLite document capacity**, not the configured quota. Keep the canonical adapter intact: it accepts a positive safe-integer byte capacity and checks a single-app envelope, while Native checks the complete document, current quotas, SQLite capacity and resources on commit. `QuotaExceeded`, `CapacityExceeded` and `ResourceUnavailable` are distinct failures that preserve previous saved values. The main settings snapshot also reports request, physical database and separate recovery capacities; large logical settings do not override them. No extra HTML HTTP query, cached quota or restart is needed. Legacy descriptors without this field and normal browsers keep 5 MiB; invalid fields fail closed and browser origin quotas may reject smaller values. HTML has no permission to change limits.

Reading defaults or applying unchanged limits preserves the existing table format and saved values. The first different setting creates a limits table or rebuilds an old 8 / 1024 MiB numeric DDL in the same transaction. Both need an independent compatible whole-profile backup and explicit old-app compatibility acknowledgement. Returning to 5 / 512 does not remove the table or restore the old DDL/compatibility. Do not delete tables or downgrade a database. Existing 8 MiB / 5 MiB / 64 KiB inline adapters are not updated by app or quota changes: preserve originals, input and schema, explicitly regenerate to a new output using the approved current template, then verify before user-reviewed replacement. Preserve the document UUID during regeneration and atomic replacement. Store input JSON, not embedded assets or HTML source. Generated-file Blob export remains separately limited to 5 MiB.

## Export generated files separately from saved input

`MogledgeStorage` persists the mini app's input JSON. To write a generated image, table or text file, use the separate `MogledgeExport.exportArtifact({ blob, name, format })` API from the second canonical adapter. It does not export the input-state database or HTML original. Keep both adapters intact; do not copy their transport into the final UI script.

```js
exportButton.addEventListener("click", () => {
  const blob = new Blob(["item,value\nresult,42\n"], { type: "text/csv;charset=utf-8" });
  MogledgeExport.exportArtifact({ blob, name: "result", format: "csv" })
    .then((result) => {
      status.textContent =
        result.status === "saved"
          ? "Saved"
          : result.status === "cancelled"
            ? "Cancelled"
            : "Download requested";
    })
    .catch(() => {
      status.textContent =
        "Export could not be confirmed. Keep the input and check the selected destination.";
    });
});
```

Only five formats are supported: `png`, `jpeg`, `csv`, `json` and `text`. Pass a non-empty Blob of at most **5 MiB (5,242,880 bytes)**, a proposed name of at most 1,024 UTF-8 bytes (prefer a name without its extension), and the format. Do not pass URLs, filesystem paths or Native IDs. Do not truncate data to fit or disguise SVG, HTML or executable content as an image. Native image signature checks do not prove the whole content safe; consider CSV formulas before opening the output in another app. Each adapter admits one operation at a time, with a one-second start interval including cancellation and failure.

Call the API directly from a real click or keyboard activation: it checks user activation synchronously. Do not call it from a timer, initialization, automatic save or synthetic click. Prepare an asynchronous Canvas Blob beforehand and only then enable an export button. In Mogledge, an independent main confirmation precedes the OS destination picker and new-file save; existing files are not overwritten or opened automatically. `saved` confirms the Native result, `cancelled` is an explicit cancellation, and `download-requested` means only that a normal browser received a download request, not that a file was saved.

**Browser download is available only when the injected export bridge is absent.** A present bridge that is unsupported, revoked, denied or failed must never fall back to download. Unknown communication results, `ArtifactPublishedUnconfirmed` or `ArtifactResultUnknown` can leave a file at the selected destination: retain inputs, report uncertainty, ask the user to check that destination and never automatically retry. A timeout does not prove that no file was written. Keep input-state saving and generated-file export controls and feedback distinct.

## Local audio, video and timer sounds

Use standard `<audio>` / `<video>` with relative paths to `.mp3` / `.mp4` assets inside the selected allowed root, for example `assets/sound.mp3` or `assets/movie.mp4`. Keep the HTML and relative assets together for normal HTTP-browser use; a media app with sibling files is not a self-contained single-file artifact. Do not insert storage adapters into media, store binary media in input JSON, or use file-export transport for playback. Start playback from a user's click. For a WebAudio timer sound, create/resume `AudioContext` in that click before scheduling; background, hidden-window and OS-sleep delivery is not guaranteed.

Mogledge serves media files up to **1 GiB (1,073,741,824 bytes)** with bounded single-range responses up to **2 MiB (2,097,152 bytes)**. It supports `bytes=start-end`, `bytes=start-` and `bytes=-suffix`; a 206 response may be a bounded subset of the request, so verify that the playback engine requests the remaining data. Invalid, multiple or out-of-range ranges are rejected. A GET without Range is accepted only up to 2 MiB; larger requests return 413. Unknown Range units and `If-Range` use this same ordinary-GET limit. Avoid fetching or caching a whole large file in JavaScript.

MP3/MP4 MIME and bounded HTTP delivery do not guarantee a codec or successful playback. Windows WebView2 / macOS WKWebView codecs, audio devices and real Native playback remain unverified until tested there. Do not loosen CSP, sandbox, root/path or permission boundaries, auto-fetch unavailable cloud files, or claim a Chromium check proves Native support. YouTube and other external pages remain external-browser-only; do not add an embedded iframe or remote media/CDN exception. Verify click playback, seeking, HTTP errors and the same relative assets in an isolated normal-browser fixture and record actual Native checks separately.

## Editing an existing HTML

New adapters expose `MogledgeStorage` and `MogledgeExport`. The main app retains old `MyKnowledgeStorage`/`MyKnowledgeExport` globals, descriptors and transport aliases for existing HTML through the same guarded authority. New browser persistence uses `mogledge:v1:` and does not read old browser keys. The `com.shimilynx.mogledge` app profile is separate from older identifiers; API compatibility does not transfer settings or saved input between profiles. Preserve old data for a separately requested transfer instead of assuming a missing new-profile value proves that no old data exists.

Preserve the original HTML, its document UUID and saved data before changing its save schema. An editor's atomic save preserves logical identity when the static UUID remains unchanged. Rename/move and root switching also preserve that UUID. A new independent copy needs a fresh UUID; a deliberate shared copy needs the main app's sharing choice. Avoid startup default writes and do not infer ownership of old input from a matching filename or physical identity. Do not bypass access checks or silently rotate IDs.

An old HTML with an older inline adapter does not gain a new adapter just because the app was updated. Preserve its appId/schema and initialization order when updating it. Browser localStorage migration requires explicit import, value validation and preservation of the old record. Do not silently migrate browser state to Native, delete an old key, truncate oversized JSON or downgrade a database. Before large-state use or app rollback, make a compatible backup while the app is fully stopped.

## Verify the finished file

Use an isolated fixture, not the user's production folder or profile. Record what was actually tested:

- Open the output via normal HTTP in a browser, change each input/select/checkbox, explicitly Save, reload and verify restored values and calculation. Separately check `file:` access if needed; denied persistence is a failure, not success.
- With a fake Native descriptor, verify read → validate → restore → calculate ordering, then write/flush → reopen restoration. A denied read, malformed data or mismatched schema must never cause a write of defaults. A denied write must keep the latest input, report the error and never touch localStorage.
- If export is included, verify a real button gesture, the five-format/5 MiB limits, cancellation and unknown results without automatic retry, and no browser download after a present Native bridge fails. A normal-browser download request is not a persistence success. Preserve the input while exporting.
- When an existing Mogledge app is available, test the new fixture there: input → Save → reload, close/reopen and app restart. Real WebView/OS/IME behavior remains unverified if only a mocked descriptor or browser was used. Do not build or modify the app merely to author an HTML unless that work was requested.

## Dedicated folders and AI instructions

Mogledge supports multiple explicitly registered dedicated folders. Creating a dedicated folder or registering an existing one requires this guide, the complete template, both project-local Codex and Claude Code skills, and the app's `.mogledge/mogledge-folder.json` management marker (`version: 1`, a folder UUID `id`, and `kind: "mogledge-managed-folder"`). The kit ownership manifest is separate at `.mogledge/html-authoring/manifest.json`. Cancellation, conflicts or partial setup do not complete registration. Existing AGENTS.md, AGENTS.local.md, CLAUDE.md, other skills, HTML and assets are preserved; resolve conflicts explicitly without overwriting originals. An ordinary app build does not register folders or authorize writes into a user's folder. Use the main app's managed registration actions, not ad hoc copying over existing instructions.

AI handoff drafts include an instruction to read this guide by default. Start the AI in the same dedicated folder. If automatic skill discovery is unavailable, explicitly name the installed SKILL.md and guide; no global installation or agent configuration change is necessary. File placement does not prove an AI has loaded the instructions. Handoffs are unsent drafts and do not automatically attach file contents or send data to an AI service.

The dedicated-folder ID is not part of the document storage key. Preserve the HTML's document UUID when moving it between registered dedicated folders; this keeps the same logical document and saved input. Unregistering a folder keeps its files, installed kit and saved-input database. Storage remains local to this PC's app profile, without cross-PC synchronization.

## Kit version updates

The main app checks this selected dedicated folder's installed kit version and ownership hashes, including before an AI handoff. App-owned, unchanged older kit files receive a recoverable backup before updating to the bundled kit version. Edited or unowned files and other conflicts are preserved and shown as updates available. A write failure retains the prior version and must not be reported as current. This check does not write to every registered folder in the background or fetch files from the network.

Kit updates change only managed guide/template/Skill resources and their ownership records. They must not modify the user's HTML or saved-input database. Read the latest installed guide when starting or resuming authoring. An already running AI conversation may cache older instructions; updating files does not automatically refresh that conversation, so explicitly ask it to reread the guide and Skill.

Legacy `.my-knowledge` resources and `my-knowledge-html-authoring` skills are compatibility paths only. Canonical resources use `.mogledge` and `mogledge-html-authoring`. Preserve edited legacy guides and skills at their existing paths; install the new canonical resources separately rather than overwriting those originals. Canonical edited/unowned conflicts are still preserved and reported. An old skill path does not make a new guide current: explicitly read the canonical guide and Skill after migration.

## Discovery references

Codex's official skill roots implementation scans project `.agents/skills` folders; Claude Code documents `.claude/skills/<name>/SKILL.md` for project skills. Both installed entries use YAML `name` and `description` plus Markdown instructions. Policies, versions and the AI's current folder affect discovery; explicit reading is the fallback.

- [Codex skill roots implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)
- [Codex skills documentation](https://developers.openai.com/codex/skills/)
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)

<!-- Generated kitVersion=3 storageAPI=1 adapterSHA256=c2bfae0c1cbe1a7b69ab26db41d1c683e5ba85902a4522804b8af39d676a8f90 canonicalTemplateSHA256=0aa018bb2a1158c55500c74d4bbe7b35581f03b184f71be5e6423df99291fa31 apiSpecSHA256=0127b29cd8325c7b981534745c4c623d23d3408ba944f159bd1f272a9f14ee9e exportAPI=1 exportAdapterSHA256=eac02f7dc2164efb93c80ff6d2465417ebc127378c91235a2fac629a39b80f90 exportApiSpecSHA256=c982116914e6ab75a122d9ad044e6d72e1dd86ca9af13e3341a1e18a9dfaf549 -->
