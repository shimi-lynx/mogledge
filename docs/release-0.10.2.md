# Mogledge 0.10.2

This patch fixes updater restart admission before a pending tab-session save, updates Node runtime pins and npm/Rust dependencies, and clarifies the English and Japanese product pages. The application identifier and existing profile are unchanged. Issue [#22](https://github.com/shimi-lynx/mogledge/issues/22) remains open: the Apple Silicon failure's cause and Native updater acceptance are not established.

## Verification and limits

The individual PRs record their targeted checks. On integrated main `18e19d74f0f11c1b7a08a5cbd1d4654b2ec2b99c`, the distribution fixtures passed 50 tests with five environment/opt-in skips. The first candidate run failed before compilation because the newly updated formatter rejected a Markdown table. PR #90 corrected whitespace only; `npm run check` then passed on Windows with Node 24.22.1 and npm 11.19.1. The full test suite was interrupted, with one initial StorageTransition failure whose details were not captured; a later isolated run passed 16 tests. Neither result establishes a full-suite pass.

Production npm audit reported zero findings. Development tooling retains four unique advisories across 18 affected package entries; the application Rust lock retains three `zip` advisories and five informational warnings. Upstream fixes or compatibility work remain necessary. Existing-device Native updater, physical Apple Silicon update/restart and SEO heading appearance at desktop/mobile widths were not verified. Windows executables remain unsigned by Authenticode, and Mac bundles use ad-hoc signing without Developer ID or notarization; updater signatures are a separate layer.

The English and Japanese Pages deployment succeeded from `18e19d74f0f11c1b7a08a5cbd1d4654b2ec2b99c`, and anonymously served HTML matched that source. The later #90 commit changes only a repository Markdown table, not the site.

## Candidate signing activation

[Candidate run 40509685821](https://github.com/shimi-lynx/mogledge/actions/runs/40509685821) succeeded on all three platforms from merged main `90ce7a331564292d5080763c3653edaa4305ff3a`. The workflow checked native executable versions, architecture, packaged materials, and bounded hosted-runner install/update probes. Each receipt reports `passed` with the same source and version; these synthetic checks do not establish the unrun device acceptance above.

The following immutable artifacts were downloaded and checked against GitHub size and SHA-256 metadata. Each manifest, archive checksum and embedded source was checked against the fixed main source. The common source ZIP SHA-256 is `71d39a2c46dee821c64b07689279ea41788714774e8fa79015f108559c42364a`.

| Platform    | Artifact ID   | Outer artifact SHA-256                                             | Expiry UTC          |
| ----------- | ------------- | ------------------------------------------------------------------ | ------------------- |
| Windows x64 | `12736668824` | `4b0959bc51000f0f89e2af4ca507a81972f79cf7a44cbf1133c3cdbbee984bed` | 2026-10-30 13:21:00 |
| macOS x64   | `12737594048` | `12b02f94e80d17c533f1233ca88778e450937438233b1e53c6577ddde23107c0` | 2026-10-30 13:33:45 |
| macOS ARM64 | `12737156317` | `1638650168632547ddd9119d809a3b80dade1fc34554c86069126c5ed0ddb44f` | 2026-10-30 13:19:12 |

The Windows NSIS update payload SHA-256 is `e0005d2852874c67ad832d0e6f6e49001104172dcc2a026c9535d7808d7c5853`; the macOS ARM64 payload SHA-256 is `e7bce1ed9470ada02f20c72871a44dde5afb669f70058a060e90aed9e3b32031`. The Intel Mac receipt records payload SHA-256 `4aa026eaf0e59b946eb2f98cf90c3453a90b138d750e656f759fdef808ab41f1`. Each matches its bounded Native probe receipt.

Signing is enabled only for these exact reviewed candidates; publication remains disabled until a separate successful signature-verification artifact is pinned. This policy and evidence change does not change the binary source or rebuild the app.

## Verified signing and publication activation

[Signing run 40514213749](https://github.com/shimi-lynx/mogledge/actions/runs/40514213749) succeeded on attempt 1 from tooling main `7391941610644b358c36f6879299578de11b89e0`. Its separate Secrets-free public-key verifier checked all three updater signatures and signed version 0.10.2. The binary source remains `90ce7a331564292d5080763c3653edaa4305ff3a`.

The verified artifact is `production-verified-0.10.2-40514213749-1`, ID `12738581600`, size `149504014`, SHA-256 `1282b21d1cdbddf72a0e6fc91291c0ce3e37d01054d299e1021ecda08b396d07`, expiring `2026-10-30T13:41:58Z`. Its raw digest matches GitHub metadata. The twelve staged assets, receipt and checksums match the reviewed candidates; feed entries use the exact matching signatures and versioned HTTPS asset URLs. The publication workflow independently repeats source, checksum, feed and signature validation before writing.

Publication is enabled only for this verified output. Public Release, tag and anonymous latest-feed verification remain pending at this activation stage. Existing-device Native update acceptance remains unrun.
