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

Required device checks include fresh-profile startup without old-data changes, Windows old-product detection and installed update/uninstall registration, custom install locations, shortcuts and login startup, and Intel/Apple Silicon bundle replacement, updater apply/restart, signature and permission behavior. Targeted source/mock tests do not establish these Native results. Bounded hosted-runner results below cover specific synthetic installation checks; full updater-UI, login-session and device-permission acceptance remains separate.

## Bounded 0.10.0 probe correction evidence

The first candidate run packaged all three platforms from `69c207b383c4289fa9045af647dcef3020cd37cb`, then failed in verification scripts. Existing pinned artifacts were reused to isolate the failures without rebuilding the application. The Mac window query needed an explicit Core Foundation array bridge. Windows metadata inspection needed to include hidden profile directories, and normal NSIS uninstall intentionally retained the install-location preference. The probe now verifies and resets only its own synthetic preference between independent fixtures. Normal close remains bounded to 15 seconds while allowing the renderer's session-flush listener to initialize. Source, hosted-runner, asset-hash, profile-alias and process-ownership guards remain enforced.

[Apple Silicon run 38903107043](https://github.com/shimi-lynx/mogledge/actions/runs/38903107043) passed same-location bundle replacement, native window/current-profile startup and unchanged synthetic old-data/LaunchAgent checks. [Windows run 38904343608](https://github.com/shimi-lynx/mogledge/actions/runs/38904343608) passed fresh NSIS install/uninstall, exact 0.9.1 same-location update, unsupported-startup-command refusal, owned registry/Run/shortcut/AppUserModelID transitions, foreign-shortcut preservation, old-data preservation, new-profile startup and normal close. These results precede the Cmd+F correction and do not replace the final combined candidate checks. Intel, actual updater UI/signature handoff, physical Cmd+F and existing-device login/permission behavior are not established by these runs.
