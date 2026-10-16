# Architecture

Files are the source of truth. Rust owns guarded filesystem access, configuration, scanning, serving and watchers. React owns navigation and presentation; it does not insert user HTML into the application DOM.

## Responsibility map

| Area                          | Source and role                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell and settings        | `src/app/`: local UI, language, dialogs, residency and authoring setup                                                                        |
| Document views and navigation | `src/features/document-viewer/`, `src/lib/controller.ts`: tabs, columns, stable frame lifetime and request generations                        |
| Native commands               | `src-tauri/src/commands/`, `capabilities/main.json`, `build.rs`: typed local-main IPC and ACL                                                 |
| Files and mutation            | `src-tauri/src/knowledge/`, tree action modules: guarded roots, identity and explicit local writes                                            |
| Local document server         | `src-tauri/src/document_server/`: tokens, sandbox/CSP, bounded assets/media, document storage and help                                        |
| Search                        | `src-tauri/src/index/`: derived SQLite index, static extraction, query/status/read-only CLI                                                   |
| Saved document input          | `src-tauri/src/document_state.rs`, `document_state/` and management/transfer modules: independent persistent JSON state and explicit recovery |
| Residency                     | `src-tauri/src/resident.rs` and `resident/`: tray, recall and user-controlled OS login registration                                           |
| Authoring kit                 | `.agents/skills/mogledge-html/` → generator → `src-tauri/html-authoring-kit/`                                                                 |

The source path is an implementation map, not permission to bypass the existing API. Check actual types and tests before changing a contract.

## Data flow and lifetime

External editor/AI → selected knowledge folder → Native watcher/scan → React snapshot. A snapshot includes relative paths, IDs and revision, not HTML body text. Documents are served from a separate loopback HTTP port to opaque-origin sandboxed frames.

Workspace/view/tab IDs, request sequence numbers and grants distinguish independent views and discard late responses. Renderer restart invalidates old views. Closing, reloading, moving/removing a file and root/view changes invalidate affected grants; recreating a path does not revive old authority.

Frames have stable React keys and mount order. Column changes and tab reordering change layout, not the live document DOM. Open frames remain alive until explicit close; hidden HTML timers can still run. Workspace placeholders load only when selected. CPU/memory depend on the open documents rather than a fixed performance guarantee.

## Persistence

Keep three independent concerns separate:

1. HTML and relative assets: user-owned source files.
2. Search index: rebuildable cache of static extracted text, never canonical saved input.
3. Document-state database and configuration: saved JSON inputs, identity/recovery metadata, quotas and navigation preferences.

Document storage validates the current grant and physical identity, then commits on a blocking worker under lifecycle ordering. Acknowledgement follows transaction commit; failure must preserve previous data. [API v1](document-storage.md) is separate from internal DB schema v1/v2. Browser-localStorage fallback applies only to ordinary browser documents without a Native descriptor.

Dedicated-folder registration and document grants retain physical identity checks rather than trusting a pathname alone. HTML input uses its separate static UUID key, shared across dedicated folders. Bounded guarded configuration records track registered folders, UUID bindings and proven legacy associations; DB schema and storage API remain unchanged. Startup uses only the `com.shimilynx.mogledge` profile, without exploring or transferring older identifiers; see [profile separation](identifier-migration.md). Management/transfer is explicit, with [backup and recovery contracts](data-management.md).

The registered root remains the filesystem and persistence boundary. Display-folder selection is a separately validated root-relative physical reference; it does not replace workspace/view IDs, tab grants, storage keys or root-specific preferences. Snapshot nodes stay registered-root-relative while the tree filters the displayed scope. Held storage authority is captured when a document grant is issued and cannot be revived by later confirmation. See [registered folders](registered-folders.md).

## Filesystem and server boundaries

Read and write operations revalidate root/parent/file identity and reject unsupported links, reparse paths and cloud recalls. Writes are local-only, handle-based and non-overwriting. Published files are not deleted just because a later reporting/cleanup step failed. Tree order persistence is separate from a completed filesystem move.

The server bounds request count and memory rather than buffering arbitrary assets. Ordinary files are limited to 32 MiB. Media uses finite range reads, at most 2 MiB per GET and 1 GiB per file, with separate bounded concurrency. Disk/socket/browser/codec allocations are not completely represented by server budgets.

## Read-only search CLI

The optional `knowledge-cli` binary reads an existing derived index with explicit `--root` and `--cache-dir`. Build/run it from source with `cargo run --locked --manifest-path src-tauri/Cargo.toml --bin knowledge-cli -- <arguments>`; replace placeholders with confirmed locations.

| Operation               | Arguments after the root/cache options                               |
| ----------------------- | -------------------------------------------------------------------- |
| Index state             | `status --format json`                                               |
| Static-text search      | `search --query "text" --limit 20 --offset 0 --format json`          |
| Validated original text | `read --document-id "ID_FROM_SEARCH" --max-chars 4000 --format json` |

CLI search uses its existing whitespace/AND contract; the GUI's AND/OR selector does not add a CLI `--mode` option. Commands do not create/rebuild an index, initialize app settings or send content externally. Missing/stale/busy caches and unavailable or changed sources return errors; rebuild through the app. Reads exclude live JS/Canvas and saved inputs and revalidate the document against its selected root.

## Bundled help and authoring

`src/app/help/ja.html` and `en.html` are compiled into the Native app and served from fixed app-help paths. Read-only help has no scripts, storage bridge, Native IPC or external fetches. It is independent of the selected knowledge root and loaded only on demand.

The [HTML authoring generator](../scripts/build-html-authoring-kit.mjs) reads canonical adapters/templates and two API documents, records hashes, and produces bundled prose/template resources. Ordinary app build embeds those checked-in resources; it does not install them into user folders. Installation is a separate approved action.

See [security](security.md), [Wry isolation](wry-patch.md) and [testing](testing.md) before changing permissions, frame lifetime or OS boundaries.
