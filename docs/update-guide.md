# Updating, backup and rollback

`git pull` updates source files; it does not replace an installed EXE or `.app`. Updating requires preserving data, building or obtaining the intended ordinary application, and replacing the confirmed installed target.

## AI build and update workflow

For an authorized update of the ordinary app, use this sequence on the machine that owns the installation. Reuse authorization for the confirmed target; clarify only an unknown target, unresolved saved input or a new operation outside that scope.

1. Identify the existing fixed EXE/bundle and its actual shortcut, Dock or login launch target. Record its version/hash and the intended source SHA. Keep the normal identifier and active profile.
2. Ensure build/staging output is separate from the active installation and persistent data, then build and verify the new ordinary app with the existing native cache and [commands below](#obtain-and-verify-the-target). A build-only request stops here; report that the installed app has not changed.
3. Complete pending document saves, Quit normally and confirm exit. Create the independent data backup and one verified previous-app rollback generation as described below.
4. Replace only the confirmed fixed EXE or whole bundle. Keep the existing pathname, shortcuts and login registration where possible; do not register the build output or create another daily-use trial copy.
5. Verify the installed version/hash against the build, then launch the fixed installed target and confirm the running version. Check the existing launch references and authorized saved input/settings without changing them unnecessarily.
6. Report build source/version/hash, fixed-location replacement, launch-reference checks and running-app verification separately. A blocked save, backup, replacement or launch remains an incomplete update; preserve the previous app and data for recovery.

Build outputs and caches remain development material. Reuse one update staging location and one managed previous-app rollback slot; separate QA copies require their own scope. Existing unrelated copies, caches and backups are not cleanup candidates merely because an update succeeded.

## Before updating

1. Confirm the intended source revision, OS and actual installed application. For source work, read `AGENTS.md`, any `AGENTS.local.md`, and [first-run instructions](first-run.md).
2. In a Git checkout, inspect `git status --short`, `git diff --stat` and `git rev-parse HEAD`. Preserve custom `AGENTS.md` before any source update; manually migrate local instructions as described in [first run](first-run.md#preserve-local-instructions). For a source archive, extract into a new directory instead of overwriting an existing tree. Never overwrite `AGENTS.local.md`, `CLAUDE.md`, custom skills or generated HTML.
3. Complete pending document saves before normal Quit. Use each document's Save/flush completion; arbitrary JS/Canvas state and unsubmitted input are not automatically saved. If saving fails or completion is unknown, retain the input and stop rather than force-killing or assuming closure saved it. With residency enabled, closing the window only hides it; use **Quit** and confirm exit before replacement or profile backup. See [saved-input completion](document-storage.md#javascript-api).
4. Make independent backups of the installed app, the complete persistent profile, and the user's knowledge folder and assets. A live SQLite file copied alone is not a consistent backup.

Do not resolve conflicts using a bulk `reset --hard`, `clean`, restore or lockfile deletion. Untracked files may be unrecoverable through Git.

Keep one managed previous-app generation in a rollback location outside the active installation, with its version and hash recorded. For Mac this is the complete old bundle. Before rotating that slot, verify the replacement backup and retain the prior generation until the handoff succeeds. An app-backup rotation does not authorize deleting data backups, unrelated old copies or the native cache. Persistent-data backups have their own retention and compatibility requirements below.

## What to preserve

The product identifier remains `com.shimilynx.myknowledge`. Windows normally uses `%APPDATA%` for configuration and `%LOCALAPPDATA%` for local data; macOS uses Application Support. Inspect the profile actually selected by startup migration rather than inventing a new location.

| Data                                                                      | Backup scope                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Root, tree order, favorites/recent, workspace sets and number assignments | Entire active config profile, including `settings.json` and root-specific `workspace-settings`             |
| Residency and authoring preferences                                       | `resident.json` and `html-authoring-settings`; OS startup registration is separate                         |
| Saved HTML inputs                                                         | Entire `document-state` directory and related database files after normal exit                             |
| Migrated profile                                                          | Entire `identifier-migration-v1` bundle, including config, document-state and migration metadata           |
| Language and WebView-side preferences                                     | Existing identifier and WebView profile; backing up only Native SQLite does not cover DOM storage          |
| HTML, assets and local instructions                                       | Actual user-selected locations, independent of the application                                             |
| Installed authoring kit                                                   | `.mogledge/html-authoring` and relevant `.agents/skills` / `.claude/skills`, including ownership manifests |

Migrated settings can reside at `identifier-migration-v1/config/settings.json`; do not move them back to a guessed profile location. Search indexes are rebuildable, but do not delete their containing persistent profile or migration leases/journals. See [data management](data-management.md) and [identifier migration](identifier-migration.md).

Preserve any legacy `.my-knowledge` directory and `my-knowledge-html-authoring` Skills alongside the canonical kit. They may contain customized instructions and recoverable ownership records. Updating to `.mogledge` does not rename or delete those originals; see [dedicated-folder compatibility](registered-folders.md#kit-updates-and-ai-handoff).

## Obtain and verify the target

For a completed application ZIP, follow [candidate download and opening](binary-distribution.md#downloading-and-opening-a-candidate): verify the selected platform, source SHA, version and app ZIP hash, then extract it into a separate directory. Use that EXE or complete bundle for the replacement below; no source build or development-tool installation is required.

For a source build, fetch the intended source, inspect its diff, version and compatibility, and use `git pull --ff-only` only where the selected tracking branch can safely fast-forward. An extracted `source.zip` has no Git metadata; use its manifest/source hash and [first-run build steps](first-run.md#build-an-ordinary-application). Do not treat an unmerged Draft PR as main. Refresh dependencies from the lockfile if their inputs changed.

Windows x64, from a clean committed Git checkout:

```powershell
node scripts/distribution/build.mjs windows-x64 --app-only
$buildTarget = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri/target' }
$newApp = Join-Path $buildTarget 'release/my-knowledge.exe'
(Get-Item -LiteralPath $newApp).VersionInfo | Select-Object ProductVersion, FileVersion
Get-FileHash -Algorithm SHA256 -LiteralPath $newApp
```

This existing builder checks ordinary identity/version, PE metadata and retained local build paths. Follow its [cache, environment and private-output instructions](../scripts/distribution/README.md#windows-application-only); preserve prior verification output before reusing its work directory. It builds and verifies without replacing or launching the installed app, so continue with the replacement steps when an update was requested.

The helper requires Git metadata and cannot run in an extracted source archive. For a Windows source archive, use only the ordinary build command in [first-run instructions](first-run.md#build-an-ordinary-application), then check the output version/hash and continue with fixed-location replacement here; skip the build-output launch example during an update. Retain the supplied source ZIP hash/manifest SHA as source attribution. This archive path does not provide the helper's Git receipt or automatic executable-path privacy check.

macOS, with ad-hoc signing and without notarization. This example uses the native default Cargo target. For an existing cache, use an absolute `CARGO_TARGET_DIR`; when unset the default is `src-tauri/target`. A separately selected Cargo target changes the output layout: resolve its actual bundle path before verification instead of falling back to an old default bundle.

```sh
npm run tauri -- build --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}' -- --locked --jobs 1
mogledge_build_target="${CARGO_TARGET_DIR:-src-tauri/target}"
mogledge_built_app="$mogledge_build_target/release/bundle/macos/Mogledge.app"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$mogledge_built_app/Contents/Info.plist"
shasum -a 256 "$mogledge_built_app/Contents/MacOS/my-knowledge"
```

Keep the ordinary identifier and feature set. Do not enable test features or use `scripts/build.ps1` for an app-only update. Record source SHA, version, executable hash and verified/unverified operations; a PE version does not reveal its source SHA.

## Manual Mac update and recovery

If in-app updating fails, preserve the warning and note the current app version, macOS version, CPU architecture and whether failure occurred at checking, downloading/verifying, applying or restarting. Antivirus product/detection names and the exact warning help distinguish OS trust from update failures. A local running-bundle path can help identify the target, but may contain personal information; inspect it locally and do not publish it in a report. Moving a downloaded bundle alone does not establish that it is trusted, writable or the bundle currently running.

1. Confirm the actual installed bundle and fixed pathname, including its Dock/login launch target. Confirm the active profile selected by startup migration and the actual HTML/assets locations using [What to preserve](#what-to-preserve) and [data management](data-management.md). Do not guess a profile path or treat a second app copy as the installed target.
2. Obtain the intended platform/CPU/version from [official Releases](https://github.com/shimi-lynx/mogledge/releases/latest) into separate staging. Mac first/manual installations use the architecture's application `.zip`; updater `.app.tar.gz` files are for the in-app updater. Verify the published hashes, source/version and applicable updater signatures against the [production verification procedure](production-distribution.md). An updater signature authenticates its corresponding updater payload; it does not authenticate an unrelated ZIP by itself. Verify the extracted complete bundle's code signature and version as described below. Current Mac distributions use ad-hoc signing: neither a passing code-signature check nor an updater signature is Apple Developer ID authentication or notarization, and OS trust warnings may remain. Stop on failed verification rather than bypassing OS protection.
3. Save pending document input and confirm completion. Quit normally, including a resident app, and confirm the process has exited. If saving or exit is unresolved, stop replacement. After exit, make an independent backup of the complete actual profile, HTML/assets and other data in [What to preserve](#what-to-preserve); do not copy only a live SQLite database or rely on a recovery copy inside the same database.
4. Preserve the complete previous app as one verified rollback generation outside the active location, recording its version/hash. If a failed updater retained an old bundle, confirm its identity and condition before using it; do not delete it or assume automatic restoration succeeded. Replace only the whole `.app` at the confirmed fixed pathname with the verified new bundle. Do not merge bundle directories, search for a same-named copy to overwrite, move user data or remove DB/settings to make an update work.
5. Verify the installed bundle's version, executable hash and code signature against staging before launching that fixed target. Then confirm its running version and launch references, and check the existing saved inputs/settings without unnecessary changes. Retain the previous app and independent data backup until these checks succeed. If launch or restoration fails, stop and follow [Verify and roll back](#verify-and-roll-back); an old app may need an old-version-compatible data backup.

This procedure does not call for disabling security software, clearing quarantine, resetting OS privacy protection, escalating permissions or deleting application data. If OS protection blocks the verified app, keep the warning and investigate it separately. Installing a newer bundle changes future updater handling; it does not change the code used by the still-installed old version's initial failed update. No failure diagnostic guarantees that the application was unchanged or successfully restored. These instructions do not establish that an unconfirmed Apple Silicon problem has been fixed.

## Replace the installed target

On Windows, read the actual shortcut `TargetPath`, arguments and working directory. Preserve the old EXE, then replace only that confirmed application with the verified new binary. Keep nearby user files and executable permissions. Point approved shortcuts to the fixed installed target, not a temporary checkout.

On macOS, quit and back up the old bundle, then replace the whole bundle at the user's confirmed fixed pathname. Do not merge bundle directories. Keeping an existing `My Knowledge.app` pathname is compatible with the Mogledge display name. If the pathname changes, turn login startup off using the old app, then explicitly register it using the new installed app; a checkbox alone does not prove that the registered absolute path matches. Check Dock entries and launch targets separately.

Preserve the complete bundle's permissions/signature metadata and verify the installed bundle with `codesign --verify --deep --strict <fixed-app>`. Confirm its Info.plist version and executable hash match the built bundle. An unchanged pathname/identifier does not establish permission inheritance. If standard recall reports missing Input Monitoring access after an ad-hoc replacement, use the existing app settings-open/recheck route and any requested normal restart; the owner chooses whether to grant access. Follow [the existing permission route](macos-resident-shortcuts-validation.md#existing-routes-and-permissions), without resetting privacy settings or broadening permissions.

Do not move knowledge or profiles with the binary. Preserve OS login registration unless a change was requested. Installer upgrades, uninstall and taskbar/Dock pin migration have separate [verification limits](known-limitations.md).

## Verify and roll back

Before launch, check that the installed EXE version/hash or bundle version/executable hash matches the verified build. Launch the confirmed installed pathname, not the cache output, and confirm the running target and version. Verify startup with disposable data first where the regular profile must remain untouched; when regular-profile use is authorized, check saved inputs, selected root, favorites, workspaces, language and startup registration without unnecessary setting changes. A matching app hash does not establish data restoration or OS permission behavior.

| Compatibility boundary | Required care                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical root identity | Old path-only settings require explicit root reselection. Do not attach old inputs/favorites to a different directory at the same path.                                          |
| Workspace config v4    | v1/v2/v3 load without number assignments; only a successful save writes v4. Back up before saving if rollback to an older version is required.                                   |
| Document-state DB v2   | New databases remain v1. Startup/inspection does not migrate them; explicit preview and confirmation do. Older v1-only apps cannot read v2, and there is no automatic downgrade. |

Same-database recovery copies are not independent backups. Missing/moved roots do not justify deleting settings, recreating a replacement folder or connecting copies by path alone. Restore copied HTML/root only after identity checks and explicit recovery where applicable.

Before rollback, stop the new app and separately preserve its current profile and HTML. Verify an old-version-compatible backup; do not overwrite newer inputs or mix old/new configuration and databases without the user's informed choice. Do not edit schema/version fields or delete SQLite tables, WAL/SHM/journals to force compatibility. Follow [storage compatibility](document-storage.md) for inline adapters.

Updating the app does not reinstall or regenerate the user's HTML authoring kit, instructions, skills or documents. Those remain a separate [explicit setup](html-authoring-kit.md).
