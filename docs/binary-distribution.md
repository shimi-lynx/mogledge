# Manual distribution candidate builds

The explicitly selected updater mode prepares unsigned Windows NSIS or enrolled Mac archives without production Secrets. The [production distribution procedure](production-distribution.md) defines final-source builds, pinned artifact checks, protected-main signing and separate manual publication. Signing and publication require their own exact enabled pins; a candidate run alone does not publish a Release or update feed.

This guide describes the GitHub Actions workflow for building Mogledge distribution candidates from a fixed source revision. Local builds remain available. Initial preparation had no workflow-native build or downloaded-candidate evidence. Subsequently, [run 38495813692](https://github.com/shimi-lynx/mogledge/actions/runs/38495813692) successfully built and packaged the enrolled Intel Mac 0.8.1 candidate from source `ccdcccab85c6c2ad18b063989c049c0a013229eb`, producing artifact `11865015479`. The owner reported launching and using that downloaded app after removing its quarantine attribute. This establishes the reported 0.8.1 run and owner use, not a formal 0.8.2 distribution, an updater signature, a live feed or a real in-app update.

Earlier owner checks of local builds remain separate: the Mac 0.7.4 close-menu startup defect was corrected in source, and the owner confirmed ordinary Mac operation, resident recall and Cmd+W tab closing. That earlier report did not identify an exact binary version/hash or validate an Actions artifact.

The workflow produces short-lived artifacts whose access follows repository permissions. It does not publish a release or provide an automatic updater, paid signing certificates or macOS notarization.

## Before running

Check the repository owner's GitHub plan, remaining monthly allowance, payment settings, Actions and storage budgets, and usage stop conditions in account Settings → Billing → Usage/Budgets. Usage and storage from other repositories can affect the shared allowance. A zero-dollar budget with usage stopped at the limit does not establish that free minutes remain. Also check the repository's existing Actions policy and permitted actions and runners.

Review the current [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) and [Actions billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions) before execution. Build duration and artifact size have not been measured. Failed jobs, retries, storage and other workflows may consume allowance or incur charges. The 60-minute job timeout is not a spending budget.

Run only after costs, permissions and execution approval have been confirmed. GitHub requires the workflow to exist on the default branch before it can be dispatched; an unmerged draft alone is insufficient. See [manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Platforms and artifacts

Choose **Binary distribution candidates (manual)** in Actions, then select the reviewed source ref and platform. Enter the approved full 40-character source commit in `expected_source_sha` and select the ref containing that same commit. Checkout, the dispatch event and this input must agree before dependency installation; the builder checks again. A moved branch or wrong SHA fails. The final source/version must be coordinated after parallel product work is integrated; do not build an isolated QA branch as a distribution candidate.

Both `cost_confirmed` and `license_reviewed` default to false; jobs run only when both are true. Reuse unchanged account/budget/policy confirmations; inspect billing only for a related failure or known change. Confirm that adopted legal texts/notices and required sources cover the selected revision, including any new dependencies. An SPDX identifier alone is not a notice or full license text.

| Platform                | Runner                               | Candidate contents                                                              |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `windows-x64` (default) | `windows-2022`                       | Unsigned `my-knowledge.exe`, with product name Mogledge, in a ZIP; no installer |
| `macos-arm64`           | `macos-15`                           | Apple Silicon `Mogledge.app`, with an ad-hoc signature, in a ZIP                |
| `macos-x64`             | `macos-15-intel`                     | Intel `Mogledge.app`, with an ad-hoc signature, in a ZIP                        |
| `all`                   | Three separate runners, concurrently | Three separate artifacts                                                        |

The workflow uses explicit native targets matching the [runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). It does not produce a universal Mac binary or validate Rosetta compatibility. Builds use Node 24.11.0, Rust 1.99.0, npm/Cargo lockfiles and Cargo `jobs=1`, without E2E features. The workflow has `contents:read`, retains no checkout credentials, references no secrets and has no push, pull-request or tag trigger. It saves no dependency cache, and artifacts expire after three days. The separate macOS validation workflow is for Native QA.

ZIP names follow `Mogledge_<version>_<platform>_<unsigned|adhoc>_<first 12 source SHA characters>.zip`. Each artifact also contains `SHA256SUMS.txt` and `manifest.json`. The ZIP includes the app, manifest, Mogledge's MIT `LICENSE`, third-party license and NOTICE files, required package sources, a `source.zip` of the exact application revision, and this guide.

The manifest records the complete source SHA, product version, target and architecture, signature type, Node/Rust versions, executable and source ZIP SHA-256 hashes, and pending QA. Use the complete SHA to identify the source; a branch name can change.

## Build and packaging checks

The pipeline is designed to reject inconsistent product versions or identity, modified tracked source files, an approved/event/checkout SHA mismatch, unexpected toolchains, and signing-key or updater-artifact configuration.

Third-party inventory conservatively covers npm production packages and the target-specific Cargo normal/build dependency closure. Including build dependencies does not make this an audit of precisely which code is linked into the final binary. The collector retains package license, copyright and NOTICE files. Missing or unsupported license declarations, incomplete license sections, unsafe paths and legal-file symlinks stop packaging before upload. Packages declaring MPL-2.0 and local Cargo packages, including patched wry, also include their package source. Application source and lockfiles are preserved in the same-revision `source.zip`.

The retained material research contains complete texts, copyright/NOTICE files, pinned supplements and source-provenance evidence. Earlier records describe fourteen Mac interpretation-review blocks (fifteen with the optional updater); those historical diagnoses remain unchanged. The owner has now adopted the previously researched material for packaging without broadening interpretation research. Each existing note is retained; `adoptedReviewSha256` binds adoption to the complete pinned material entry, including package/source identities, legal file hashes and the note, and the packaged inventory preserves `reviewNote` plus `reviewPolicy: existing-material-adopted`. This records the packaging decision, not a legal certification.

Concrete inclusion checks still run: package/source/lock identities, complete non-reference license text, unchanged supplemental/SDK bytes, copyright/NOTICE collection, required source and safe paths. Changed material records or newly flagged notes without a matching adoption record still stop. Missing mandatory material or a new major issue must be reported rather than replaced by an SPDX declaration, a reference-only text or a broad bypass. The Intel Mac 0.8.1 run completed its build, verification and packaging job; prior source research alone was not an artifact result. New source versions and other platforms require their own candidate checks.

Windows checks cover the executable's x64 PE architecture, ProductName/FileDescription, ProductVersion/FileVersion and Authenticode `NotSigned` status. Mac checks cover bundle name, identifier, version, executable architecture, `codesign --verify --deep --strict`, `Signature=adhoc` and an unset TeamIdentifier. Mac ZIP creation uses `ditto` to preserve permissions and resource forks, followed by signature, architecture and executable-hash checks after extraction. Windows extraction is also followed by PE verification and executable-hash comparison. The pipeline computes the archive SHA-256 and uploads only after its checks pass. The enrolled Intel Mac 0.8.1 run exercised its Mac build/package checks; this does not establish the Windows, Apple Silicon or later-version paths.

## Downloading and opening a candidate

1. Select the correct platform: Windows x64, or macOS 12+ Apple Silicon (`macos-arm64`) / Intel (`macos-x64`). On a Mac, **About This Mac** shows **Chip** for Apple Silicon or **Processor** for Intel; see [Apple's identification guide](https://support.apple.com/en-us/116943).
2. [Download the run's artifact](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts). A browser download wraps the application ZIP, `SHA256SUMS.txt` and `manifest.json` in an outer artifact archive; extract that first. A GitHub CLI artifact download extracts this layer already. Match the run's complete source SHA, version and platform to the manifest.
3. Compare the **inner `Mogledge_...zip`** hash with `SHA256SUMS.txt`: use `Get-FileHash -Algorithm SHA256 <ZIP>` on Windows or `shasum -a 256 <ZIP>` on macOS. The listed checksum is for the application ZIP, not the browser's outer download. A checksum detects changed bytes; it is not an authenticated publisher signature.
4. Extract the verified application ZIP into a new directory. It contains a candidate folder with the app and companion materials. Keep the complete Mac bundle and retain the license, NOTICE and source material when redistributing the package.
5. For first use, place `my-knowledge.exe` in a chosen fixed folder on Windows, or the complete `Mogledge.app` at a chosen fixed Mac location, such as Applications. Open that EXE or bundle. For an existing installation, quit the old app, back up the app/profile/HTML and follow `docs/update-guide.md` in the extracted `source.zip` before replacing its confirmed fixed target. The ZIP is not an installer and provides no automatic update.

Running a completed ZIP does not require Node, Rust, MSVC or Xcode build tools. Windows does require the [WebView2 Runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution); if missing, obtain Microsoft's Evergreen Runtime for the device. The Windows executable is unsigned. SmartScreen or organizational policy may warn or block it. Check its origin and source/hash correspondence, and proceed only as permitted by your policy. Do not disable Defender or other OS protections globally. Source-building instructions are in `docs/first-run.md` in the extracted `source.zip`.

[Tauri's macOS ad-hoc signature](https://v2.tauri.app/distribute/sign/macos/) is neither an Apple-authenticated Developer ID signature nor notarization. Internet downloads may still require an app-specific Gatekeeper exception. Only for an app whose origin and hash you have checked and trust, follow [Apple's opening instructions](https://support.apple.com/en-us/102445), including Privacy & Security → Open Anyway when available. Follow administrator policy if an exception is unavailable. Do not disable Gatekeeper globally or remove quarantine in bulk. OS code signing and Tauri updater signing are separate; this workflow adds no updater keys or update service.

For unrestricted file-management use, choose a local folder outside synchronization. The limited Windows OneDrive writer supports locally retained HTML/folder creation, and the owner has confirmed file creation. Nonempty-folder move/delete restrictions are accepted and deferred; broader OneDrive compatibility is not established.

## Required validation before distribution

Static checks and small Node fixtures do not establish native build or distribution readiness. The Intel Mac 0.8.1 run and owner startup/use above are completed evidence for that source and platform. The following still need source- and platform-specific evidence:

- New candidate builds and their Cargo dependency/license collection, with adopted texts/notices and required sources actually included; report concrete missing material or newly introduced dependencies. The 0.8.1 Intel run is not a 0.8.2 artifact result.
- PE, codesign and archive-tool execution for platforms or revisions beyond the completed Intel Mac 0.8.1 run.
- Target-OS download, bundle preservation, OS trust handling and launch for candidates beyond the owner's reported Intel Mac 0.8.1 use.
- Updating an existing installation while preserving saved data, settings, roots, favorites, workspace sets and resident/startup behavior.

Record the complete source SHA, artifact hash, architecture, OS, operations, expected behavior and actual results before deciding whether to distribute a candidate. Keep incomplete checks explicit. The prepared Mac configuration uses `signingIdentity: "-"`; the application identifier and data locations remain unchanged. Candidate versions come from the checked product manifests. Coordinate the product version once per release, and validate the resulting artifacts before publishing.

## Coordinated execution handoff

Use the ordinary candidate workflow first, starting with a single selected platform rather than `all`; other targets can follow after their own actual checks. It produces unsigned/ad-hoc app-only artifacts with `updater: false`. No updater private key, Authenticode certificate, Apple credential or new signing subscription is required by this workflow. Enrolled NSIS/macOS updater artifacts and their update signatures remain a separate approved procedure.

Before a run, read the actual repository Actions policy/workflow state, permitted pinned actions and owner's shared remaining minutes/storage, budget and stop-at-limit policy. Inspect any relevant Secrets only by name/metadata; no secret values are needed. If these settings cannot be read through the authorized route, report the unavailable evidence and obtain owner-side read-only confirmation rather than using alternative credentials or assuming free quota. Resumed Actions preparation alone does not confirm sufficient free quota or change a paid budget.

After source/version coordination, supply that exact commit, selected platform and both confirmations. Record run ID, source SHA, runner image/architecture and actual result; inspect the archive, source ZIP, version, executable and archive hashes, license/NOTICE/source inclusion, and actual downloaded-app behavior. Do not automatically retry failed native jobs or dispatch the separate broad macOS QA workflow. No push/PR/tag trigger, public visibility change, Release publication or credential registration is added here.

## First Mac installation with updater support

An ordinary 0.8.1 app-only candidate remains updater-disabled. The explicit `updater_app` mode prepares an enrolled Mac app plus a separate .app.tar.gz for owner-local signing, without adding a signing key to Actions. It defaults false and requires one selected Mac platform. See [enrolled Mac artifacts](enrolled-mac-actions.md) for configuration, pinned-CLI build/bundle separation, complete in-app notice/source inclusion, scoped existing-term evidence and the native checks still required. This preparation must be integrated with the separately reviewed production build-time enrollment correction and final product source before a single first-install build; it does not authorize building the preparation's 0.8.0 base or publishing the private feed.
