# Mogledge 0.8.1 updater corrections

Version 0.8.1 simplifies the existing manual updater. After automatic signature
and signed-version verification succeeds, **Update and restart** is available
with a short warning that unsaved input will be lost. The mandatory
save-confirmation checkbox is removed from the shared Japanese/English UI and
its IPC/Native API. Ready-state, verified staged bytes, main-window authorization,
cancellation and duplicate-operation guards remain required.

Explicitly selected signed-update builds also retain their typed artifact
decision at compile time. This corrects a Tauri codegen field omission that
otherwise disabled the updater despite the selected distribution configuration.
The base configuration stays disabled. Runtime environment changes cannot enroll
an app; HTTPS, public-key, signed-version, release/feature and installed-layout
checks remain required. No feed, key or packaging route is selected here.

This is a patch correction to an existing feature under the 0.x version policy.
Product version entries and the current Windows verification installer filename
align at 0.8.1. Dependency versions and historical verification records retain
their original scope. The identifier, profiles, installation identity, storage
API and default disabled updater enrollment are unchanged.

Normal Quit and normal launch do not install a staged update. There is no
persistent download, automatic restart, production feed activation or new
permission. Read the [update guide](in-app-updates.md) for saved-input and
installation boundaries.

Retained signed 0.8.0 QA artifacts exercise the previous UI. They remain useful
for that source's cryptographic/install-path evidence, but cannot validate this
interaction without a newly built QA app. Such an app can exercise its handoff
to a retained signed target; validating 0.8.1 as the installed signed target also
requires a new signed artifact. The changed interaction has not passed an
isolated Native probe. Existing incomplete Native rejection and
Mac/platform/distribution conditions remain incomplete.

## Targeted verification

- `npm run check`: format, types and lint passed without warnings.
- `npm test -- src/app/AppUpdateSettings.test.tsx src/lib/appUpdater.test.ts src/lib/i18n.test.tsx`: 14 passed, including enabled verified restart without a checkbox, zero-argument IPC, cancellation/stale replies and pending-operation guards.
- `npm run test:ui -- tests/ui/app-updater.spec.ts --workers 1`: two mocked-API cases passed in system Edge on Windows. Japanese/English, simulated Windows/macOS, 760/320px screenshots were inspected; this does not establish WebView2 or WKWebView behavior.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --features distribution-updater updater --jobs 1 -- --test-threads=1`: 15 passed with an explicitly selected boolean-true artifact configuration. They include the actual generated-context field omission, compiled decision retention, normal/foreign identifiers, false/null/legacy/malformed configuration, signature failure and cancellation/duplicate guards. The earlier ordinary-configuration run passed 14 before the foreign-identifier regression was added.
- Both app/backend `cargo fmt --check` and app `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib --features distribution-updater --jobs 1 -- -D warnings` passed on Windows.
- The main-only capability/default-enrollment Node regression passed. Integrated distribution fixtures passed 19 with four skipped platform/symlink probes; they do not establish a candidate build or Native distribution pass.

The added build/test dependency references reuse already locked Tauri configuration
and JSON merge packages. Package versions, checksums and existing legal-material
records are unchanged. Independent source review found no unresolved blocker.
