# Manual distribution candidate builds

This guide describes the prepared GitHub Actions workflow for building Mogledge distribution candidates from a fixed source revision. Local builds remain available. **No candidates have been generated or tested through this workflow yet.** Workflow-native builds, archive/signature checks and downloaded-candidate launch/update remain unverified. Separate owner checks of local builds do not validate an Actions artifact. The Mac 0.7.4 close-menu startup defect is corrected in source, and the owner subsequently confirmed ordinary Mac operation, resident recall and Cmd+W tab closing. The report does not identify an exact binary version/hash or validate a downloaded candidate.

The workflow produces short-lived artifacts whose access follows repository permissions. It does not publish a release or provide an automatic updater, paid signing certificates or macOS notarization.

## Before running

Check the repository owner's GitHub plan, remaining monthly allowance, payment settings, Actions and storage budgets, and usage stop conditions in account Settings → Billing → Usage/Budgets. Usage and storage from other repositories can affect the shared allowance. A zero-dollar budget with usage stopped at the limit does not establish that free minutes remain. Also check the repository's existing Actions policy and permitted actions and runners.

Review the current [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) and [Actions billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions) before execution. Build duration and artifact size have not been measured. Failed jobs, retries, storage and other workflows may consume allowance or incur charges. The 60-minute job timeout is not a spending budget.

Run only after costs, permissions and execution approval have been confirmed. GitHub requires the workflow to exist on the default branch before it can be dispatched; an unmerged draft alone is insufficient. See [manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Platforms and artifacts

Choose **Binary distribution candidates (manual)** in Actions, then select the reviewed source ref and platform. Both `cost_confirmed` and `license_reviewed` default to false; jobs run only when both are true. License review must cover the actual source revision and its bundled code, assets and generated components. An SPDX identifier alone does not establish that redistribution obligations have been met.

| Platform                | Runner                          | Candidate contents                                                              |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `windows-x64` (default) | `windows-2022`                  | Unsigned `my-knowledge.exe`, with product name Mogledge, in a ZIP; no installer |
| `macos-arm64`           | `macos-15`                      | Apple Silicon `Mogledge.app`, with an ad-hoc signature, in a ZIP                |
| `macos-x64`             | `macos-15-intel`                | Intel `Mogledge.app`, with an ad-hoc signature, in a ZIP                        |
| `all`                   | All three runners, sequentially | Three separate artifacts                                                        |

The workflow uses explicit native targets matching the [runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). It does not produce a universal Mac binary or validate Rosetta compatibility. Builds use Node 24.11.0, Rust 1.99.0, npm/Cargo lockfiles and Cargo `jobs=1`, without E2E features. The workflow has `contents:read`, retains no checkout credentials, references no secrets and has no push, pull-request or tag trigger. It saves no dependency cache, and artifacts expire after three days. The separate macOS validation workflow is for Native QA.

ZIP names follow `Mogledge_<version>_<platform>_<unsigned|adhoc>_<first 12 source SHA characters>.zip`. Each artifact also contains `SHA256SUMS.txt` and `manifest.json`. The ZIP includes the app, manifest, Mogledge's MIT `LICENSE`, third-party license and NOTICE files, required package sources, a `source.zip` of the exact application revision, and this guide.

The manifest records the complete source SHA, product version, target and architecture, signature type, Node/Rust versions, executable and source ZIP SHA-256 hashes, and pending QA. Use the complete SHA to identify the source; a branch name can change.

## Build and packaging checks

The pipeline is designed to reject inconsistent product versions or identity, modified tracked source files, a checkout SHA mismatch, unexpected toolchains, and signing-key or updater-artifact configuration.

Third-party inventory conservatively covers npm production packages and the target-specific Cargo normal/build dependency closure. Including build dependencies does not make this an audit of precisely which code is linked into the final binary. The collector retains package license, copyright and NOTICE files. Missing or unsupported license declarations, incomplete license sections, unsafe paths and legal-file symlinks stop packaging before upload. Packages declaring MPL-2.0 and local Cargo packages, including patched wry, also include their package source. Application source and lockfiles are preserved in the same-revision `source.zip`.

The 0.7.2 material review (`docs/license-materials.md` in the extracted `source.zip`) retains pinned upstream complements and exact WebView2 SDK LICENSE/NOTICE material. Windows package text collection now passes 314/314; each Mac passes 301/315, with 14 Objective-C packages still blocked by provenance/Apple SDK review. Complete terms have now been retrieved for the four MIT-only packages too, while applicable copyright-notice coverage remains unresolved. The dependency identities are unchanged from the original diagnosis; see the material review for the evidence-reuse scope. Keep `license_reviewed` false until the selected platform and source have satisfied their requirements. Mac-only blockers do not apply to a Windows-only selection; `all` requires independent completion for all three targets. Windows remains unapproved pending its own asset, SDK/toolchain and final-closure review. Check their original sources and redistribution conditions before supplying missing material; do not remove the gate simply to obtain an artifact. Final review must also cover generated code, embedded native components and SDKs, icons and other assets, complete copyright/NOTICE requirements, and source-availability obligations. Inventory collection and license-text markers do not complete that review.

Windows checks cover the executable's x64 PE architecture, ProductName/FileDescription, ProductVersion/FileVersion and Authenticode `NotSigned` status. Mac checks cover bundle name, identifier, version, executable architecture, `codesign --verify --deep --strict`, `Signature=adhoc` and an unset TeamIdentifier. Mac ZIP creation uses `ditto` to preserve permissions and resource forks, followed by signature, architecture and executable-hash checks after extraction. Windows extraction is also followed by PE verification and executable-hash comparison. The pipeline computes the archive SHA-256 and uploads only after its checks pass. These native tool paths have not yet been exercised.

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

Static checks and small Node fixtures do not establish native build or distribution readiness. The following remain unverified:

- The first Actions build and full Cargo dependency/license collection, including any missing legal material and final native-component or asset obligations.
- PE, codesign and ZIP-tool execution on the selected native runners.
- Downloading each candidate to its target OS, preserving the bundle, handling OS warnings, and launching it successfully.
- Updating an existing installation while preserving saved data, settings, roots, favorites, workspace sets and resident/startup behavior.

Record the complete source SHA, artifact hash, architecture, OS, operations, expected behavior and actual results before deciding whether to distribute a candidate. Keep incomplete checks explicit. The prepared Mac configuration uses `signingIdentity: "-"`; the application identifier and data locations remain unchanged. Candidate versions come from the checked product manifests. Coordinate the product version once per release, and validate the resulting artifacts before publishing.
