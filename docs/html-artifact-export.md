# Export generated files from HTML

HTML mini apps can export generated images, tables and text through a user action. This is separate from [input-state persistence](document-storage.md) and [saved-state transfer](data-management.md). It does not export the state database or HTML original.

## Author API

Use the [HTML authoring skill](../.agents/skills/mogledge-html/SKILL.md), canonical `assets/export.js` and complete template. The generator inlines both storage and export adapters. Do not hand-copy another transport into individual HTML files. Existing HTML is not automatically rewritten: regenerate its source JSON to a new output and verify it first.

New HTML uses `MogledgeExport` and the `__MOGLEDGE_EXPORT_V1__` descriptor. Existing `MyKnowledgeExport`, old descriptor names and transport messages remain compatibility aliases through the same validated export grant, user-activation check and confirmation flow. They do not add filesystem access or transfer old data.

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
    .catch((error) => {
      // Retain inputs/calculations and do not retry automatically.
      status.textContent = "Export could not be confirmed: " + error.code;
    });
});
```

`exportArtifact({ blob, name, format })` returns a Promise and accepts exactly these three fields. Pass no URL, destination path or Native ID. It synchronously checks `navigator.userActivation.isActive`: call directly from a real click/key activation, never initialization, timer, automatic save or synthetic click. If Blob creation is asynchronous, prepare it with `canvas.toBlob()` before enabling the export button. Do not assume activation survives long processing.

Continue using standard Blob, Canvas, audio and video APIs. Export does not replace media playback/recording or provide a general binary filesystem API. Do not disguise SVG, HTML or executable content as an image. Native image signature checks do not establish whole-image safety. CSV formulas may execute in other applications; check the generated content and where it will be opened. Saved files are not automatically opened or executed.

| Format | Native extension | Native validation                              |
| ------ | ---------------- | ---------------------------------------------- |
| `png`  | `.png`           | PNG signature                                  |
| `jpeg` | `.jpg`           | JPEG starting signature and ending marker      |
| `csv`  | `.csv`           | UTF-8, no NUL                                  |
| `json` | `.json`          | JSON syntax, without constructing a value tree |
| `text` | `.txt`           | UTF-8, no NUL                                  |

The Blob must be non-empty and at most **5 MiB (5,242,880 bytes)**. The proposed name must be non-empty and at most 1,024 UTF-8 bytes. Reject invalid/oversized content rather than truncating it. Prefer a name without an extension: Native sanitizes the proposal to a stem and appends its fixed extension, so a supplied extension becomes part of the stem. Native, document bridge and portable adapter each admit one operation at a time, with a one-second start interval including cancellation/failure.

## Native and browser outcomes

| Environment                                                   | Route                                                                                      | Result                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Mogledge document                                             | Private injected bridge → independent main confirmation → OS destination picker → new file | `{status:"saved",name,bytes}` or `{status:"cancelled"}` |
| Ordinary HTTP/HTTPS/`file:` browser without a bridge          | Standard Blob URL and anchor download                                                      | `{status:"download-requested",name}`                    |
| Present bridge that is unsupported, revoked, denied or failed | Report the error                                                                           | No browser fallback                                     |

A browser download request is not proof that a file was saved. Browser settings and restrictions determine the result. The adapter releases the Blob URL after use. The browser route does not run Native signature/UTF-8 validation or the Native no-replace writer. Its format selects a filename extension, not a safety verdict. Do not use it for SVG, HTML, executable content or arbitrary binary export.

In Mogledge, main confirmation displays the proposal's name, format, bytes and source document. Native is called only after the user chooses **Select destination**. Existing inputs remain intact. The OS-known Downloads directory is a suggested starting point; the user can select another location. Existing destination files are never overwritten, even if the OS picker offers overwrite confirmation. The result exposes only a basename, never the absolute destination path.

## Native permission and destination boundary

Only local main has permission to call `save_html_artifact`. Document iframes and served tokens gain no Tauri IPC, arbitrary path, URL-fetch or general filesystem authority. Main compares the proposal against the currently visible frame/source/token and requires an independent user confirmation. A document's reported gesture is not equivalent to destination approval.

The internal request is `{ context, format, name, data }`, where context is `{ workspaceId, viewId, tabId, request, revision, token }`. Main obtains tabId/request from Native registration; callers do not choose document identity. Native gets it from the current session and compares it to the physical source. Unknown fields/invalid enums are refused; workspaceId/viewId/tabId/token are 64-digit hex identifiers and request/revision are integers. Document or destination absolute paths are not returned to main or the HTML.

Internal data is canonical padded base64 without a data-URL prefix. Decoded bytes are capped at 5,242,880; encoded data at 6,990,508 ASCII bytes. Both limits are checked without truncation. JSON validation does not write to the state database, and UTF-8 text is not translated.

The Core allows one export flight and a one-second cooldown without a permanent timer or queue. While waiting for the picker it holds the flight, not a lifecycle gate or thread-bound metadata scope. The decoded buffer is bounded to 5 MiB; base64/IPC wrapping and Canvas bitmap/encoder allocations are separate. This is not an app-wide memory bound.

Native replaces controls/separators in a proposed name and limits the stem to 160 UTF-8 bytes, with safe handling of empty/Windows-reserved stems. A proposal is never a destination path. The final OS-selected filename must pass ordinary filename validation and keep the chosen format's extension.

The default directory comes from the OS-known Downloads resolver, without guessing a username, literal folder name or OneDrive layout. If it cannot be resolved, does not exist or fails ordinary-local-directory validation, omit the hint and use the dialog's default. No directory is automatically created. The selected absolute destination stays inside Native.

Before the picker and after selection, Native validates workspace/view/tree revision/tab/latest request/token/non-browser session and compares current session identity to the physical file using metadata. Close, reload, root change and source replacement invalidate export. During writing it holds the lifecycle gate and source-reference guard, and revalidates before publication. Ordinary-local, no-recall and link/alias restrictions remain intact.

The writer retains the parent handle and operation-local scope, refuses profile destinations and invalid links, writes/syncs its own temporary file, revalidates the parent and publishes without replacement. Existing files are refused. Failure cleanup targets only that operation's temporary file, never an existing file. A post-publication flush failure can leave the output behind and reports `ArtifactPublishedUnconfirmed`.

## Errors and uncertain results

Errors include `ArtifactGestureRequired`, `ArtifactInvalidRequest`, `ArtifactTooLargeOrInvalid`, `ArtifactBusy`, `ArtifactCooldown`, `ArtifactUnavailable` and `ArtifactSourceChanged`, alongside stable Native `Artifact*` failures. Codes do not expose machine paths or content. Preserve inputs/calculations and show the error. Native rejection or failure never switches to browser download.

Unknown IPC/communication failure after a save request is `ArtifactResultUnknown`. That code and `ArtifactPublishedUnconfirmed` mean a file **may already exist at the chosen destination**. Do not automatically retry or claim it was not saved; let the user check that location.

The injected bridge rejects an unanswered request as an unknown result after five minutes, without resending. Main's unconfirmed proposal disables its Save action after five minutes. If Native picker/processing has begun, expiry does not cancel it. A timeout alone does not prove no file was written. An explicit `cancelled` result is distinct and does not automatically start a replacement request.

Opaque HTML can read its own token. Main cannot prove solely from postMessage that an original user gesture occurred. The injected API's synchronous activation check plus the independent main user action form the Native-call boundary. Main derives registration/request/revision context and Native revalidates identity; the document receives no general IPC/path privilege or sandbox relaxation.

## Verification scope

Use isolated fixtures for gestures, formats/size/base64 boundaries, proposal names, new-file content, basename-only receipts, existing-file refusal, cancellation, concurrency/cooldown, stale tokens/requests/views/revisions, browser-session refusal and source replacement. Include close/reload/root changes while the picker waits, profile/link refusal and uncertain publication without automatic retry. Keep browser download, injected bridge harness and actual Native checks separate.

Backend fixtures and source-level command ACL checks cannot establish Tauri command compilation, dynamic ACL behavior or real WebView/OS-picker operation. Downloads redirection/Cloud Files, Windows handle sharing, macOS WKWebView, real Canvas/encoder, disk-full and OS-crash durability require their own actual checks. See [testing](testing.md), [security](security.md) and [known limitations](known-limitations.md); do not treat unperformed Native QA as passed.
