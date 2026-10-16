# Mogledge 0.10.1

[Mogledge 0.10.1](https://github.com/shimi-lynx/mogledge/releases/tag/v0.10.1) is published for Windows x64, Intel Mac and Apple Silicon from fixed binary source `19f8d035d19838d04574f6a8081a4374b77bdc1c`. This patch combines three fixes with the dedicated-folder and local AI authoring guidance merged in #67. The product version advances once from 0.10.0 to 0.10.1; the identifier, executable names and existing profile remain unchanged. Candidate, signing, publication and public readback evidence is recorded below; publication does not replace an installed user app.

- The two remaining folder-creation buttons fill the sidebar action row in English and Japanese, including narrow sidebars.
- Mac document find shows current/total counts, all-match and current-match highlights, zero results, bounded partial-result feedback and visibility refresh after resizing. See the [user guide](user-guide.md).
- Opening HTML and constructing an adapter do not display document-ID guidance. A Native storage operation makes existing identity-hold reasons and explicit remedies visible. Native identity checks, rejected-operation errors, restoration gating and saved-data protection remain intact. See [document storage](document-storage.md).

## Verification scope

Targeted regressions cover the folder row geometry and labels, document-find counts/highlights/navigation/cleanup/bounds/resize, and storage-adapter signaling plus authenticated iframe message handling. Independent source reviews found no remaining blockers after the find scan and resize followups. The broader tree-actions fixture fails at its missing-root label on both baseline and changed code; this pre-existing fixture failure is not reported as passed.

- `npm run check` passed without warnings, lint or type errors after the final test-helper corrections.
- App, document-ready bridge and display-folder controller tests: 64 passed. Storage adapter and operation-notice tests: 20 passed.
- All 13 find cases are covered by passing targeted runs; 22 existing document-keyboard cases passed. The two final type/focus helper cases passed again with typed lint denying warnings. Folder geometry passed four English/Japanese width cases and the existing label suite passed two cases.
- `cargo fmt` passed for the app and backend harness. The release-profile backend test `served_descriptor_preserves_sandbox_and_original_document` passed (one selected, 17 filtered out); backend harness `cargo clippy --release --locked --all-targets --jobs 1 -- -D warnings` passed. The existing release dependency cache was reused with one Cargo job; no full Rust suite or new local app build was run.
- `node --test scripts/distribution/native-probe.test.mjs`: 9 passed. Linux Python `unittest` for `scripts/release/test_release.py`: 22 passed after updating both valid-version fixtures and rejected old/future versions. Changed documentation formatting, local links and diff checks passed.

Browser and mock results do not establish physical Mac Cmd+F, IME, accessibility or WKWebView behavior. Existing-device updater UI, login launch and OS permissions remain distinct from candidate metadata, signatures and bounded synthetic installed-update checks. These device followups remain tracked in #48, #55, #60 and #66. No ordinary user app, settings, HTML or saved input is replaced during release preparation.

For users transitioning from the older My Knowledge identity, preserve the [0.10.0 identity and login-startup precautions](release-0.10.0.md). Windows binaries are not Authenticode-signed. Mac binaries use ad-hoc signing without Developer ID or notarization; updater cryptographic signatures are a separate verification layer.

## 0.10.1 candidate signing activation

[Candidate run 38921366891](https://github.com/shimi-lynx/mogledge/actions/runs/38921366891), attempt 1, completed successfully from main `19f8d035d19838d04574f6a8081a4374b77bdc1c`. Downloaded raw artifact identities, sizes, hashes, expiry, architecture, product version, identifier and embedded source matched the fixed metadata. All three platform Native packaging reports have status `passed` and bind to the same source, version and updater payload bytes. Common embedded source ZIP SHA-256: `e68ccec57a29b97ece919fbc0ffdc75d56fabddad6d44bd8053754619cd41203`.

The Windows executable and NSIS both report FileVersion and ProductVersion `0.10.1`; the installer filename includes `0.10.1`. Both Mac bundles report `0.10.1`, identifier `com.shimilynx.mogledge` and executable `mogledge`, with their expected x64/arm64 Mach-O architecture. Their embedded source contents match the fixed Git source archive.

| Platform    | Artifact ID   | Raw artifact SHA-256                                               | Expiry UTC             |
| ----------- | ------------- | ------------------------------------------------------------------ | ---------------------- |
| windows-x64 | `12054872975` | `75e2e424f473e2d49a5b8f1daed9f6e5366c64b600adc56cba6f97035b424bd8` | `2026-10-19T15:19:17Z` |
| macos-x64   | `12055514741` | `cc25d0fc295b83a7a31d39d18e8e76039212b3ed381a5f892b7105c9212ebcd0` | `2026-10-19T15:29:30Z` |
| macos-arm64 | `12055521186` | `920d93afae9423f00615d41f0f7594a295cc7fc4303bc21b8847fa0ab82a000a` | `2026-10-19T15:14:42Z` |

These are bounded disposable-runner packaging checks. Existing-device updater UI/signature handoff, login-session, physical keys, accessibility and OS permission acceptance remain separate. No local installed app/profile was accessed by candidate inspection.

Signing pins only these reviewed candidates and the existing protected-main gate. Publication remains disabled until separately verified signature-output pins are reviewed. This policy/evidence activation does not change the fixed binary source. Historical 0.10.0 and earlier release records remain unchanged.

## Verified 0.10.1 signing and publication activation

[Signing run 38924844884](https://github.com/shimi-lynx/mogledge/actions/runs/38924844884), attempt 1, passed preparation, protected signing and separate Secrets-free public-key verification from main `3f35406980f82d47ae536557fe7321c4dde9bc8f`. All three updater signatures and signed product version 0.10.1 passed. No key/password was retrieved or displayed.

The reviewed verification artifact is `12056167290`, 149256456 bytes, SHA-256 `32161c082465a0abc3a651c8a410587b5099c29a40c8e7c37288673b6da6c037`, name `production-verified-0.10.1-38924844884-1`, expiring `2026-10-19T15:33:56Z`. The successful same-source/same-artifact signature verification is reused; publication independently revalidates the complete artifact, receipt, feed and signatures before writing.

Only these verified-output pins enable publication. Binary source remains `19f8d035d19838d04574f6a8081a4374b77bdc1c`; candidate pins, public key/feed, protected-main gate, previous releases and workflow files are unchanged. This policy/evidence-only change requires no product bump, rebuild or re-signing. Public Release/tag/asset/latest readback remains pending at activation. Existing-device updater, login-session, permission and physical-key acceptance remains separate.

## Actual 0.10.1 publication and minimum verification

[Mogledge 0.10.1](https://github.com/shimi-lynx/mogledge/releases/tag/v0.10.1), Release ID `415118272`, is public and latest with 12 uploaded assets. Its tag points to fixed binary source `19f8d035d19838d04574f6a8081a4374b77bdc1c`. [Publication run 38925277421](https://github.com/shimi-lynx/mogledge/actions/runs/38925277421), attempt 1, passed from tooling main `921409ad372fd9490bdd7b022781302ef5c461ee`. Earlier candidate and signing records bind the actual compiled source; later policy/documentation commits do not change those binaries.

Readback confirmed Release/tag/latest identity, all 12 asset digests, receipt/checksum consistency and unchanged 0.10.0/0.9.1/0.9.0 release asset identities. Anonymous latest-feed SHA-256: `e146e7f8a3cdecf7d26919a2ba277b9f6839132cbf83d8c06938d7715aa33d7a`. The successful publication workflow anonymously downloaded the latest feed and all three updater payloads and compared their bytes with verified output. Post-publication checks confirmed all 12 public asset URLs returned HTTP 200 and the global latest route matched the tagged feed bytes. These checks do not establish an installed-device update.

| Platform    | Published updater payload SHA-256                                  |
| ----------- | ------------------------------------------------------------------ |
| windows-x64 | `cbe49ec943f85236d33a1c2ca10aa039b67a5398eb5ad1d337e6956beead2ae6` |
| macos-x64   | `76d33f0883ba78ab5c55ccdda625958b65f987bd9fe7bfc2860f81b4ad6547a7` |
| macos-arm64 | `064077b6962a050e4d08192742643a018cc6a6056d51bb7768300e4fb4b32391` |

Initial installation downloads:

- [Mogledge_0.10.1_windows-x64_unsigned_updater_19f8d035d198-setup.exe](https://github.com/shimi-lynx/mogledge/releases/download/v0.10.1/Mogledge_0.10.1_windows-x64_unsigned_updater_19f8d035d198-setup.exe)
- [Mogledge_0.10.1_macos-x64_adhoc_updater_19f8d035d198.zip](https://github.com/shimi-lynx/mogledge/releases/download/v0.10.1/Mogledge_0.10.1_macos-x64_adhoc_updater_19f8d035d198.zip)
- [Mogledge_0.10.1_macos-arm64_adhoc_updater_19f8d035d198.zip](https://github.com/shimi-lynx/mogledge/releases/download/v0.10.1/Mogledge_0.10.1_macos-arm64_adhoc_updater_19f8d035d198.zip)

Windows remains without Authenticode; Mac bundles are ad-hoc signed without Developer ID/notarization. Updater signatures authenticate the reviewed payloads, not OS trust or device acceptance.

The public verification receipt retains its pre-publication fields (`published: false`, `nativeUpdateTested: false`); actual public state and bounded hosted-runner checks are recorded separately. Existing local installations, settings and documents were not changed by these checks. Actual existing-device updater UI/signature handoff, login-session/permission behavior and physical-key/accessibility acceptance remain separate. Historical release records are preserved. Website publication is tracked separately.
