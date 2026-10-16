# Mogledge 0.10.0

This document prepares the combined product-identity, HTML-creation and sidebar-expansion changes for 0.10.0. It does not establish a published Release, verified installer, installed-app replacement or completed Native update. The 0.x policy uses one minor increment for this release's behavior and compatibility changes; dependency versions and historical release receipts retain their original scope.

## Product identity and existing data

The application identifier becomes `com.shimilynx.mogledge`. The package and executable use `mogledge`, with `mogledge.exe` on Windows and `Mogledge.app/Contents/MacOS/mogledge` on macOS. New Windows installations and login-startup registrations use Mogledge. Installer compatibility recognizes the exact supported predecessor and retains its verified installation directory, including a custom location; it does not select a directory by a similar name.

The new identifier selects separate OS configuration, local-data and WebView locations. An absent new profile starts with default settings and no registered folders or saved input. New preferences use `mogledge.*`; new ordinary-browser storage uses `mogledge:v1:`. Startup does not discover, copy, merge or delete old profiles, settings, document input or browser keys. Existing HTML, assets, old databases and backups remain intact. API compatibility does not transfer data between profiles. Preserve any old `identifier-migration-v1` bundle whole for a separately requested transfer.

Use the actual profile locations returned by the OS for the running installation. The older Apple Silicon profile and WebView paths remain unconfirmed; a guessed Library directory or preferences surviving reinstallation does not establish their location. See [profile separation](identifier-migration.md) and [backup and rollback](update-guide.md).

## HTML workflows

New templates and Skills use `MogledgeStorage` and `MogledgeExport`. Old HTML globals, descriptors, endpoints and transport messages remain compatibility aliases with the same document grants, validation and fail-closed restoration/save behavior. New portable exports use `mogledge-saved-state`; the explicitly selected importer also accepts the old format name. Preserved legacy kit resources and historical records keep their original names.

The app's blank HTML creation icon, context-menu actions, dialog and shortcut are removed. External AI handoff, folder creation, dedicated-folder registration, authoring-kit/template deployment, and viewing, saving, renaming or moving existing HTML remain available. This removal does not delete HTML or saved input.

## Sidebar expansion

The release also includes [#53](https://github.com/shimi-lynx/mogledge/pull/53), which preserves remembered sidebar expansion when a tree scan or preference write fails. Failed writes retain the latest choices across registered-folder switches during the same session and can retry on a later normal save; only a complete scan prunes missing paths. Loading and recovery do not overwrite remembered expansion with an empty tree.

## Installed update and login-startup boundary

Changing the identifier and executable name can affect updater installation, restart, shortcuts, login registration and OS permissions. **An already enabled macOS LaunchAgent may still point to the old executable inside a replaced bundle.** Keeping the bundle pathname does not repair a target ending in `Contents/MacOS/my-knowledge` after that executable becomes `mogledge`.

Before an approved transition, disable login startup through the old installed app where available. After replacing and verifying the fixed installed target, explicitly enable startup through the new app if desired, then verify the registered target and actual login launch. If the old app is unavailable or a registration's ownership is uncertain, inspect it within the authorized device scope rather than deleting or replacing unrelated registrations. New-profile defaults do not prove that an old OS registration has disappeared.

Existing installed cross-ID updates, signed download validation, relaunch, login registration and permissions on Windows, Intel Mac and Apple Silicon remain required evidence before release. Windows predecessor/custom-path detection, owned shortcut updates, foreign-shortcut preservation, uninstall registration and failure recovery also need Native verification. Source tests, installer compilation and valid updater signatures do not establish these results. Track the remaining acceptance in [#55](https://github.com/shimi-lynx/mogledge/issues/55); release authorization does not mark an unperformed check passed.

Windows distributions remain without Authenticode signing. macOS uses ad-hoc signing without Developer ID or notarization. Updater signatures authenticate their payload and signed version; they do not remove SmartScreen/Gatekeeper warnings or establish OS publisher trust. Preserve OS protection and the existing protected signing/publication workflow.

## Verification record — pending

Fill this record with the actual integrated source and artifact evidence. No result below is claimed by this preparation.

| Scope                                                                             | Status                                              |
| --------------------------------------------------------------------------------- | --------------------------------------------------- |
| Actual merged source, version commit and tested tree relationship                 | Pending integration readback                        |
| Aligned npm/Tauri/Cargo product version and relevant source regressions           | Pending final integrated checks                     |
| Rust compilation, affected tests and Clippy                                       | Pending coordinated validation                      |
| Windows EXE/NSIS version, identifier, executable name and architecture            | Pending actual build and inspection                 |
| Intel/Apple Silicon bundle metadata, architecture and code signature              | Pending actual builds and inspection                |
| Fresh new profile and unchanged old data                                          | Pending Native checks                               |
| Cross-ID installed update, restart, login target and permissions                  | Pending required Native checks described above      |
| Candidate hashes/source receipts, updater signatures and independent verification | Pending new artifacts and verified pins             |
| Publication, tag/source, anonymous downloads and latest-feed readback             | Pending authorized publication after required gates |

Keep [#54](https://github.com/shimi-lynx/mogledge/issues/54) implementation acceptance separate from #55's installed-update gates. Earlier [0.9.1 evidence](production-distribution.md#actual-091-publication-and-minimum-verification) and existing device follow-ups retain their original source and scope; they do not validate 0.10.0.
