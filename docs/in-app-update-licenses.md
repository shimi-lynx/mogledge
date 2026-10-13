# Updater dependency and legal-material delta

This is the existing collector's source/target diagnosis for updater implementation `19a05b6b832241565f833e5d72a18325c2bd08df`, based on main `8ac67ef0b4d705635734d046f2f3f819b000e284` (0.7.5). Compare the same locked source with `custom-protocol` and with `custom-protocol,distribution-updater`. No native build, SDK access, Actions, signing key or publication is involved in this diagnosis.

The [machine-readable delta](../scripts/distribution/updater-license-delta.json) records the Cargo.lock hash, all 36 newly locked package/version/checksum identities, target-specific additions, collector-selected branches and retained legal-file hashes. Existing lock versions are not replaced or removed. A lockfile includes inactive target/feature/development entries; its 36 additions are not the same as each target's runtime/build graph. The updater adds 18 graph packages on Windows and 27 on either Mac target, with a union of 28. Some graph additions, such as `tempfile`, were already locked for other roles. All added graph roles are classified as runtime by the existing collector; that classification does not establish final linked/native contents.

## Collector results

| Target              | Default collected / blocked Cargo packages | Updater collected / blocked Cargo packages | Additional graph packages | New blocked packages  |
| ------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------- | --------------------- |
| Windows x64         | 314 / 0                                    | 332 / 0                                    | 18                        | None                  |
| macOS Apple Silicon | 301 / 14                                   | 327 / 15                                   | 27                        | `objc2-osa-kit@0.3.2` |
| macOS Intel         | 301 / 14                                   | 327 / 15                                   | 27                        | `objc2-osa-kit@0.3.2` |

Each target retains the same four npm runtime packages, all collected. The collector's parser, package traversal, mandatory review blocks and workflows are unchanged. Diagnostic output is partial material and cannot be used as candidate staging. Windows exit 0 establishes collection only; Mac exit 1 remains required. Neither result approves a binary or replaces final artifact checks.

## Material additions and notices

`filetime@0.2.29` declares the legacy Cargo expression `MIT/Apache-2.0`. Following [Cargo's documented legacy slash semantics](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields), its exact pinned package/declaration/checksum is normalized to `MIT OR Apache-2.0` through the existing per-package material mechanism. Both crate-root originals are retained unchanged: [LICENSE-MIT](../scripts/distribution/materials/filetime@0.2.29/crate/LICENSE-MIT) and [LICENSE-APACHE](../scripts/distribution/materials/filetime@0.2.29/crate/LICENSE-APACHE). Archive checksum, crate VCS revision/path and byte hashes are in [materials/index.json](../scripts/distribution/materials/index.json). The collector selects MIT and keeps both documents. Unreviewed slash expressions still fail.

`objc2-osa-kit@0.3.2` contains generated OSAKit bindings, declares `Zlib OR Apache-2.0 OR MIT`, and omits a full license document from its crate archive. Its README points to the [exact upstream root license statement](https://raw.githubusercontent.com/madsmtm/objc2/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md), which identifies alternative licenses and explicitly raises Apple SDK-derived-code implications. That document is retained byte-for-byte. [Pinned SPDX Apache terms](https://raw.githubusercontent.com/spdx/license-list-data/31ba1a50e5397e00a304dbadc76531740e89ee48/text/Apache-2.0.txt) are retained as **reference only**, corresponding to the statement's Apache alternative; they do not establish complete applicable package notices or clearance. The manifest adds an explicit `reviewRequired` record for complete applicable terms/notices, generating SDK/version/terms and redistribution coverage. The package remains blocked. This is one new updater-only member of the existing Mac SDK/notice condition described in the [legal-material guide](license-materials.md), in addition to the previous fourteen; it is not a new runtime QA requirement.

Other added dependencies have full legal texts in their exact crate archives and need no supplemental material to satisfy the current collector. In particular, `ring` requires **both** Apache-2.0 and ISC: retain `LICENSE`, `LICENSE-BoringSSL` and `LICENSE-other-bits`, including their copyright notices. The updater's `LICENSE.spdx` is retained but is not used as a replacement for its full `LICENSE_APACHE-2.0`/`LICENSE_MIT` texts. No fabricated NOTICE is added. Any actual upstream legal/NOTICE files found by the collector remain included, and the material ledger records their hashes. Generic reference terms never replace missing package-specific notices.

An enrolled distribution must collect with `custom-protocol,distribution-updater` for the actual selected target and retain that successful inventory/legal tree with the delivered installer/application. Current app-only workflows intentionally use the default feature set; they are unchanged and must not be reused to claim updater notice completeness. Separate review of compiler/sysroot/SDK/native/generated/static components and actual artifact/archive contents still applies as described in [existing license-material conditions](license-materials.md). Source metadata and collection success alone do not establish those conditions.

## Reproduction and verification

For each supported target, compare these metadata/diagnosis runs using the pinned Rust toolchain and locked npm dependencies:

```sh
cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml --filter-platform <TARGET> --features custom-protocol > <default-metadata.json>
cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml --filter-platform <TARGET> --features custom-protocol,distribution-updater > <updater-metadata.json>
node scripts/distribution/diagnose.mjs <default-metadata.json> <new-default-diagnosis-directory>
node scripts/distribution/diagnose.mjs <updater-metadata.json> <new-updater-diagnosis-directory>
node --test scripts/distribution/distribution.test.mjs
```

Targets are `x86_64-pc-windows-msvc`, `aarch64-apple-darwin` and `x86_64-apple-darwin`. Output directories must be new; preserve previous evidence. Metadata filtering on Linux fetches source crates and does not access a Mac or install/accept an Apple SDK. All six metadata runs succeeded. After the two material entries were added, repeated updater diagnoses produced the table above. Distribution regression tests passed 21 with one Windows-only native probe skipped. The new archive/legal/VCS hashes and reference-only blocking were independently reviewed. No actual binary/archive NOTICE closure is verified here.

## Minimum owner inputs and approval for activation

1. **Distribution scope and hosting:** choose the initial platforms and release channel, and provide the real HTTPS manifest/artifact locations. The app needs accessible URLs; an anonymous client cannot use private GitHub Release assets. Choosing a public repository, paid hosting or changing account access needs separate approval.
2. **Public update key:** provide only the production public key. The owner must choose private-key custody/backup and, if needed, separately approve generation in their own secure build environment. Never send the private key/password to chat or commit it. The overlay can be prepared once the actual public key and URLs are known.
3. **Concrete rollout authorization:** approve the reviewed signed distribution build and isolated update/restart/data-preservation test for the chosen platform. Windows needs an initial enrolled NSIS installation before in-app updates; the current standalone EXE is not enrolled. Publishing the manifest/artifacts to the chosen destination, running Actions, changing Secrets/permissions and replacing an installed production app remain distinct approvals. For Mac distribution, resolve the existing SDK/notice condition plus `objc2-osa-kit` before publication.

Release coordination must handle merge and the next version separately. A Windows-only initial rollout need not wait for Mac-specific material clearance, but still requires its own actual artifacts and Native checks. This preparation requests no permission change or immediate production operation.
