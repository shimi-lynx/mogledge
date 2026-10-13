# Dedicated loopback updater probe

This branch prepares a separately authorized Windows Native probe. It is not a
production update implementation, distribution activation or merge request.
Ordinary features/configuration, HTTPS policy and the production NSIS template
remain unchanged. Do not select `updater-loopback-qa` for ordinary builds.

The probe follows the [isolated QA handoff](https://github.com/shimi-lynx/mogledge/blob/aebc62a088f9e497acd1f9e66337c98126954b9b/docs/windows-updater-qa.md).
Use a release build with `updater-loopback-qa`, which includes
`distribution-updater`. Debug/e2e/non-Windows builds and ordinary identities are
rejected before profile initialization. The distinct executable name also keeps
NSIS process checks separate from the running ordinary app.

| Boundary                       | Required value                                                 |
| ------------------------------ | -------------------------------------------------------------- |
| Identifier                     | `com.shimilynx.mogledge.updaterqa`                             |
| Product/window name            | `Mogledge Updater QA`                                          |
| Executable                     | `mogledge-updater-qa.exe`                                      |
| NSIS install/registry identity | `MogledgeUpdaterQA`                                            |
| Manifest                       | `http://127.0.0.1:47653/latest.json`                           |
| Artifact                       | `http://127.0.0.1:47653/MogledgeUpdaterQA_0.8.0_x64-setup.exe` |

The QA feature accepts only those exact URLs, disables HTTP redirects and
system/environment proxies, and preserves signature and signed-version checks.
Certificate/hostname exceptions and downgrades remain rejected. Installer
arguments are limited to `/NS`; login startup stays unsupported for the QA
identifier. Existing QA profile handling bypasses ordinary identifier migration.
Do not launch the storage-transition helper in this probe.

## Prepare private fixtures

Use a new owner-controlled workspace outside saved documents/key storage.
`prepare` requires a public-key file and refuses an existing fixture directory:

```powershell
node scripts/updater-qa.mjs prepare '<new-qa-workspace>' '<public-key-file>'
```

It derives an untracked NSIS template by changing only `INSTALLIDENTITY`, and
creates active QA and unsigned-packaging overlays. The latter permits compiling
the enrolled executable first and packaging its NSIS without opening the private
key; it does not change the executable's compiled enrollment decision. Sign the
retained target later using the owner's approved encrypted-key procedure and
Tauri CLI `signer sign --app-version 0.8.0`. Never put the password/private value in
shell arguments, repository files, logs or messages. Do not generate another key
or choose a backup location as part of this probe.

Compile the synthetic baseline `0.7.99` and target `0.8.0` sequentially from the
same QA source directory and reusable target cache. Align all product-version
entries for the temporary baseline and retain its exact local source receipt;
restore the committed QA branch for the target. No main push/merge is involved.
Use release/locked/jobs-one builds and monitor RAM. Keep compiled configuration
and package metadata aligned. NSIS packaging selects the unsigned-packaging
overlay; signing happens only after the target installer/hash/version are ready.

Install the baseline only at the confirmed new QA directory using `/NS` and the
reviewed install path. Verify separate profile, database, registry and actual EXE
paths before writing synthetic inputs. Preserve the ordinary app/process,
shortcuts, login registration and all user data. Updater signing is distinct from
Authenticode; report OS protection prompts without bypassing them.

Put only the real target installer and minimal signed manifest in `serve/`.
The manifest's version is `0.8.0`; its Windows URL is the artifact above and its
signature is the actual `.sig` contents. The local server binds only 127.0.0.1,
has no directory listing, rejects unlisted paths/methods, and never serves key
storage or source files:

```powershell
node scripts/updater-qa.mjs serve '<qa-workspace>'
```

## Native evidence still required

Change only `control.json` to select a scenario. Verify no update (204), server
failure, correct notes/version, progress, cancelled/stale downloads, duplicate
rejection, modified artifact, foreign public-fixture signature, mismatched signed
version, redirects and external artifact URL rejection. Unit fixtures do not
claim a valid signature; the Native success case requires the owner's real signed
target. Use an existing published foreign signature fixture, without generating
another key or reading a foreign private key.

Save synthetic input through the canonical HTML adapter and flush it. Record
synthetic favorites/root/language/settings, then require a fresh saved-input
acknowledgement before applying the valid update. Confirm the old QA process
exits, NSIS relaunches the target from the same custom install path, the target's
actual version/hash matches, and saved rows/settings/HTML identity are retained.
Unsaved input is expected to be lost; do not describe it as automatically saved.

Keep original artifact bytes intact: tampering is performed only on the served
stream. Preserve evidence after failures, and never assume rollback. No Actions,
Secrets, Release, publication, firewall/security changes, ordinary-app replacement
or saved-data cleanup belongs to this probe. Record actual passes/failures/unrun
items; preparation and unit tests do not establish installed-update success.

## Preparation verification

Windows preparation passed the three Node fixture/IPC boundary tests, four Rust
QA policy tests, both manifest formatting checks, backend all-target strict
Clippy, default/QA app compile checks and QA app strict Clippy. `npm run check`
passed with 379 formatted files and 221 lint/type files, without warnings or
errors. The canonical storage Node tests passed 33 tests in a sequential run.

The initial public source retained an older generated API-spec fingerprint in
three HTML kit documentation footers. The ordinary generator refreshed only
those fingerprint fields against the already committed storage specification;
adapter/template bytes and API behavior are unchanged. An initial concurrent
storage-test failure was not reproduced after generation and sequential rerun.

No release probe binary, NSIS installation, real signature, Native download,
relaunch or synthetic-input preservation pass is claimed by these checks.
