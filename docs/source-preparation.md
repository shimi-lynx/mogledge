# Source preparation for 0.8.0

This repository is prepared from the reviewed main snapshot `dc3f040ae1a95157254d62c3d3f9fd8df8a4dd78`, product 0.8.0. It starts with one new root commit; original Git history and unmerged work are excluded. This preparation does not publish a repository, release or executable.

## Included and excluded material

The snapshot includes application source, build/configuration files, lockfiles, regression tests, synthetic fixtures, HTML authoring assets, current guides and required third-party license/provenance material. Technical package/executable names, identifier, storage configuration and disabled updater defaults are preserved.

Only tracked source-snapshot files were considered. Local knowledge files, app profiles/databases, dependencies, build outputs, raw logs, credentials, machine instructions and the original Git directory are excluded. Two historical UI-validation pages and their four screenshots are omitted. Storage-identity, Mac permission and Cloud-probe guides retain current contracts without private investigation histories. Unnecessary private tracker references are removed; upstream attribution and public source references remain.

## Audit and validation

The pre-copy inventory covered 774 tracked files. Checks covered file types, personal names from existing commit identities, owner emails, personal path prefixes, secret/key patterns, repository/chat references, binary metadata and synthetic fixtures. Generic example paths and reserved-domain test addresses are intentional. Third-party names, notices and upstream contact information remain where required or supplied by dependencies.

All 135 retained legal-material files and vendored Wry bytes are unchanged. Runtime implementation, dependency versions, application identity, product versions and storage assets match the baseline; source comments and review-note metadata only remove private tracker references. Public documentation is adapted for this repository. No product behavior change requires a version increment.

Repository Actions are disabled before the first push. Both retained workflows have only manual dispatch triggers. No Actions run, Release, signing key/Secret registration, app build/installation or profile operation is part of this preparation. Commit identity uses the owner's public GitHub login and GitHub noreply address.

Preparation checks on Windows with Node 22.18.0 and Rust 1.99.0:

| Check                                                                                               | Result and scope                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot inventory, identity/secret/reference scan and binary metadata                              | 769 selected files; no owner personal information, secret patterns or private repository/chat links found within the checked scope |
| Source and legal-material comparison                                                                | Runtime unchanged apart from source comments; all 135 legal hashes and all vendored Wry bytes preserved                            |
| Local Markdown links                                                                                | 207 checked, including seven kit links resolved against their installation layout                                                  |
| `npm run check`                                                                                     | Passed: 376 formatted files and 219 lint/type files                                                                                |
| `node --test scripts/distribution/distribution.test.mjs tests/storage/updater-permissions.test.mjs` | 19 passed, four skipped: three Windows symlink cases and the opt-in Native Rust probe                                              |
| Rust manifest format checks                                                                         | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and the backend-manifest equivalent passed                                |

Existing integration evidence in [0.8.0 source integration](release-0.8.0.md) is inherited and retains its stated limits. Application builds, Native QA, installers and full Rust test/Clippy runs were not repeated for documentation, review metadata and comment changes; no new Native QA is claimed.

## Remaining work before publication or distribution

- Independently authorize repository publication and select the intended source/binary distribution scope.
- Complete actual bundled dependency/NOTICE/SDK review, including unresolved Mac material conditions in the [legal-material guide](license-materials.md).
- Select and review the production updater public key/feed and signing custody without placing private material in source.
- Separately authorize builds, Actions, Releases and any key/Secret registration.
- Validate actual platform artifacts, signatures, installed update/relaunch and data preservation. Mac updater compilation and broader Native cases remain unverified.
