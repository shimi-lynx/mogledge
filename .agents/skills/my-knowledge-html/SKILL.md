---
name: my-knowledge-html
description: Generate standalone Mogledge HTML with saved input state, or convert existing HTML persistence to the shared asynchronous API. Support ordinary browsers without runtime dependencies.
---

# Generate or convert persistent HTML

Mogledge authoring uses explicitly registered dedicated folders with a required guide/template, Codex and Claude skills, and management marker. AI handoffs include guide-reading instructions by default. A dedicated-folder ID is not a storage key: preserve the document UUID when moving between registered folders. Unregistering keeps files and saved input.

This repository-local skill authors HTML; it does not add AI features, external services or dependencies to Mogledge, and is not globally installed. Read [the storage API](../../../docs/document-storage.md) and [coding standards](../../../docs/coding-standards.md) first. Preserve user instructions, original files and saved values.

1. Keep exactly one static `<meta name="mogledge-document-id" content="UUID">` in the HTML head. Use a canonical non-nil UUID (lowercase preferred); generate a fresh UUID v4 with `crypto.randomUUID()` for a new independent document. Preserve the UUID when editing, renaming, moving or atomically replacing the same logical document. A copied UUID can share saved input after the main app confirms sharing; use a new UUID for an independent copy. Never select a UUID through JavaScript or add one during startup.
2. Define the persisted inputs/selections/checks, stable `appId` and positive safe-integer `schemaVersion`. An appId identifies an app inside a document, not a path or user-entered value. Use a distinct appId for each different app in the same document.
3. Start from `assets/generated-sample.json`, containing `title`, `body`, `script` and optional `style`. Use `MyKnowledgeStorage.create({ appId, schemaVersion })`. Await `read()`, validate and restore before calculation or event-driven saves. Disable editing while restore is pending.
4. For conversion, inspect existing state and restore/recalculate order first. Read associated JavaScript/shared data as needed to understand initialization, events and state. Follow `assets/legacy-localstorage.html` → `assets/converted-sample.json` to replace direct localStorage with the asynchronous adapter. Old browser keys cannot migrate automatically to Native. If migration is requested, provide explicit browser import/validation/save and preserve old values.
5. Display save, quota and schema errors while retaining inputs/calculations. Initial read/schema/data failure must disable saving, never write defaults over unverified state. Debounce rapid input as needed. Explicit Save cancels its timer, awaits the latest `write()` and then `flush()`. Disable editing during reload/save, or track input generations so older success cannot mark newer input saved. Unload is not a save guarantee. `remove()` is an explicit deletion, never a restore-error workaround.
6. Generate from the repository root. Do not hand-copy or modify the transport; inline canonical `assets/storage.js`, `assets/export.js` and `assets/template.html`:

   ```sh
   node scripts/build-knowledge-html.mjs <source.json> <output.html>
   ```

7. App updates do not update existing inline adapters. Preserve original HTML, JSON and state DB, regenerate older 64 KiB / 5 MiB / 8 MiB adapters into a **new output**, and verify an isolated fixture before user-reviewed replacement. Without generation JSON, convert while preserving schema and restore order. Do not bulk-rewrite user files. Before first saving over 64 KiB, create an older-compatible backup with the app fully stopped. Follow [update/rollback conditions](../../../docs/document-storage.md#update-an-html-or-return-to-an-older-app).
8. Preserve `documentId` in generation JSON when regenerating to a new output. If omitted, the generator preserves the existing output's UUID or creates a fresh v4 for a new output. It refuses existing missing, malformed or multiple IDs and conflicting explicit IDs without writing. Resolve those cases explicitly with original preservation; never rotate a UUID to conceal a restoration failure. External HTML without metadata remains viewable, but Native storage requires the main app's explicit add-ID action. Malformed/multiple metadata blocks storage and preserves saved data. Legacy ambiguous path-only state needs explicit main recovery, never default writes.
9. Copy complete output outside the repository; check HTTP-browser save/reload and separately `file:` persistence. Denied storage is not success. Check the same fixture in Mogledge: input → Save → reload, close/reopen and restart. Compare calculations before/after conversion. A present Native descriptor must never fall back to localStorage after failure.
10. Run `node --test tests/storage/*.test.mjs` and relevant existing checks. Follow [API verification](../../../docs/document-storage.md#verification) for rapid input, quotas, revocation, separate documents/views, rename/move and immediate close after Save. Record actual browser/Native/Windows/macOS checks and unperformed QA separately.

If automatic skill discovery is unavailable, explicitly provide this SKILL.md, `docs/document-storage.md`, `assets/template.html`, `assets/storage.js` and `assets/export.js`. The generator embeds trusted author-approved HTML/JavaScript; it is not a sanitizer. Do not add arbitrary IPC, SQL, filesystem/parent-window access, shell commands, permission changes, sandbox relaxation or CDNs. Treat user text/names/paths as data, not executable code. Do not use production roots/profiles for test writes or send user files/state to AI services without instruction.

If API/capacity/identity behavior changes, update canonical assets, specs, examples and focused tests together. Follow [testing](../../../docs/testing.md); harness results cannot substitute for real Native QA.

## Storage boundaries

Size is the complete logical document's UTF-8 JSON, including all appIds, keys, schema/data envelopes, syntax and escaping. Native defaults are document 5 MiB / active profile total across all roots 512 MiB. Only trusted main settings can explicitly choose both within 1–8,589,934,591 whole MiB, total at least document. This safe-integer conversion range does not guarantee runtime, disk or memory capacity. See [quotas and compatibility](../../../docs/document-storage.md#quotas-and-capacity).

Descriptor `maximumDocumentBytes` is runtime SQLite capacity, not current quota. The canonical adapter accepts positive safe-integer bytes. Missing fields in older Native and ordinary browsers retain 5 MiB; invalid fields fail closed. Native makes final whole-document/current-quota/capacity/resource decisions. `QuotaExceeded`, `CapacityExceeded` and `ResourceUnavailable` preserve saved values. Do not change quotas from HTML, add quota requests/cache or hide Native failure with fallback, truncation or initialization.

Keep fixed 128 appIds / 4,096 historical identities and separate recovery 512 MiB / 4,096 entries. Quarantine beyond recovery budget is safely refused; it is not a normal-write limit. Removing all appIds keeps the identity/revision record. First different settings creating/rebuilding numeric DDL need independent whole-profile backup and compatibility acknowledgement; returning to 5 / 512 does not restore older-app compatibility.

A single-app precheck can pass before whole-document or browser-origin quota failure. Verify UTF-8, escaping/wrapping boundaries and failure preservation. Old inline adapters and small-form QA do not establish large-state support.

## Export generated files

Use [the separate export API](../../../docs/html-artifact-export.md), `MyKnowledgeExport.exportArtifact({ blob, name, format })`. The generation CLI inlines canonical `assets/export.js`. Input-state saving and artifact export need separate controls/feedback.

Accept only PNG/JPEG/CSV/JSON/text, a non-empty Blob up to 5 MiB and a proposed name up to 1,024 UTF-8 bytes. Pass no URL, path or Native ID. Prepare asynchronous Blobs first and start directly from a real click/key activation, never initialization, timer, automatic save or synthetic click. Each layer admits one operation with a one-second start interval, including cancellation/failure.

Native uses independent main confirmation → OS destination picker → new-file save, without overwrite, absolute-path disclosure or automatic opening. Only an absent export bridge permits browser Blob download. Unsupported/revoked/denied/failed Native bridges never fall back. Show `saved`, explicit `cancelled` and `download-requested` distinctly; browser download is not persistence proof. `ArtifactResultUnknown` and `ArtifactPublishedUnconfirmed` may leave a file behind: preserve input, report uncertainty, have the user check the destination, and never automatically retry. A timeout does not prove no file was written.

Retain standard Blob/audio/video APIs. Do not disguise SVG/HTML/executables as safe images; signature checks do not prove whole-content safety. Verify ordinary `file:`/HTTP(S), injected opaque fixtures and actual Native independently, with unperformed checks reported.
