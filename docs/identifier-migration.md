# Identifier migration and startup gate

The ordinary application identifier is `com.shimilynx.myknowledge`. The previous identifier `com.shimilynx.aiwiki` is retained only for compatibility detection/migration. Changing display name to Mogledge does not introduce another profile identifier.

Startup inspects old/current profile state before opening the ordinary window, initializing document-state storage or releasing normal IPC. Old data requires a Native confirmation after the old app has exited. The application preserves the old source and does not overwrite an existing current profile.

## Contract

- Use OS configuration/local-data locations and the exact supported identifiers; do not infer ownership from a similarly named directory.
- Inspect presence, type, links, identity, accessibility and leases. Permission errors or unsupported paths are not treated as an empty profile.
- Copy supported config and saved document-state data into owned staging, validate it, and atomically publish a complete migration bundle. Search is a rebuildable cache; WebView profile copying is not assumed safe across platforms.
- Keep unresolved conflict/cancel/error at the startup gate. Do not let ordinary folder selection or document-state initialization bypass a failed migration.
- Keep the source unchanged. Protect copy/publication against identity changes and concurrent app processes; do not resume a partial state by deleting journals or leases.

Migrated data can live in the current local-data profile's `identifier-migration-v1/config` and `document-state` bundle. Back up the whole bundle and metadata; do not flatten it into guessed ordinary directories.

## Recovery and QA

Follow [update/rollback](update-guide.md) and [data management](data-management.md). API v1, DB schema versions and root/file physical identity are separate compatibility checks. An old executable may not read newer saved formats.

Test migration only with dedicated old/new QA identifiers and disposable synthetic profiles. Test old-only/current-only/conflict, cancel, concurrent lease, staging/source replacement, interruption, publication and restart. A QA feature alone does not isolate storage. Do not launch an ordinary-identifier test executable against production data.

Windows fixture evidence does not establish macOS migration, WKWebView profile behavior, every crash/disk-full case or installer update. Preserve these [known limitations](known-limitations.md) instead of reclassifying them as passed when docs are consolidated.
