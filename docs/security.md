# Security and supported boundaries

Mogledge treats authored HTML as content separate from its trusted application UI. The supported workflow is local HTML and relative assets under a selected root; it does not provide arbitrary filesystem, shell or network access to document scripts.

## Documents and Native access

Documents run on a separate loopback origin in opaque sandboxed frames. Both frame attributes and HTTP CSP enforce the sandbox. Parent DOM/storage and Tauri IPC internals are not shared. Generic IPC, filesystem, shell, window-creation and dialog permissions are not exposed to documents.

Native commands are registered in `AppManifest` and restricted by the local-main capability. Document storage/export uses narrowly validated, grant-bound protocols rather than arbitrary Native commands. Validate inputs at the Native boundary even when UI types appear safe.

The [vendored Wry patch](wry-patch.md) prevents Windows initialization scripts from executing in child frames. It is an isolation requirement, not optional documentation cleanup.

## Paths, identity and writes

- Accept only validated paths within the currently selected root and recheck physical root/file identity.
- Reject traversal, symlinks/junctions, unsupported reparse tags, special files and out-of-root paths. A string prefix alone is not a path-security check.
- Windows read paths distinguish supported locally retained cloud files and refuse recall/population. A limited Cloud writer creates new HTML/nested folders, renames HTML and moves HTML/empty folders using retained ancestors, exclusive staging/create, nonreplacement rename and identity/availability checks. Unknown outcomes preserve files and stop automatic retry/cleanup. Verified moves persist only ordinary local profile sidecars through purpose-specific retained-handle publication; cache/profile/state Cloud writes remain rejected. See [Cloud-file QA](onedrive-qa.md).
- Local creation, rename, move and recycling require explicit actions. Preserve held-handle/no-overwrite guards and user confirmation; never substitute copy/delete when rename fails.
- Renaming/moving files does not rewrite HTML references. Replacement/copy can change saved-input identity and require confirmed recovery.

Grant validity is checked across lifecycle changes and bounded I/O. Closing a tab, restarting a view or changing the root invalidates related requests. SQLite/config and filesystem failure handling must preserve previous user data and distinguish rejection from unknown outcomes.

## Navigation and external tools

Same-page/internal HTML navigation uses current source/frame/token/view checks. External HTTP/HTTPS requires a trusted application confirmation followed by Native revalidation. A document's `postMessage` or `isTrusted` does not prove a human authorized an OS launch. Non-HTTP schemes, arbitrary launcher arguments and outside-root local targets are rejected.

AI handoff uses a fixed supported receiving-tool entry point, validated selected path/working directory and an unsent draft or copy action. It does not attach documents, automatically submit prompts or bypass the receiver's sandbox. Codex/Claude names and launch schemes describe actual integrations rather than UI imitation.

## Persistence and export

Saved inputs are explicit JSON state governed by [storage](document-storage.md), identity and quota checks. Do not use search cache deletion as data management. [Recovery copies](data-management.md) in the same DB do not protect against disk loss or DB corruption.

Generated-file export requires prepared bytes, a user gesture, application confirmation, a Native picker and a new destination. Unknown publication outcomes must not trigger automatic retry, overwrite or browser fallback. See [artifact export](html-artifact-export.md).

## Permissions and verification

Residency/login startup are opt-in. macOS input monitoring is granted manually; OS Secure Input is not bypassed. Diagnostics avoid ordinary key text/history and remain off by default. Preserve existing profiles, app processes, OS registration and permissions during tests.

Use [dedicated Native QA](testing.md#native-qa) for permission/path changes. Browser/mock results do not establish Native sandbox enforcement. See [known limitations](known-limitations.md) for unverified devices, providers, pickers, signing and migration behavior.

License compliance and privacy review are separate from runtime isolation. Preserve upstream notices and audit the intended redistribution; this security document does not certify a binary license audit or erase private Git history.
