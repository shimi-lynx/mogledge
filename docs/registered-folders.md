# Registered and displayed folders

Published 0.8.3 includes the registered/displayed-folder correction; earlier 0.8.2 binaries predate it.

The registered folder is the physical root used for saved input, document references, tabs, favorites and workspace preferences. **Switch displayed folder** changes only the folder shown in the tree within that registered scope. Opening a child folder this way preserves the registered root, live tabs and their admitted storage destinations.

Use **Settings → Registered folder** to change the registration itself. Choosing a folder outside the registered scope, including the parent of a registered child, does not silently replace the registration. The app explains how to use Settings. Changing registration does not merge, migrate or delete existing saved input; a different physical root has its own saved-input keys and navigation preferences.

## Identity and restoration

Saved-input identity remains the registered root's physical identity plus the HTML file's physical identity. Display selection, tab history and tree paths remain relative to the registered root. A tab outside the currently displayed child folder retains its existing document and storage authority.

The app stores the display folder separately, with its physical identity and the registered root identity. Restart restores the registered root first, then validates the display selection and restores root-relative tabs. A missing or replaced display folder falls back to the registered folder with a notice; it never becomes a replacement registration or a path-only binding. An unavailable or replaced registered root retains its existing recovery boundary.

## Mac saved-input admission

Ordinary Mac builds retain the volume UUID, object ID and birth-time identity scheme that excludes mount-session device numbers. Browsing and saved-input ownership confirmation are separate decisions.

First registration can enable storage when the database is successfully validated and has no saved records, recovery records or deletion tombstones. A failed read, missing store or corrupt database is not evidence of emptiness. If settings show a previous registration but its database is missing, initialization refuses to create a replacement empty database, including after restart. This check uses the actual startup configuration and any legacy local-profile settings, even when configuration, local data and a migrated database bundle occupy separate directories. A new profile with only language or other preferences can still register normally. No existing input is moved or erased.

Fresh registration records an empty-profile admission marker in the existing identity metadata. The historical `backup_hash` column stores either that domain-separated marker or the hash from explicit backup confirmation; a fresh registration does not claim that an independent backup was created. A new document can be admitted under this fresh root only if it has no conflicting saved or recovery identity/path record. Explicit root confirmation replaces the marker with backup evidence, retaining the conservative requirement to confirm subsequent new documents individually.

Existing uncertain input remains held for explicit confirmation. The app frame shows the reason and next action even if the HTML cannot finish its own initialization after a storage error. Unconfirmed reads, writes, deletes and saved-data management do not succeed as empty restoration or overwrite existing input. An access token issued while held remains held after later confirmation; reopening must establish new authority.

Before any operation on real retained input, preserve an independent backup and follow the [Mac confirmation workflow](macos-storage-identity.md). Implementation tests use disposable synthetic profiles. No real-data transition is performed by these source changes.

## Limits and verification

Synthetic backend and controller tests cover root/display separation, stable saved keys and values through child/parent display changes and restart, stale selection, held storage and existing multiple-tab behavior. Browser tests use a mocked Native bridge. These checks do not establish Native pickers, WKWebView, Mac filesystem identity or physical-device behavior; the owner will verify the merged-main Mac build. That device QA remains unrun and is not a separate pre-merge QA-build requirement.

An external editor or AI that replaces an HTML file can change its physical identity. This change does not solve replacement-save recovery or merge data previously saved under different registered roots. Replacement-save recovery remains open in [issue #25](https://github.com/shimi-lynx/mogledge/issues/25). See [storage and recovery limitations](known-limitations.md#storage-and-recovery) and [tab sessions](tab-sessions.md).

## Source verification

Verification used Windows and disposable synthetic profiles. The original parent-to-child selection test failed because it replaced the registered root; the separated-config test failed because initialization created an empty database despite retained registration settings. Both pass after the corrections. The PR records the source commit.

| Scope                                                              | Command or check                                                                                                                                                            | Result and limit                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered/displayed folders, missing DB, admission and Native ACL | `cargo test --locked --manifest-path tests/backend/Cargo.toml --test registered_root_display --test native_command_acl --test profile_storage --jobs 1 -- --test-threads=1` | 32 passed: 24 folder/storage cases, six ACL cases and two profile cases; real Windows filesystem/SQLite and portable persistent-admission policy, not a Mac filesystem probe |
| Existing saved-input behavior                                      | Backend `--test document_state`                                                                                                                                             | 18 passed                                                                                                                                                                    |
| Existing restart, lifecycle and startup wiring                     | Backend `--lib` filters `root_recovery`, `core::tests` and `migrated_profile_root_and_search_cache_are_not_portable_file_destinations`                                      | Eight, three and one passed                                                                                                                                                  |
| Rust static checks                                                 | Both affected manifests: `cargo fmt --check` and `cargo clippy --all-targets --jobs 1 -- -D warnings`; app Clippy also uses `--features e2e`                                | Passed; both startup call sites compiled; no app was launched                                                                                                                |
| Frontend                                                           | `npm run check`; controller, App and tree regressions                                                                                                                       | No type/lint/format warnings; 162 controller, 27 App and 19 tree tests passed                                                                                                |
| Browser appearance and interaction                                 | `npm run test:ui -- tests/ui/registered-folder.spec.ts tests/ui/root-selector-width.spec.ts tests/ui/root-actions.spec.ts tests/ui/startup-recovery.spec.ts --workers 1`    | Eight passed with installed Edge via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; mocked Native bridge, Japanese/English and narrow layouts                                        |
| Restoration adapter and bundled provenance                         | `node --test tests/storage/adapter.test.mjs tests/storage/authoring-kit.test.mjs tests/storage/tab-session-permissions.test.mjs`                                            | 22 passed; failed restoration preserves values and does not fall back                                                                                                        |
| Documentation and review                                           | Local file/anchor links, diff checks and independent source review                                                                                                          | 107 links passed; review passed                                                                                                                                              |

Unchanged controller/tree and adapter behavior retains its targeted evidence. Browser evidence predates only the final warning-text addition; the final frontend check includes that text. The final initializer change was retested against existing saved-input, recovery and lifecycle cases. This is source verification, not Native picker, WKWebView, Mac reboot or installed-product acceptance. No real profile, data migration, installer, distribution or release operation was performed.

## Version and build scope

Product manifests and the current Windows validation helper are aligned at 0.8.3. This patch corrects registered-folder and saved-input behavior; it does not introduce a new storage identity or migrate retained input. Existing 0.8.2 signing/publication pins and historical verification remain unchanged. Targeted source evidence above is reused because the later changes only align product metadata and describe the agreed build/QA sequence. The candidate workflow checks the final source, product version, executable metadata, bundled source and dependency notices on each selected OS. Signing, publication and installed-app replacement remain separate operations.

The final metadata adjustment passed product-version/identifier consistency, the frontend type/lint/format check, Windows-helper syntax, 107 local links and independent source review. Distribution fixtures passed 26 cases with four explicit skips (three filesystem-symlink cases and the opt-in Rust privacy probe); those skipped checks are not counted as passed.

## Sidebar labels in 0.8.4

The sidebar omits the repeated **Registered folder: name** and **Displayed folder** text below the folder selector. The selector still shows the current displayed folder name and its full path on hover. **Show the entire registered folder** remains available while a child folder is displayed. The registered root remains visible in **Settings → Registered folder** and the root context menu.

This presentation change does not alter registered-root or displayed-folder state, saved-input keys, tab grants, restoration, root-management actions or storage-hold/error notices. The registered-root name is no longer continuously displayed while browsing a child; use Settings or the context menu when that distinction is needed.

Targeted App/controller tests passed 42 cases, including the retained live document and return-to-root operation. Two Japanese/English browser cases passed using a mocked Native bridge, covering child restoration, return controls, storage-hold/error actions and 320-pixel light/dark layouts. Screenshot inspection and the frontend type/lint/format check passed. These checks do not establish Mac launch, updater installation, native pickers or real-profile behavior; no desktop app was launched or installed for this presentation change.
