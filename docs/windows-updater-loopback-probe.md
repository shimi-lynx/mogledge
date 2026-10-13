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

Tauri's pinned code generator replaces runtime `createUpdaterArtifacts` with its
default. The QA build script retains only that enrollment boolean from the
compile-time overlay, without embedding its private paths. QA initialization uses
this compiled decision plus the exact identity and signed loopback configuration;
ordinary updater initialization remains unchanged. The initial baseline built and
installed, but exited before profile initialization because it checked the elided
runtime field. That failed probe is retained separately; it is not a launch pass.

Install the baseline only at the confirmed new QA directory using `/NS` and the
reviewed install path. Verify separate profile, database, registry and actual EXE
paths before writing synthetic inputs. Preserve the ordinary app/process,
shortcuts, login registration and all user data. Updater signing is distinct from
Authenticode; report OS protection prompts without bypassing them.

Run baseline installation, registration checks and application launch in the same
unelevated user desktop environment. A launcher can inherit a separate registry
view even when Windows reports no package identity. Use the existing Explorer
desktop for all three steps and verify its actual results; a package-status check
alone does not establish a shared environment. Do not change privileges, ACLs or
security settings to reconcile different views.

Before applying an update, confirm the QA identifier and actual executable
version/hash, then compare its parent directory with both the default value of
`HKCU\Software\Mogledge QA\MogledgeUpdaterQA` and `InstallLocation` under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MogledgeUpdaterQA`.
Read these keys in the same desktop environment as the running QA app. Both must
resolve to the confirmed custom directory. The pinned updater does not supply the
running directory as an NSIS `/D` argument; the installer restores its previous
location from that product registry key and otherwise uses its default directory.

If a probe already installed elsewhere, preserve that failure state before a
retest. Save synthetic inputs and normally quit every QA instance. Back up QA
settings, document state, synthetic files and both installed QA directories to a
new private location, recording hashes and the original QA registration. Copy a
SQLite database only after all QA processes have exited, or use its backup API;
an arbitrary live copy is not a verified backup. Refuse baseline installation
while any QA instance remains running, and verify the backup before proceeding.
Use overwrite/update mode at the reviewed custom directory to retain the QA
profile; preserve the other installed copy and all original evidence. Reuse the
unchanged verified target artifact and signature. A procedure correction alone
does not require rebuilding or resigning that target.

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

Preparation checks alone do not establish Native success. The first release
baseline and isolated NSIS installation completed, but the startup guard rejected
the elided packaging field before any QA profile was initialized. A real signature,
Native download, relaunch and synthetic-input preservation remain unverified.

The corrected QA enrollment passed an app-crate regression using the real
`generate_context!` output: the packaging field is elided while the compiled
enrollment and signed loopback policy are retained. App fmt and QA strict Clippy
also passed. This regression does not replace the next installed launch probe.

The corrected baseline subsequently completed a signed Native download and
automatic relaunch to 0.8.0. The synthetic root and saved input survived, but the
target launched from the default directory while the custom-directory baseline
remained 0.7.99. Read-only comparisons then found different QA registry values
between the installation launch environment and the existing Explorer desktop.
This establishes an environment mismatch and explains the installer fallback;
the subsequent comparison installed and launched the retained baseline through
the same existing Explorer desktop, then applied the unchanged signed target.
The 0.8.0 process and both registry locations retained the original custom path,
and the executable matched the retained target hash. The earlier default-path
copy and the pre-retest state backup were preserved.

Before baseline installation, all QA processes had exited normally. The private
state backup passed retained-file hash checks, SQLite integrity checks and a
restore to a separate directory using the SQLite backup API. After the update, a
read-only connection to the dedicated QA database produced a consistent snapshot
through that API. The copied database retained the synthetic app's input
`amount=7`, `mode=double`, `enabled=true` and revision; its calculation gives 14.
The synthetic root was retained. These checks establish saved-state preservation,
not observed reopening of the document tab or rendered input restoration.

The normal update's custom-path comparison passed. The complete Native suite
remains incomplete: modified-artifact, invalid-signature and communication
failure checks remain unrun for this probe. Those results must not be inferred
from the successful update, preparation tests or independent signature checks.
