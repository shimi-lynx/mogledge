# Mogledge 0.10.3

This patch replaces the tree and favorites disclosure glyphs with a shared centered SVG while preserving the 12px slot, file spacer, indentation, click targets and accessible state. It introduces no new dependencies. The product identifier and user profile are unchanged.

## Verification and limits

The tree and favorites regressions passed 41 targeted tests. A Chromium fixture using the application CSS showed centered open and closed arrows, nested rows and favorites, with the 12px slot and file spacer retained. The actual Native app's visual appearance was not checked. The final integrated source also passed `npm run check` on Windows with Node 24.22.1 and npm 11.19.1. Linux release policy fixtures passed 22 cases; the Windows Native probe fixture passed eight with one environment-dependent skip.

The earlier full test suite was interrupted after one initial StorageTransition failure with no captured details; a later isolated 16-test run passed, but a full-suite pass is not established. Native updater and physical Apple Silicon update/restart acceptance remain incomplete, and the Apple Silicon failure cause is unconfirmed; [#22](https://github.com/shimi-lynx/mogledge/issues/22) remains open. The prior site headings have not been visually checked at desktop and mobile widths.

The previous production npm audit reported zero findings. Development tooling retains four unique npm advisories across 18 package entries; the Rust application lock retains three `zip` advisories and five informational warnings. Windows binaries are not Authenticode-signed; macOS bundles use ad-hoc signing without Developer ID or notarization. Updater signatures are separate from OS trust.

## Candidate signing activation

[Candidate run 40533789423](https://github.com/shimi-lynx/mogledge/actions/runs/40533789423) completed successfully on all three platforms from merged main `da2148148f3b99efb32b95aa0d0caefee615450c`. The workflow verified source, product version, architecture, candidate packaging and bounded disposable-runner Native probes. These probes do not establish existing-device updater acceptance.

The reviewed artifacts are bound to that source and version:

| Platform    | Artifact ID   | Artifact SHA-256                                                   | Expiry UTC          |
| ----------- | ------------- | ------------------------------------------------------------------ | ------------------- |
| Windows x64 | `12747702679` | `e690e746cbc739f969eac137aade0533ea33bca76821b56ac2861bc4ae902e72` | 2026-10-30 15:53:33 |
| macOS x64   | `12747754616` | `301683399c2a3decdd386daf41231cac0b63a835c7cee1e4b9c627691aebdae1` | 2026-10-30 16:04:48 |
| macOS ARM64 | `12746104621` | `9cface2c18197bb59005639c6ea0aed4bfc87fe6613dbd5745e713d658f0fedc` | 2026-10-30 15:50:30 |

The candidate manifests record the common source archive SHA-256 `2f3464ae5b5aeb645be8f5b3105bbd00ae8463e5cd4450fac1723a51c6999bad`. Windows and ARM64 artifact sizes and hashes were checked against GitHub metadata. The Intel artifact's actual manifest and its archive and updater checksums were checked against its bytes and GitHub metadata. Production signing preparation revalidates all three pinned archives and manifests before the signing job receives secrets. Publication remains disabled until verified signing output is pinned separately.

## Verified signing and publication activation

[Signing run 40548685964](https://github.com/shimi-lynx/mogledge/actions/runs/40548685964) succeeded from tooling main `2f108da81508cdb93f85918edf7c1719a80c07e1`. Preparation validated the three pinned candidates, and the separate Secrets-free verifier checked their signatures and signed version 0.10.3 and generated the staged feed.

The verified output artifact is `12753822151`, size `149534253`, SHA-256 `8bca875480bb4e7bbaed4f27cd3ed9cd21e24b7434ec1a418d6cfc792478f2ee`, expiring `2026-10-30T17:15:46Z`. Publication is enabled only for this exact successful output; the publication workflow independently revalidates the artifact, feed, checksums and signatures before writing. Public Release and feed readback remain pending at this activation stage.
