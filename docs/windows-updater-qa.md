# Isolated Windows updater QA handoff

This handoff supports separately authorized updater-signed Windows QA. It does not authorize production replacement, Actions, Release/publication, Secrets/permission changes or access to another operating system. Use synthetic HTML/input and a dedicated profile/install directory. Keep the normal app, data, registration and shortcuts unchanged.

## Isolation before build or installation

Use the same dedicated QA identity for both the installed baseline and newer target. Give both a distinct identifier, product name, executable name, NSIS install/registry identity, shortcuts and install directory. Confirm actual resolved profile/database/cache paths and existing registry/shortcut targets before launching or installing. A separate WebView directory or `e2e` alone does not isolate the database; `e2e` and debug builds are also disabled by the updater enrollment guard.

The production NSIS template `src-tauri/windows/installer.nsi` fixes `INSTALLIDENTITY` to `My Knowledge`; this controls the default directory, uninstall/product registry keys and the Run-key cleanup identity. Changing only Tauri `identifier`/`productName` does not isolate those paths. Use a dedicated untracked QA template with a different `INSTALLIDENTITY` and review all legacy-shortcut, registry, autostart and cleanup references. Do not edit or reuse the production template identity for the QA installer. Runtime login startup separately hardcodes `My Knowledge` in `lib.rs`; `resident.rs` refuses startup mutation for a different identifier. Preserve that identifier guard and do not enable, disable or rewrite login startup during updater QA.

Select release mode, `distribution-updater`, NSIS and a QA-only configuration with `createUpdaterArtifacts: true`, the approved QA public key, `requireSignedVersion: true` and the exact loopback manifest endpoint. Do not combine this with the production pending overlay, which intentionally prevents enrollment. A QA key must be separately scoped and public-only here; the Windows operator controls its private material. Record the actual public-key fingerprint used, rather than claiming production-key verification when using a fixture key.

After the QA-only source changes and dedicated overlay/template have been reviewed, the Windows operator can use the existing locked single-job procedure below. `.tools/updater-qa/tauri.qa.json` represents the approved untracked overlay; do not substitute the pending production overlay. Signing material must already be available through the owner's approved local signing procedure, outside source/messages/logs. This configuration task does not run the command.

```powershell
npm run tauri -- build --features distribution-updater --bundles nsis --config .tools/updater-qa/tauri.qa.json -- --locked --jobs 1
```

## Loopback transport exception

Current production code rejects HTTP in `updater_model::secure_config` and configures the client with `https_only(true)`. An HTTP config alone cannot enable the test. Any authorized exception must be an isolated QA-only source/config change, absent from the production branch and binaries. The upstream protocol option alone does not change these app guards.

Allow only the exact selected `http://127.0.0.1:<port>` origin and fixture paths for manifest and artifact. Bind the server to 127.0.0.1; reject redirects or validate every redirect target against the same restriction. Do not accept `localhost`, other loopback aliases, credentials, LAN/non-loopback hosts, proxies or external artifact URLs. Preserve certificate checks for any HTTPS path and mandatory artifact/signed-version verification. Do not enable a global production transport/certificate bypass.

The [distribution preparation](updater-distribution-preparation.md#artifacts-and-manifest) describes real NSIS plus `.sig` and minimal manifest construction. Serve only a new fixture directory, not the repository, home directory or key storage. The installed baseline and target must share the QA identity and install directory while the target has a higher verified SemVer. For a fixed 0.8.0 target, a lower synthetic QA baseline avoids altering the production version; record the exact temporary version/source differences. A fresh unsigned standalone EXE does not exercise the NSIS enrollment/installer handoff.

## Required evidence

- Before installation: baseline/target source and QA-only diff/config/template hashes, identifier, actual profile/install/registry/shortcut paths, platform, embedded versions and installer hashes. Verify that every target is separate from the ordinary app. Stop if isolation is uncertain.
- Check: correct notes/version, no-update response and network failure. Download: byte progress, cancellation/stale response/duplicate rejection; rejection of altered artifact, bad signature and mismatched signed version without replacement.
- Apply: save synthetic inputs explicitly, require a fresh saved-input acknowledgement, apply/relaunch through NSIS, inspect actual new executable/version/hash and the retained custom install path. Verify settings and saved HTML inputs after restart; report unsaved-input loss explicitly.
- Recovery: record any install failure and actual remaining app/data state; do not assume rollback. Cleanup only owned QA processes/files/registrations after path/PID/creation-time/hash checks. Preserve the normal app and evidence needed to diagnose failures.

Record actual passes/failures/skips and OS trust prompts. Updater signing is not Authenticode, and mock tests or artifact generation are not real installed-update success. Report the QA-only changes separately so they cannot be merged into production during later preparation.
