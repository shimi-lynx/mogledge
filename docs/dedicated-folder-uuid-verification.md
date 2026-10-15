# Dedicated folders and UUID storage verification

This feature is prepared as a Draft PR for 0.9.0. Product manifests use one minor-version increment; release policies and historical release records remain pinned to the published version. There is no merge, Actions run, formal release or installer in this verification scope.

## Reused and focused evidence

- `npm run check`: formatting, TypeScript and lint passed after the frontend changes. The subsequent version-only manifest edit does not change TypeScript behavior.
- Application and backend `cargo clippy --lib --locked --offline -j 1 -- -D warnings`: affected native modules compile without warnings. Rust formatting is checked separately.
- `node --test tests/storage/generator.test.mjs tests/storage/samples.test.mjs`: 10 passed, covering fresh IDs, preserved regeneration, normalization, invalid/duplicate/conflicting IDs and restore/error behavior.
- `node --test tests/storage/authoring-kit.test.mjs`: 7 passed. The narrow reproduction/hash/link check passed again after the finalized API documentation was embedded into kit v2.
- Focused frontend tests passed for dedicated-folder management, UUID decisions, controller workspace boundaries, App startup and mandatory guide behavior. The later legacy-conflict change passed three targeted cases; unrelated browser cases were not repeated.
- Eight distinct browser cases passed using a mocked Native bridge, including folder creation/registration/cancellation/error preservation, missing folders, root-selector behavior, Japanese/English presentation and required guide behavior. Light/dark screenshots were inspected early.
- Synthetic Windows Native tests cover UUID restore across rename, hierarchy and cross-folder movement, replacement and a new Core/DB connection; stale grants; duplicate sharing/new IDs; physical legacy proofs and original-row/HTML-backup retention; setup conflicts, stale requests, unregister and missing roots; and recoverable owned-kit updating, edited files and locked-write rollback.
- Startup regression fixtures now register dedicated folders. The earlier physical-format display fixtures retain explicit legacy selection solely to verify their lower-level compatibility after the new startup registration gate.

The focused Native commands are:

```sh
cargo test --manifest-path tests/backend/Cargo.toml --lib --offline -j 1 -- document_identity::tests managed_folders::tests html_authoring::tests root_recovery::recovery_tests --test-threads=1
cargo test --manifest-path tests/backend/Cargo.toml --test registered_root_display --offline -j 1 -- --test-threads=1
```

Only changed cases are rerun after a failure or further implementation change. All fixtures are disposable; no real HTML, saved-input DB or formal app profile is migrated. Rust jobs and heavy Windows checks are kept sequential, using existing caches.

## Native preview and limits

The requested local Windows application preview uses a distinct compiled Tauri identifier, product title and synthetic configuration/local-data profile. Its private artifact manifest records the exact clean build-source SHA, executable hash/version, actual profile paths, launch ownership and validation results. The build is application-only; it does not replace the formal app or run an installer. Preview evidence is reported separately from browser/mock results.

No full suite is claimed. Native macOS behavior, exhaustive OS picker/permission/cloud cases, real-user migration, malicious-author isolation and cross-PC synchronization are outside these results. A known UUID is a trusted-document convention, not authentication. Required merge/release QA remains outstanding, including any existing platform-specific QA issues. Refs #25 remains open until its final Native acceptance conditions are reconciled; a Draft PR is not merge authorization.
