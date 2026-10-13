# Mogledge HTML authoring guide

Kit version 1 · Document storage API v1 · Artifact export API v1

The adjacent `template.html` is a complete example with saved-input restoration. Copy it to a new output and adapt its inputs, presentation and calculations. Authoring and execution need no Mogledge source repository, npm, external scripts or network assets. These instructions apply only to the requested HTML; the user's existing policies and explicit instructions take precedence.

## Start from the complete template

1. Read this guide and the adjacent [template.html](template.html). Copy the complete HTML into a **new output file chosen by the user**. Keep the kit template unchanged, so ownership checks remain meaningful. Do not overwrite an existing HTML, instruction file or saved state to get started.
2. Choose the fields to persist and a stable `appId`. Use ASCII letters, digits, dot, underscore or hyphen, 1–80 characters. The supplied calculator uses `generated-calculator`; give a different app in the same document its own identifier. Keep `appId` and `schemaVersion` unchanged when modifying an existing app unless you design an explicit migration.
3. Keep the first two inline scripts, which define `MyKnowledgeStorage` and `MyKnowledgeExport`, intact and in order. Change only the last script's UI, validation, restore and calculation functions for the requested app. Do not reimplement the transport or add a CDN, sibling JavaScript dependency, direct Native IPC, parent-window access, filesystem access or sandbox relaxation.
4. Restore and validate the saved data **before calculation or event-driven saves**. The template disables editing while restoration is pending. When restoration fails, it permits local calculation but disables saving and does not write defaults. Retain this ordering when changing the UI.
5. Save into the selected HTML output. The result must run as one complete HTML file without the kit present. Use text labels, status feedback and keyboard-accessible controls. Preserve user-entered text, filenames and paths as data; do not evaluate them as code or insert them with `innerHTML`.

## Storage API

```js
const storage = MyKnowledgeStorage.create({ appId: "my-mini-app", schemaVersion: 1 });
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

Native defaults are **5 MiB per physical document / 512 MiB of active JSON across all roots in one app profile**. Only the main app settings can explicitly select document and active-total limits of 1–8,589,934,591 whole MiB, total at least document. This range keeps the byte conversion within JavaScript safe integers; it is not a promise that the runtime can save that much. Count the entire document’s UTF-8 JSON: all appIds, keys, schema/data envelopes and escaping. Keep 128 appIds per document and 4,096 active historical identities. Internal recovery copies retain their separate 512 MiB / 4,096-entry budget. Quarantining a single document above 512 MiB is safely refused with the active value preserved; that is not the normal-write document limit. Lower limits below active usage or the largest active/recovery document are refused without truncation or copy deletion. Logical quotas do not reserve memory or guarantee database, journal, backup or free-disk capacity.

The new Native descriptor’s `maximumDocumentBytes` is the **runtime SQLite document capacity**, not the configured quota. Keep the canonical adapter intact: it accepts a positive safe-integer byte capacity and checks a single-app envelope, while Native checks the complete document, current quotas, SQLite capacity and resources on commit. `QuotaExceeded`, `CapacityExceeded` and `ResourceUnavailable` are distinct failures that preserve previous saved values. The main settings snapshot also reports request, physical database and separate recovery capacities; large logical settings do not override them. No extra HTML HTTP query, cached quota or restart is needed. Legacy descriptors without this field and normal browsers keep 5 MiB; invalid fields fail closed and browser origin quotas may reject smaller values. HTML has no permission to change limits.

Reading defaults or applying unchanged limits preserves the existing table format and saved values. The first different setting creates a limits table or rebuilds an old 8 / 1024 MiB numeric DDL in the same transaction. Both need an independent compatible whole-profile backup and explicit old-app compatibility acknowledgement. Returning to 5 / 512 does not remove the table or restore the old DDL/compatibility. Do not delete tables or downgrade a database. Existing 8 MiB / 5 MiB / 64 KiB inline adapters are not updated by app or quota changes: preserve originals, input and schema, explicitly regenerate to a new output using the approved current template, then verify before user-reviewed replacement. Atomic replacement can change identity and needs the main app’s explicit input-state handoff. Store input JSON, not embedded assets or HTML source. Generated-file Blob export remains separately limited to 5 MiB.

## Export generated files separately from saved input

`MyKnowledgeStorage` persists the mini app's input JSON. To write a generated image, table or text file, use the separate `MyKnowledgeExport.exportArtifact({ blob, name, format })` API from the second canonical adapter. It does not export the input-state database or HTML original. Keep both adapters intact; do not copy their transport into the final UI script.

```js
exportButton.addEventListener("click", () => {
  const blob = new Blob(["item,value\nresult,42\n"], { type: "text/csv;charset=utf-8" });
  MyKnowledgeExport.exportArtifact({ blob, name: "result", format: "csv" })
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

Preserve the original HTML and data before changing its save schema or file identity. Replacement by an editor's atomic save can create a new physical identity in Mogledge: old values are kept but do not transfer automatically. Avoid startup default writes. If appropriate, use the main app's **Restore previous input state** confirmation for the replacement HTML; existing current state is not overwritten. Renaming or moving an HTML and copying it are different operations. Do not simulate identity or bypass access checks.

An old HTML with an older inline adapter does not gain a new adapter just because the app was updated. Preserve its appId/schema and initialization order when updating it. Browser localStorage migration requires explicit import, value validation and preservation of the old record. Do not silently migrate browser state to Native, delete an old key, truncate oversized JSON or downgrade a database. Before large-state use or app rollback, make a compatible backup while the app is fully stopped.

## Verify the finished file

Use an isolated fixture, not the user's production folder or profile. Record what was actually tested:

- Open the output via normal HTTP in a browser, change each input/select/checkbox, explicitly Save, reload and verify restored values and calculation. Separately check `file:` access if needed; denied persistence is a failure, not success.
- With a fake Native descriptor, verify read → validate → restore → calculate ordering, then write/flush → reopen restoration. A denied read, malformed data or mismatched schema must never cause a write of defaults. A denied write must keep the latest input, report the error and never touch localStorage.
- If export is included, verify a real button gesture, the five-format/5 MiB limits, cancellation and unknown results without automatic retry, and no browser download after a present Native bridge fails. A normal-browser download request is not a persistence success. Preserve the input while exporting.
- When an existing Mogledge app is available, test the new fixture there: input → Save → reload, close/reopen and app restart. Real WebView/OS/IME behavior remains unverified if only a mocked descriptor or browser was used. Do not build or modify the app merely to author an HTML unless that work was requested.

## AI instructions and optional setup

The kit can include project-local Codex and Claude Code skills. Start the AI in the same selected root and ask it to read this guide plus `template.html`. If automatic skill discovery is unavailable, explicitly name the installed `SKILL.md`; no global installation or agent configuration change is necessary. File placement does not prove an AI has loaded the instructions.

Setting up a kit is separate from an ordinary app build. A build assistant explains the selected root and asks which of these the user wants: **(1)** guide and complete template, **(2)** Codex and Claude skills, **(3)** optional instruction to read the guide in future AI handoffs. Perform only explicitly confirmed choices; do not infer permission to write a user root from an app build request. Reuse an already explicit consent for the same root and choices. Existing AGENTS.md, AGENTS.local.md, CLAUDE.md and unrelated skills remain unchanged. Initial setup creates new files only and can recognize unmodified, same-version manifest-owned files as current. Existing older or edited files are retained, skipped and reported. Updating them requires separate preservation and manual review; setup does not replace them. Turning guide inclusion off does not delete the kit or undo a draft already handed to another app.

## Discovery references

Codex's official skill roots implementation scans project `.agents/skills` folders; Claude Code documents `.claude/skills/<name>/SKILL.md` for project skills. Both installed entries use YAML `name` and `description` plus Markdown instructions. Policies, versions and the AI's current folder affect discovery; explicit reading is the fallback.

- [Codex skill roots implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)
- [Codex skills documentation](https://developers.openai.com/codex/skills/)
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)

<!-- Generated kitVersion=1 storageAPI=1 adapterSHA256=003ee32cb366f035c37671786e44fba9419d4f19e94838ef3e4f77d36d8c4a6c canonicalTemplateSHA256=ed9dabe307d98404587c2e9f6142dc58fcfce1dd38458d80c4c3f1ab25742b3f apiSpecSHA256=00927e662b77366639bd7781af3cee60e23561c1575b5f564d31d94c487b3044 exportAPI=1 exportAdapterSHA256=25f6f49f857ecba33873ec6b85c4d6b5296f227270029a7a668738dbc578eed7 exportApiSpecSHA256=3c361fdda4e90bf9d6b3ece7bbb2feb2ea2c1152ff6386e1d8a0e8be4ea43ee7 -->
