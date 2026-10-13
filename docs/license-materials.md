# Dependency legal material for 0.7.2

The reviewed source `4b88a33ec267dd3dc4be48d3ac77660a624f22c9` is product 0.7.2. Its dependency declarations, all non-product Cargo.lock entries and all non-root npm lock entries are identical to the previously diagnosed 0.7.1 source `6008ad54970303d59a26842892067d5fa45758fc`. The new default `macos-persistent-storage` feature is empty and adds no dependency edge; the storage CLI adds a product binary target. Consequently, the existing target-graph/package evidence remains applicable to dependency identities. This review checks additional legal material, not storage behavior, a native build or final binary closure. Workflow gates and dependency versions remain unchanged.

## Result and unresolved conditions

| Target      | Cargo packages | Complete collection | Incomplete package license text | Declaration parser review | Blocked packages |
| ----------- | -------------: | ------------------: | ------------------------------: | ------------------------: | ---------------: |
| Windows x64 |            314 |                 314 |                               0 |                         0 |                0 |
| Mac ARM     |            315 |                 301 |                               0 |                         0 |               14 |
| Mac Intel   |            315 |                 301 |                               0 |                         0 |               14 |

Production npm collection passes 4/4 on each graph. The original diagnosis had Windows 32 blocked packages and each Mac 47. Previously declaration-rejected packages were also inspected for full legal text. Full terms are now collected for all fourteen remaining Mac records, but all retain mandatory review conditions: four need applicable copyright-notice/source coverage and all fourteen retain the upstream SDK/provenance question. The collection counts reuse the existing target-graph diagnoses with the demonstrated dependency equivalence above; the resumed review checked all fourteen retained term sets and all document hashes without repeating a native build or all-package download. The normal collector still rejects these records before producing a distribution index.

**Keep `license_reviewed` false for any selection whose conditions remain unresolved.** Mac's 14 objc2-family packages remain blocked by package provenance/SDK review. The four MIT-only packages now retain a complete actual upstream MIT document from a later revision, including its existing notice; this does not establish that this notice covers every contributor/file in those earlier versions. For the other ten, each pinned package `LICENSE.md` expressly offers Apache-2.0, whose official terms are retained unchanged. Generic MIT and historical notice references remain `referenceOnly`, excluded from completeness checks; no attribution is invented. Each blocked package keeps its independent condition in `reviewRequired`. A Windows-only selection excludes these Mac packages and requires its own remaining review.

Windows package text collection passing does not settle icon/asset rights, the complete embedded native/SDK closure, archive content or final distribution review. Actual runner SDK/toolchain inputs, compiler runtime components and the final executable must still be checked. No Actions, application build, artifact upload, merge into main, signing-key/certificate setup, repository publication or release occurred during this collection.

## Mac blockers: text and provenance are separate

All fourteen identities below occur on both Mac graphs and remain blocked. `Generated` means the exact crate contains `src/generated` with a header-translator origin marker. `No generated directory` describes the inspected archive; it does not establish absence of SDK-derived material. The MIT-only group and the group without a generated directory are different.

| Package/version                | Upstream alternatives     | Full-text result                    | SDK-origin evidence                                    |
| ------------------------------ | ------------------------- | ----------------------------------- | ------------------------------------------------------ |
| block2@0.6.2                   | MIT                       | MIT terms retained; notices pending | No generated directory                                 |
| dispatch2@0.3.1                | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2@0.6.4                    | MIT                       | MIT terms retained; notices pending | No generated directory                                 |
| objc2-encode@4.1.0             | MIT                       | MIT terms retained; notices pending | No generated directory                                 |
| objc2-exception-helper@0.1.1   | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | No generated directory; handwritten Objective-C helper |
| objc2-app-kit@0.3.2            | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-core-foundation@0.3.2    | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-core-graphics@0.3.2      | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-foundation@0.3.2         | MIT                       | MIT terms retained; notices pending | Generated                                              |
| objc2-io-surface@0.3.2         | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-quartz-core@0.3.2        | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-security@0.3.2           | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-service-management@0.3.2 | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |
| objc2-web-kit@0.3.2            | Zlib OR Apache-2.0 OR MIT | Apache-2.0 retained                 | Generated                                              |

The retained upstream revisions are `b4167b582b2f75f9a1be75495c41b765344fd03c` (block2), `8852b424193ca41602281b3d7540d7c8ed51e49a` (dispatch2/objc2), `8d214f5477365ffcbcbb7de058c86ed9a518efb7` (encode/helper), and `7b1abfd750a2cacaea71d6a56ecfb83cb7de560b` (frameworks). The manifest supplies each exact source path, checksum and pinned `LICENSE.md`. Apache terms are retained from the [Apache Software Foundation's own website repository](https://github.com/apache/www-site/blob/01b1be9fbc5cd93b6794f5653a58b9b863807f84/content/licenses/LICENSE-2.0.txt), the unchanged text linked by its [official license page](https://www.apache.org/licenses/LICENSE-2.0). Together with each pinned project's express alternative grant, this supplies the terms for ten packages. It does not grant rights to separately owned SDK material, fill missing attribution, or bypass `reviewRequired`.

Upstream's [2025 licensing clarification](https://github.com/madsmtm/objc2/commit/cfb199226661ec6e4939fcd7cd7531b3c5453076) replaced a full MIT file carrying an original author's notice with the licensing explanation. The [historical MIT file](https://github.com/madsmtm/objc2/blob/757cd841d0293341dbefd9b99d7548dec244ffde/LICENSE.txt) is retained unchanged as reference evidence for inherited code and notices. A later [official commit adding full license files](https://github.com/madsmtm/objc2/commit/ee9a7ada2131f5944b8750428e265c15632f2a19) supplies the now-collected `LICENSE-MIT.txt`. Each locked package revision precedes this commit; its current notice is preserved as written, without claiming retroactive notice coverage. In an existing upstream discussion, the maintainer [confirms earlier versions' declared licenses](https://github.com/madsmtm/objc2/issues/826#issuecomment-6103078978) but [cannot confirm copyright-notice sufficiency and points to other contributors](https://github.com/madsmtm/objc2/issues/826#issuecomment-6107377999). No new contact was made. Therefore missing document retrieval is complete; applicable notice/source coverage is a distinct unresolved review condition.

The remaining decisions have specific owners:

| Condition                                     | Evidence/task still needed                                                                                                                                                                                          | Decision owner                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four MIT-only packages' notices               | Map retained historical/current notices and additional inherited notices to actual shipped files; do not assume the new single-author notice is exhaustive                                                          | Integration/source reviewer gathers evidence; copyright holders clarify factual coverage if needed; qualified legal reviewer resolves disputed sufficiency |
| SDK-derived material in the fourteen packages | Identify the precise generating SDK/component terms and whether the shipped declarations/code require separate Apple permissions or notices; generated-directory evidence proves only ten packages' generation path | Source reviewer identifies provenance; qualified legal reviewer or Apple resolves applicable contractual/copyright questions                               |
| New Xcode/SDK acceptance, if required         | Establish existing accepted agreement/version and authorized account/entity; do not install/use a new SDK to bypass acceptance                                                                                      | Account/entity owner with authority decides acceptance; this review does not accept it                                                                     |
| Windows-specific conditions below             | Actual target runtime/SDK material, assets and binary/archive evidence                                                                                                                                              | Windows integration reviewer and asset/account rights owner                                                                                                |

## Material PR and binary distribution are separate decisions

The material/collector change can be merged while these distribution conditions remain unresolved: it preserves source and legal bytes, records the outstanding conditions and continues to reject blocked packages. No unresolved distribution permission is represented as a successful package review, and neither workflow gate is enabled. Main's 0.7.2 feature/version changes have been reconciled without altering their product behavior. Product version remains 0.7.2; no additional bump is needed for this follow-up. Integration owns the final merge decision, including any separate PR checks. Merging this preparation neither approves a binary nor completes the outstanding distribution review. Public binary distribution remains unapproved for both Windows and Mac until their respective conditions and actual artifact checks are complete.

The public [Xcode and Apple SDKs Agreement](https://www.apple.com/legal/sla/docs/xcode.pdf), footer EA2002 dated 06/08/2026, permits macOS application distribution under its conditions (2.4), requires notices on permitted copies (2.5), and restricts SDK redistribution/derivatives subject to law and separate open-source/sample terms (2.7). This current document does not establish the agreement governing historical bindings. The generator discovers a locally installed SDK; crate markers and upstream CI's Xcode choice do not prove the precise generating SDK/version or terms. Establish those inputs and any applicable component license first. Whether particular translated declarations/code fall within protected SDK material and those conditions requires qualified interpretation or authoritative clarification. Account authority and acceptance of any new agreement belong to the owner (2.1); stop if new acceptance is needed. No Xcode/SDK was downloaded or installed, and no agreement was accepted during this review.

## Platform selection and remaining Windows evidence

The existing workflow creates only the selected platform matrix, and `build.mjs` filters the locked Cargo graph to that target before collection. Windows therefore encounters none of the fourteen Mac-only packages. Preserve both default-false gates and the collector's fail-closed review. Review the actual source and selected target independently; `all` requires three completed target reviews plus shared asset approval. There is no need to wait for Mac-specific clearance when evaluating Windows-specific conditions. These records do not authorize any workflow run or make a candidate ready.

| Windows condition                      | Mechanical evidence available                                                                                                           | Remaining condition                                                                                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Locked package documents               | 314/314 Cargo and 4/4 npm; exact identity and retained bytes checked                                                                    | Full text and graph roles do not prove final linked/generated contents                                                                                                                                                                                                               |
| WebView2 loader                        | SDK 1.0.3800.47 LICENSE/NOTICE and all nine crate/SDK byte matches                                                                      | Record actual link inputs and retain those notices in the final ZIP; no runtime installer is included by this workflow                                                                                                                                                               |
| Bundled SQLite                         | libsqlite3-sys@0.38.2 selects bundled SQLite 3.53.2; exact amalgamation/header carry the public-domain disclaimer                       | Preserve and inventory nested native provenance; the wrapper's MIT file alone is not that evidence; [SQLite's official statement](https://www.sqlite.org/copyright.html) does not require buying its optional warranty                                                               |
| Rust standard library/compiler support | Rust 1.99.0 revision `b940084d7eb6a299eb4bfeb8e34901bc051e7ac4`; installed toolchain has `COPYRIGHT-library.html` and component notices | Cargo package inventory omits sysroot components; collect and include notices from the actual Windows target component, not Linux's component as proof                                                                                                                               |
| Windows SDK/MSVC/CRT                   | Record actual installed SDK/Build Tools versions, licenses/redist lists, link inputs and PE imports                                     | The [Microsoft redistribution guidance](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170) makes eligibility/terms dependent on the installation; do not assume GitHub runner installation establishes the project's redistribution rights |
| Icons/assets                           | Inventory master and derived icon files, hashes and packaged resources                                                                  | Hashes cannot establish creator authority, copyright or trademark rights; obtain source/rights evidence                                                                                                                                                                              |
| Final native/archive contents          | Compare actual link inputs, imports, resources and archive entries to reviewed inputs; hash all retained legal/source files             | PE imports cannot identify all statically embedded code; current identity/architecture/hash checks do not audit that complete closure                                                                                                                                                |

Separate source/target pre-build review from post-build verification of actual native and ZIP contents. The current workflow uploads after its existing checks; it has no complete SDK/sysroot/static-link audit. Before authorization, the integration reviewer must resolve known source/material conditions and specify how required final checks will prevent uploading a failed candidate. Any additional machine check should fail that target before upload, without ignoring obligations or substituting a single cross-platform approval. Final application/source revisions must be re-evaluated if another fix changes them. Native execution, save-data safety and publication readiness are separate acceptance conditions.

## Authoritative material and unchanged bytes

[The material manifest](../scripts/distribution/materials/index.json) records all 51 previously blocked package/version identities: exact official crate URLs, Cargo.lock archive SHA-256, declared license, repository, crate VCS revision/path, and the source URL and SHA-256 of each retained document. The 0.7.4 main baseline at `072f00b` holds 128 files: 71 original crate-root legal documents and 57 supplemental upstream/SDK/reference documents. All original documents are unchanged, including CRLF where present. `.gitattributes` prevents legal-byte line-ending conversion; upstream `LICENSE.md` files are excluded from formatting. The collector does not fetch supplemental documents during packaging; reviewed complements are committed with this source.

The retained provenance supplement adds three pinned Rust provenance documents for `objc2@0.6.4`: `RUST-LICENSE-MIT`, `RUST-COPYRIGHT-reference` and `RUST-REUSE-reference.toml`. After that supplement is integrated, the total is 131 (71 original and 60 supplemental files). The existing 128 descriptors/bytes and all 14 `reviewRequired` conditions remain unchanged; the additional material does not establish distribution clearance. This documentation change does not add the three files.

Cargo.lock checksums were independently compared to each downloaded official archive before extraction. Upstream complements were retrieved at `.cargo_vcs_info.json` revisions, never a floating branch. Packaging checks the reviewed source/declaration, lock checksum and VCS identity, every retained document hash and embedded SDK hashes. Wrong versions, hashes, identities, unsupported declarations, unsafe paths and symlinks remain errors. Generic reference templates are not legal grants.

### Windows embedded WebView2 material

The original webview2-com/sys/macros crates omit their MIT text. Their exact upstream commits provide the unchanged project MIT license. That license does not cover Microsoft's native loader. `webview2-com-sys@0.39.1` upstream generation code identifies Microsoft.Web.WebView2 1.0.3800.47; its official [NuGet package](https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.3800.47/microsoft.web.webview2.1.0.3800.47.nupkg) supplies separate `LICENSE.txt` and `NOTICE.txt`, both retained without modification.

All nine x64/x86/ARM64 loader files in the crate are byte-identical to the corresponding SDK files. The manifest records the NuGet archive and loader hashes; packaging checks those crate files again. The relevant x64 `WebView2LoaderStatic.lib` SHA-256 is `89c6b872783b8f6c3cedbff618adb42082d455c615453ae10cfc753f1e8f25d8`. The crate's build script selects the static loader for MSVC; no loader DLL distribution is added. SDK LICENSE requires its copyright, conditions and disclaimer to accompany binary redistribution and prohibits endorsement. The unchanged SDK NOTICE is included as well. Final binary closure and runner SDK provenance remain separate acceptance conditions.

### License expression handling

[Cargo's documented operators](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields) give OR alternatives, simultaneous AND requirements and WITH exceptions; its footnote documents deprecated slash-separated licenses. Only the exact reviewed Cargo package/version/declaration/checksum entries normalize slash to OR. npm slash declarations and unreviewed Cargo slash declarations still fail closed. For brotli-decompressor 6.0.1, the retained actual LICENSE is BSD-3-Clause, so that OR branch is selected; no absent MIT text is invented. ident_case 1.0.1 has complete MIT text and selects MIT.

The parser applies WITH, AND, then OR precedence and balanced grouping. AND requires every selected obligation; OR deterministically records the first branch with complete material in `selectedLicenses`. Unsupported identifiers still reject the whole declaration, even in an unselected alternative. Each selected license needs its sections in a complete document, not assembled from unrelated fragments. Existing documents, notices and copyright files are retained even when another OR branch is selected. Some Apache files (dirs, shlex, cargo_toml) were shortened notices or lacked the original collector's end marker; their full MIT alternative resolves collection without claiming those Apache notices are complete.

The only accepted WITH form is Apache-2.0 WITH LLVM-exception. It requires the complete Apache document and both substantive LLVM exception paragraphs; winx 0.36.4's unchanged LICENSE provides both. The exception's object-embedding permission does not erase the underlying terms or grant rights to unrelated SDK materials. No generic unknown exception is accepted.

### Source obligations and graph roles

selectors 0.38.0 has original MPL headers pointing to Mozilla's MPL 2.0 definition, but no full license document. The canonical MPL 2.0 text is retained from a pinned SPDX license-data revision. [MPL 2.0 sections 3.1–3.4](https://www.mozilla.org/en-US/MPL/2.0/) require covered source availability and preservation of notices. Packaging includes the unmodified exact crate sources in `third-party/cargo/selectors@0.38.0/source/` with the retained license beside them. The accompanying README tells recipients that the source is included, may be obtained directly from that directory and remains under MPL-2.0. All covered-file headers are preserved. MPL code remains under its own license alongside the larger work; the application MIT license does not replace it. Local patched wry source remains included, as before.

`scopes` records dependency-graph runtime/build roles, retaining host proc-macros and their dependencies as build scope, and both roles where shared. Build-only classification never skips legal collection and is not evidence that generated code or libraries are absent from the final executable. Exact final linked/generated/native closure is still unverified.

## Reviewed package/version outcomes

Targets: W = Windows x64, A = Mac ARM, I = Mac Intel. Roles describe the union of target-specific graph roles. The selected branches below are collector outcomes, not a declaration that all distribution conditions are satisfied.

| Package/version                   | Targets | Graph roles    | Selected branch or remaining text    | Status    |
| --------------------------------- | ------- | -------------- | ------------------------------------ | --------- |
| alloc-stdlib@0.3.0                | W, A, I | build, runtime | BSD-3-Clause                         | Collected |
| ambient-authority@0.0.2           | W, A, I | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| bitflags@1.3.2                    | W, A, I | build, runtime | MIT                                  | Collected |
| block2@0.6.2                      | A, I    | build, runtime | MIT terms; notice/SDK review pending | Blocked   |
| brotli-decompressor@6.0.1         | W, A, I | build, runtime | BSD-3-Clause                         | Collected |
| bs58@0.5.1                        | W, A, I | build, runtime | MIT                                  | Collected |
| cap-primitives@3.4.6              | W, A, I | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| cap-std@3.4.6                     | W, A, I | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| cargo_toml@1.0.1                  | W, A, I | build          | MIT                                  | Collected |
| defmt-parser@1.0.0                | W, A, I | build          | MIT                                  | Collected |
| dirs-sys@0.5.0                    | W, A, I | build, runtime | MIT                                  | Collected |
| dirs@6.0.0                        | A, I    | runtime        | MIT                                  | Collected |
| dirs@7.0.0                        | W, A, I | build, runtime | MIT                                  | Collected |
| dispatch2@0.3.1                   | A, I    | build, runtime | Apache-2.0 text; SDK review pending  | Blocked   |
| dunce@1.0.5                       | W, A, I | build, runtime | CC0-1.0                              | Collected |
| fallible-iterator@0.3.0           | W, A, I | runtime        | MIT                                  | Collected |
| fallible-streaming-iterator@0.1.9 | W, A, I | runtime        | MIT                                  | Collected |
| fnv@1.0.7                         | W, A, I | build, runtime | Apache-2.0                           | Collected |
| foreign-types-macros@0.2.4        | A, I    | build          | MIT                                  | Collected |
| foreign-types-shared@0.3.1        | A, I    | runtime        | MIT                                  | Collected |
| foreign-types@0.5.0               | A, I    | runtime        | MIT                                  | Collected |
| fs-set-times@0.20.3               | W, A, I | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| ident_case@1.0.1                  | W, A, I | build          | MIT                                  | Collected |
| io-extras@0.18.4                  | W, A, I | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| io-lifetimes@2.0.4                | W, A, I | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| json-patch@4.2.0                  | W, A, I | build, runtime | MIT                                  | Collected |
| objc2-app-kit@0.3.2               | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-core-foundation@0.3.2       | A, I    | build, runtime | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-core-graphics@0.3.2         | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-encode@4.1.0                | A, I    | build, runtime | MIT terms; notice/SDK review pending | Blocked   |
| objc2-exception-helper@0.1.1      | A, I    | build, runtime | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-foundation@0.3.2            | A, I    | build, runtime | MIT terms; notice/SDK review pending | Blocked   |
| objc2-io-surface@0.3.2            | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-quartz-core@0.3.2           | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-security@0.3.2              | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-service-management@0.3.2    | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2-web-kit@0.3.2               | A, I    | runtime        | Apache-2.0 text; SDK review pending  | Blocked   |
| objc2@0.6.4                       | A, I    | build, runtime | MIT terms; notice/SDK review pending | Blocked   |
| rustix@1.1.5                      | A, I    | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |
| same-file@1.0.6                   | W, A, I | build, runtime | Unlicense                            | Collected |
| selectors@0.38.0                  | W, A, I | build, runtime | MPL-2.0                              | Collected |
| serde_urlencoded@0.7.1            | W, A, I | runtime        | MIT                                  | Collected |
| shlex@2.0.1                       | W, A, I | build          | MIT                                  | Collected |
| tauri-plugin@2.7.1                | W, A, I | build          | Apache-2.0                           | Collected |
| vcpkg@0.2.15                      | W, A, I | build          | MIT                                  | Collected |
| version_check@0.9.5               | W, A, I | build          | MIT                                  | Collected |
| walkdir@2.5.0                     | W, A, I | build, runtime | Unlicense                            | Collected |
| webview2-com-macros@0.8.1         | W       | build          | MIT                                  | Collected |
| webview2-com-sys@0.39.1           | W       | runtime        | MIT                                  | Collected |
| webview2-com@0.39.1               | W       | runtime        | MIT                                  | Collected |
| winx@0.36.4                       | W       | runtime        | Apache-2.0 WITH LLVM-exception       | Collected |

## Reproducing the diagnosis

Install the pinned Cargo toolchain and locked npm dependencies. For each target (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-apple-darwin`), collect metadata without compiling or running Actions:

```sh
cargo metadata --locked --format-version 1 --manifest-path src-tauri/Cargo.toml --filter-platform <TARGET> --features custom-protocol > <metadata.json>
node scripts/distribution/diagnose.mjs <metadata.json> <new-output-directory>
```

The output directory must not exist; its parent must exist. Exit 0 means collection found no package failures; exit 1 means blocked packages remain. `diagnosis.json` contains all successful inventory entries and failures, including graph roles and known separate review conditions. It creates no distribution `index.json` or candidate manifest. Diagnosis may retain partial materials and must never be used as candidate staging. Normal `collectNotices` still throws at the first failure and cannot package a partially accepted Mac closure.

The source material, paths, expression semantics, hash/source mismatch, SDK mismatch, fail-closed review, MPL source retention and diagnostic separation are covered by `node --test scripts/distribution/distribution.test.mjs`. Native build/signature/ZIP execution, actual archive completeness, target-OS launch/update and final asset/SDK approval remain subject to the distribution review.
