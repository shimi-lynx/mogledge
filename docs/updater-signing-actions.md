# Updater signing trial: human approval required

This enables one authorized artifact-only signing and verification trial for the pinned Intel Mac **0.8.1** candidate. Current main's product version is **0.8.2**; its reviewed signing-tooling SHA is separate from the candidate's build source. This trial does not rebuild or execute the application, create a Release/tag or update feed, or install/update an app.

## Effective approval contract

The repository is public. Environment `release` was read back with ID `24269235524`, exactly one required reviewer (owner user ID `56603283`), administrator bypass disabled, and exactly branch `main` allowed through its custom deployment policy. `prevent_self_review` stays false because the owner's connected identity dispatches the workflow and the same owner must approve it personally. AI must never approve on that person's behalf. This setting does not replace the required human approval.

The committed policy enables this exact trial and pins the Environment ID. A committed `approval.enabled: false` remains a kill switch that workflow inputs and repository variables cannot override. Preparation validates effective protection before downloading and producing `ready=true`; the dedicated signing job rechecks it after GitHub approval. Missing or changed protection stops processing. Read-only snapshots cannot provide an atomic guarantee against later administrator changes, so protection must remain in force throughout the trial.

The names `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` were registered by the owner in Environment `release`. Their values are not retrieved, checked, logged or stored locally. GitHub supplies them only to the dedicated signing step after the owner approves the actual waiting Environment job inside GitHub. Workflow dispatch, a chat confirmation or PR approval is not that approval.

Input, unverified signature and verified output are **public-repository Actions artifacts** accessible to signed-in repository readers; one-day retention is not privacy. Candidate bytes and public-key signatures are intentionally scoped trial outputs. An intermediate signature is explicitly unverified and cannot establish success. No key/password or personal data may enter artifacts or logs. Actions artifact access is separate from Release/tag/feed publication, which remains outside this trial. See [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) and [Environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

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

On 2026-10-14, the existing authenticated Windows CLI retrieved the real 52,194,605-byte artifact. The raw SHA-256 matches the pinned record; all four flat entries, manifest identity/version/source/configuration and both inner archive checksums passed the production validator without extracting or executing either application archive. The updater archive SHA-256 is `35ffafd38adf9572b055a05d01ac2c32efef77a06decb0ff71b14ab06d0122a3`. An earlier preparation environment encountered proxy `CONNECT 403 Forbidden`; that was not used as evidence of byte validation. The owner reported the ordinary Intel Mac download starts and works, separately from cryptographic updater verification. Signing key match, production signature and signed in-app update/restart remain unverified.

An expired or changed artifact stops the workflow. Do not silently replace it, rebuild with Secrets, or fall back to an unpinned candidate. A fresh authorized build requires a newly reviewed source/run/artifact/digest/version record. The SHA of the signing tooling is separate from the binary's source SHA: the single workflow input must equal the actual reviewed main workflow and checkout commit.

## Prepared job boundaries

1. **prepare**, no Environment or production Secrets: verifies exact main/tooling SHA, committed activation policy, repository identity and effective Environment metadata using `actions: read`. It requires the pinned Environment ID, one expected human reviewer, observable disabled administrator bypass and a branch-only `main` deployment policy. A private repository also requires previously reviewed evidence of feature entitlement. Missing fields, denied API access or unsupported protection stop processing; no broader token is added. It then requires a successful same-repository/manual/main source run and the exact non-expired artifact metadata. It checks the raw ZIP digest and validates the four flat entries, manifest identity/version/configuration, and both archive hashes. It never extracts either application archive.
2. **sign**, the only `environment: release` job: GitHub must pause it for the human's Environment approval. After approval it rechecks protection, downloads the current-run input by artifact ID and revalidates original bytes. Only trusted signing tooling is sparsely checked out. The official Tauri CLI 2.12.1 Linux packages are downloaded from fixed npm URLs and checked against the SHA-512 integrity values already in the application lockfile; npm/install scripts and application builds do not run. Only the signing step receives the two secret environment variables. It passes `--app-version 0.8.1`, discards tool output, disables core dumps, uses no secret arguments/files and uploads only an explicitly **unverified** signature. No application/artifact script is executed.
3. **verify**, a separate runner with no Environment or production Secrets: builds a small locked public-key verifier using official `minisign-verify 0.3.0` and `base64 0.22.1`, rechecks the original candidate, verifies both minisign signatures against the enrolled public key, then checks exactly one matching trusted `version:` token. Changed bytes, a wrong key, bad signature or missing/mismatched version cannot produce a successful verification receipt. Only after success does it upload the unchanged archive, `.sig`, checksums and `verification.json`, marked unpublished and Native-untested.

All official Actions are pinned to full commit SHAs. Workflow token permissions are read-only; no release write token, external credential, lifecycle install, cache, artifact-provided command or application checkout is used. Input/intermediate/output artifacts expire after one day and use the public repository's artifact access. Failed final verification leaves any intermediate artifact explicitly unverified. A public-key signature is not secret; it is still not a distribution approval.

The supplied updater key ID is `834723B673FE6C1E`; the SHA-256 fingerprint of its 32 public bytes is `65b10a703ca58b486328274e88c5999fee34e16c15356d64aa3b19e54dd49a55`. This is the key already in the optional distribution overlay. Updater signatures authenticate update bytes and version; they do not provide macOS Developer ID/notarization or Windows Authenticode. This Mac archive remains ad-hoc OS-signed. The prepared trial does not establish Windows NSIS/MSI updater artifacts or a public feed.

## Authorized execution and stop conditions

1. Review and merge the minimal activation PR through the protected main branch. Read back the final tooling SHA, main ruleset and effective Environment protection. Do not use a direct main push or bypass. No product version bump is needed for this tooling/documentation-only activation.
2. Dispatch the manual workflow **once** with that exact reviewed main SHA, using standard Ubuntu runners under the existing $0 additional-budget rule. No payment, budget or authentication changes are authorized. If the candidate expired or preparation fails, stop; do not rebuild, substitute a candidate or automatically retry.
3. Confirm preparation succeeds and the signing job actually waits for the owner's native Environment approval. Present the exact run URL and candidate to the owner, including public Actions artifact visibility. AI must not approve the deployment, even when using the owner's connected identity. The first trial itself provides the real waiting-state evidence; metadata alone does not establish this result.
4. Only after the owner approves inside GitHub may signing and independent public-key verification run. Read back their actual results and unchanged archive hash. A suppressed signing error or verification failure stops the trial; do not re-sign or retry automatically. Never retrieve/store production Secrets for debugging.
5. Stop at verified Actions artifacts and their receipt. Release/tag/feed creation, public update-service activation and application installation remain outside this authorization. Signed in-app update/restart QA remains follow-up after publication; ordinary NSIS installation and Mac launch do not establish it.

Actual anonymous HTTPS hosting, production feed, final source/version, Windows packaging, license/materials, isolated update rejection and save/restart Native checks remain in [issue #1](https://github.com/shimi-lynx/mogledge/issues/1); candidate/build execution is tracked in [issue #5](https://github.com/shimi-lynx/mogledge/issues/5). Existing ordinary NSIS installation and Mac launch evidence do not replace an actual signed in-app update.

## Targeted checks

The first authorized run, [38566864433](https://github.com/shimi-lynx/mogledge/actions/runs/38566864433), stopped in preparation before producing an input artifact. Signing and verification were skipped, and no Environment approval was pending. On 2026-10-14, read-only reproduction with API version `2022-11-28` confirmed the repository endpoint returns HTTP 200 without a trailing slash and HTTP 404 with it; Environment and branch-policy endpoints return HTTP 200. The repository metadata URL is corrected without changing token permissions, approval protection or candidate pins. Regression tests cover the canonical repository URL, unchanged subresource URLs and the required read-only token. A recovery dispatch remains subject to the same native human approval.

Run without any production Secrets:

```sh
python3 -m unittest discover -s scripts/signing -p 'test_*.py'
cargo test --locked --manifest-path scripts/signing/verifier/Cargo.toml
cargo fmt --manifest-path scripts/signing/verifier/Cargo.toml -- --check
cargo clippy --locked --manifest-path scripts/signing/verifier/Cargo.toml -- -D warnings
```

Fixtures cover the disabled switch, unsupported/missing/broadened gate, exact source/run/SHA/digest/version, archive tampering/path/duplicate/symlink limits, token redirect isolation, suppressed signer failure and rejection without a success receipt. Public upstream verification vectors establish cryptographic acceptance and tamper rejection without a private key; version parser tests are separate. No test generates a key or signs an artifact. Real artifact contents and effective protection metadata passed on 2026-10-14. Production signing, a positive production version-bound signature, actual Actions waiting-state evidence and Native signed update execution remain unrun until their respective steps complete.
