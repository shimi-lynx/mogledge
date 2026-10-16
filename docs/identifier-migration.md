# Product identity and profile separation

Current source uses `com.shimilynx.mogledge`, the `mogledge` executable/package, `mogledge_lib` library, and the Mogledge installer and login-startup name. This identity change is unreleased. The published 0.9.1 artifacts retain their recorded identity; source changes do not replace those binaries.

## Profile contract

The new identifier selects a separate configuration, local-data and WebView namespace. A new profile begins with default preferences and no registered folders or saved input. Normal subsequent starts reopen that new profile. Language, search and tree-expansion preferences use `mogledge.*` keys; the browser adapter uses `mogledge:v1:`.

Startup does not discover, copy, merge or delete profiles belonging to `com.shimilynx.myknowledge` or `com.shimilynx.aiwiki`. It does not copy old WebView storage or read old preference keys. Data transfer is outside this rename; preserve the old profile and HTML for a separately requested, explicitly reviewed operation. A matching filename, folder name or document UUID does not authorize copying an old database into the new profile.

OS directory APIs determine the active locations. Windows configuration and local data normally use `%APPDATA%` and `%LOCALAPPDATA%`; macOS uses the locations returned for the new bundle identifier. The actual older Apple Silicon profile and WebView locations have not been established. A guessed `~/Library/WebKit/<identifier>` path or a language surviving reinstallation does not prove where that installation saved its preferences.

The old `identifier-migration-v1` bundle may exist in a previous profile. Preserve it whole with its metadata and do not flatten it into the new profile. This source does not automatically resume the earlier AIWiki migration gate.

## Compatibility exceptions

- Old HTML API globals, descriptors and transport routes remain compatibility aliases to the same document-scoped storage/export authority. New templates use the Mogledge names. Aliases do not discover old profiles or read old browser-localStorage keys.
- Windows installer compatibility identifies the exact old product registration to handle an existing installation. It does not infer ownership from a similarly named directory or authorize deleting user data.
- Legacy dedicated-folder kit markers and edited instructions remain protected at their existing paths. This folder-resource compatibility is separate from application-profile transfer.
- Historical release receipts, source identities and third-party attribution retain the names that were actually used.

## Update and verification boundaries

Changing a bundle identifier can change OS permissions, login registration and app identity. Retaining the updater signing key authenticates an artifact; it does not prove that replacing an old installed product with the new identity works. Check [updating and rollback](update-guide.md) before replacement and preserve the old app and all old data independently.

Required device checks include fresh-profile startup without old-data changes, Windows old-product detection and installed update/uninstall registration, custom install locations, shortcuts and login startup, and Intel/Apple Silicon bundle replacement, updater apply/restart, signature and permission behavior. Targeted source/mock tests do not establish these Native results. This rename has no completed Native update verification or new release.
