# Updater signing trial: disabled until human approval is enforceable

This prepares a private artifact-only signing and verification trial. It does not build or execute the application, publish assets, create a Release/tag, construct `latest.json`, change repository visibility/settings, or install/update an app. Product version stays **0.8.1**. The application and PRs #11/#12 are outside this tooling change.

## Current blocker and approval contract

The owner registered the names `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in Environment `release`. Their values have not been retrieved, checked, logged or used. Secret names and an Environment's existence do **not** establish an approval gate.

[GitHub's environment reference](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) states that Required reviewers are available only for public repositories on Free, Pro and Team. Private Free also does not support Environment secrets; upgrading only to Pro/Team does not provide private Required reviewers. The repository is private, and a supported, effective human approval gate has not been demonstrated. Keep existing visibility, plan, payment method, $0 additional budget and settings unchanged. This document does not authorize changing any of them.

`scripts/signing/policy.json` therefore commits `approval.enabled: false`, an unset Environment ID and unverified private approval entitlement. The preparation job fails before API/download work and cannot produce `ready=true`; the only job referencing `environment: release` cannot be scheduled. Inputs and repository variables cannot override this switch. **Do not start a Secrets-using job while this remains unresolved.** The normal GitHub workflow-run button, a boolean input, commit/PR approval, or a chat confirmation is not a replacement for Environment approval.

The intended eventual experience is: AI prepares and starts the separately authorized build/workflow, checks the non-secret results, and presents the exact candidate; the owner approves the waiting Environment job **inside GitHub**, after which signing and verification proceed automatically. The owner should not have to start the workflow as a substitute for that approval. This trial stops at private, verified artifacts; distribution remains a separate authorization and implementation scope.

## Trusted candidate and expiry

The reviewed record permits exactly this existing candidate, without arbitrary run IDs, artifact paths or URLs as workflow inputs:

| Field                       | Pinned value                                                        |
| --------------------------- | ------------------------------------------------------------------- |
| Repository / build workflow | `shimi-lynx/mogledge` / `.github/workflows/binary-distribution.yml` |
| Source / version            | `ccdcccab85c6c2ad18b063989c049c0a013229eb` / `0.8.1`                |
| Successful manual run       | `38495813692`                                                       |
| Artifact ID                 | `11865015479`                                                       |
| Platform                    | `macos-x64`, `x86_64-apple-darwin`                                  |
| Artifact SHA-256            | `62749076bf3bb7c2a51d0751bcea3589aba9da8d480c7af72197bfcc61843462`  |
| Expiry                      | **2026-10-17 01:57:50 UTC**                                         |

Metadata was read back from GitHub. The owner reported the ordinary Intel Mac download starts and works; that is separate from cryptographic updater verification. Downloading the artifact bytes in the preparation environment encountered a proxy `CONNECT 403 Forbidden`. No alternative route was used. Its real inner files/hashes, signing key match, signature, installed update and restart remain unverified here. Fixture success cannot establish those results.

An expired or changed artifact stops the workflow. Do not silently replace it, rebuild with Secrets, or fall back to an unpinned candidate. A fresh authorized build requires a newly reviewed source/run/artifact/digest/version record. The SHA of the signing tooling is separate from the binary's source SHA: the single workflow input must equal the actual reviewed main workflow and checkout commit.

## Prepared job boundaries

1. **prepare**, no Environment or production Secrets: verifies exact main/tooling SHA, committed activation policy, repository identity and effective Environment metadata using `actions: read`. It requires the pinned Environment ID, one expected human reviewer, observable disabled administrator bypass and a branch-only `main` deployment policy. A private repository also requires previously reviewed evidence of feature entitlement. Missing fields, denied API access or unsupported protection stop processing; no broader token is added. It then requires a successful same-repository/manual/main source run and the exact non-expired artifact metadata. It checks the raw ZIP digest and validates the four flat entries, manifest identity/version/configuration, and both archive hashes. It never extracts either application archive.
2. **sign**, the only `environment: release` job: GitHub must pause it for the human's Environment approval. After approval it rechecks protection, downloads the current-run input by artifact ID and revalidates original bytes. Only trusted signing tooling is sparsely checked out. The official Tauri CLI 2.12.1 Linux packages are downloaded from fixed npm URLs and checked against the SHA-512 integrity values already in the application lockfile; npm/install scripts and application builds do not run. Only the signing step receives the two secret environment variables. It passes `--app-version 0.8.1`, discards tool output, disables core dumps, uses no secret arguments/files and uploads only an explicitly **unverified** signature. No application/artifact script is executed.
3. **verify**, a separate runner with no Environment or production Secrets: builds a small locked public-key verifier using official `minisign-verify 0.3.0` and `base64 0.22.1`, rechecks the original candidate, verifies both minisign signatures against the enrolled public key, then checks exactly one matching trusted `version:` token. Changed bytes, a wrong key, bad signature or missing/mismatched version cannot produce a successful verification receipt. Only after success does it upload the unchanged archive, `.sig`, checksums and `verification.json`, marked unpublished and Native-untested.

All official Actions are pinned to full commit SHAs. Workflow token permissions are read-only; no release write token, external credential, lifecycle install, cache, artifact-provided command or application checkout is used. Input/intermediate/output artifacts expire after one day and stay private to repository access. Failed final verification leaves any intermediate artifact explicitly unverified. A public-key signature is not secret; it is still not a distribution approval.

The supplied updater key ID is `834723B673FE6C1E`; the SHA-256 fingerprint of its 32 public bytes is `65b10a703ca58b486328274e88c5999fee34e16c15356d64aa3b19e54dd49a55`. This is the key already in the optional distribution overlay. Updater signatures authenticate update bytes and version; they do not provide macOS Developer ID/notarization or Windows Authenticode. This Mac archive remains ad-hoc OS-signed. The prepared trial does not establish Windows NSIS/MSI updater artifacts or a public feed.

## Activation requires a separately reviewed decision

No activation, workflow start, signing or setting change is authorized by this preparation PR. Before a future activation:

1. Resolve a supported human approval mechanism without silently changing private/public status, plan, payment or budget. Read back actual protection configuration and feature entitlement. Do not infer support from the ability to create an Environment or Secret names.
2. Prove a harmless, key-free job actually waits for the intended owner's native GitHub approval; verify bypass behavior and the exact `main` branch restriction. If the AI uses the owner's GitHub identity, discuss `prevent_self_review`: enabling it would prevent that same owner from approving. Do not disguise the shared identity as independent approval. No setting change or probe start is included here.
3. Record the real Environment ID and reviewed entitlement evidence, and enable the committed switch only in a separately reviewed change. The current [REST environment documentation](https://docs.github.com/en/rest/deployments/environments#get-an-environment) does not show `can_admins_bypass` in its example; actual read-only API observability is unverified. If it omits this field or the branch/tag distinction, or cannot observe protection, keep signing disabled and review a supported observation method separately. No wider token or assumed default is a fallback. A read-only API snapshot is an additional check, not an atomic guarantee against administrators changing settings; protection must remain in force through approval and signing.
4. Review the current candidate before its expiry, or approve a new pinned build record. Confirm Actions allowance/policy and the existing $0 additional budget stop rule. The AI may start the prepared workflow only after separate execution authorization, using the final reviewed main tooling SHA. The owner then approves the native waiting job in GitHub.
5. Inspect signature verification receipts and original archive hashes. Treat any suppressed signing error as failure; investigate configuration without printing keys/passwords or retrying automatically. Never download/store production keys for debugging. Private artifact retention does not publish a usable update service.

Actual anonymous HTTPS hosting, production feed, final source/version, Windows packaging, license/materials, isolated update rejection and save/restart Native checks remain in [issue #1](https://github.com/shimi-lynx/mogledge/issues/1); candidate/build execution is tracked in [issue #5](https://github.com/shimi-lynx/mogledge/issues/5). Existing ordinary NSIS installation and Mac launch evidence do not replace an actual signed in-app update.

## Targeted checks

Run without any production Secrets:

```sh
python3 -m unittest discover -s scripts/signing -p 'test_*.py'
cargo test --locked --manifest-path scripts/signing/verifier/Cargo.toml
cargo fmt --manifest-path scripts/signing/verifier/Cargo.toml -- --check
cargo clippy --locked --manifest-path scripts/signing/verifier/Cargo.toml -- -D warnings
```

Fixtures cover the disabled switch, unsupported/missing/broadened gate, exact source/run/SHA/digest/version, archive tampering/path/duplicate/symlink limits, token redirect isolation, suppressed signer failure and rejection without a success receipt. Public upstream verification vectors establish cryptographic acceptance and tamper rejection without a private key; version parser tests are separate. No test generates a key or signs an artifact. Production signing, a positive production version-bound signature, actual Actions scheduling/gating, real artifact contents and Native update execution remain unrun.
