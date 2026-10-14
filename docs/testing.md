# Testing

## Three verification stages

1. During a change, run relevant checks and tests. Use browser/mock UI checks for an early appearance review and a small Native probe for OS-dependent risks.
2. At an integration or required device check, group the necessary application build and Native QA. Do not repeatedly build an installer or run all suites for every small fix.
3. For an authorized release, validate the actual ordinary binary, version, features and source correspondence. Generate/install an installer only when requested.

HMR is evidence only for behavior faithfully checked in that session. Chromium, mock IPC, synthetic composition and OS-injected keys do not establish physical IME, WebView2/WKWebView or all-device behavior.

## Scope and evidence

Documentation-only changes need targeted format, links and diff checks. TS/React/lint changes need `npm run check`; behavior changes add relevant regressions. Rust changes use the affected crate's fmt/test/Clippy. Broaden checks when a new failure or unresolved concern justifies it.

Existing results may be reused only when their tested code, dependency/configuration, environment and acceptance scope still match. Record the tested source and explain later differences. Keep skipped, ignored, failed and unrun checks explicit. Do not mark Native QA passed based on a build or mock test.

Copy this matrix into a PR:

| Requirement/scope             | Source/environment/command              | Result and evidence                          | Real/mock and limits                |
| ----------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------------- |
| Relevant acceptance condition | Tested SHA, OS, command or manual steps | Pass/fail/unrun; necessary relative evidence | What the check actually establishes |

Keep raw logs, screenshots and private paths outside tracked public documentation. Publish only the necessary review evidence.

## Common commands

```sh
npm run check
npm test -- <relevant-test-path>
npm run test:storage
npm run test:browser -- <relevant-spec>
npm run test:ui -- <relevant-spec> --workers 1
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path tests/backend/Cargo.toml --jobs 1 -- --test-threads=1
cargo clippy --locked --manifest-path tests/backend/Cargo.toml --all-targets --jobs 1 -- -D warnings
```

Use the app crate instead of the backend harness when the change requires it. App builds use the [first-run](first-run.md) commands. The [authoring kit](html-authoring-kit.md) generator and its targeted tests check canonical assets and API hashes.

## Native QA

Use dedicated identifiers and disposable synthetic roots/profiles. `e2e` or a separate WebView directory alone does not isolate a database. Never point a test app at the ordinary profile or use personal knowledge files as fixtures. Check config/identifier/features, executable hash, PID and creation time before ownership-based cleanup; do not stop another app or a user's running instance.

Run heavy Windows operations serially, normally with `--jobs 1`; monitor available RAM and stop owned work before resource exhaustion. Prefer the existing target/cache for matching build inputs. Do not clean useful caches or introduce new tooling just to measure it.

`scripts/validate-windows.ps1` is an integration helper, not a mandatory per-fix command. Its `-Release` option generates NSIS and therefore needs an explicit installer request. `npm run test:production` is deliberately disabled before profile access. Use dedicated QA configurations and approved fixtures instead.

For cloud providers, follow [Cloud-file QA](onedrive-qa.md). Verify provider state/no recall and rejected writes with disposable fixtures. Do not test against a user's synchronized documents.

## Manual Actions and macOS

`.github/workflows/desktop.yml` runs only through `workflow_dispatch` for macOS Native validation. The separate manual candidate workflow supplies the distribution procedure in [binary distribution](binary-distribution.md). Ordinary candidates are app ZIPs; the explicit enrolled production path adds Windows x64 NSIS and Intel/Apple Silicon Mac updater archives. See [production distribution](production-distribution.md) for the separate owner-approved signing/publication workflows. Candidate runs require cost and license gates; Actions artifacts expire after three days. Review the account's actual plan, shared usage, budgets and repository Actions policy and obtain run approval before dispatching. A timeout is not a billing budget.

Preparation, static checks and small fixtures do not establish a completed candidate build. Every source/platform needs actual dependency/material collection, PE/codesign/archive and downloaded-artifact evidence. The [0.8.2 record](production-distribution.md#actual-publication-and-anonymous-verification) establishes packaging, cryptographic and public-byte checks for its fixed source; downloaded-app Native launch/update/data-preservation/restart remain owner QA. Neither a candidate build nor a past macOS validation result establishes all current-source Native behavior. No push, pull request or tag automatically publishes a release.

Record [known limitations](known-limitations.md), including physical keys/IME, native pickers, codecs, cloud providers, installer and migration checks that remain unverified.
