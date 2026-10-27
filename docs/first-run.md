# First build and local instructions

For a completed application ZIP, follow [candidate download and opening](binary-distribution.md#downloading-and-opening-a-candidate); Node, Rust and C++ build tools are not required to run it. The steps below are for building from source.

## Preserve local instructions

Before pulling or building, read the shared `AGENTS.md` and explicitly read an existing `AGENTS.local.md`. Preserve custom `CLAUDE.md`, skills, generated HTML and uncommitted work on every machine, including macOS.

If a machine has a customized tracked `AGENTS.md`, copy it to a safe location outside the checkout first. Compare it with the shared version and manually move only machine-specific instructions into untracked `AGENTS.local.md`. Confirm the backup and migrated instructions before restoring the shared file. Do not overwrite custom instructions with a bulk checkout, reset or automated migration. Git does not protect untracked files.

```sh
git status --short
git diff -- AGENTS.md
git check-ignore AGENTS.local.md
```

The local file is explicitly read because automatic discovery varies by AI tool and version. Keep application-development instructions distinct from HTML design instructions. User requests take precedence over repository instructions.

The Git commands apply to a checkout. An extracted source archive has no Git metadata; preserve its existing local files directly before replacing or extracting another source tree.

## Prerequisites

| Environment | Requirements                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| All         | Node.js 22.23.4+ in 22.x or 24.22.1+ in 24.x, npm, pinned Rust 1.99.0, network access for missing locked dependencies |
| Windows     | MSVC C++ Build Tools, Windows SDK, WebView2; use the MSVC Rust host                                       |
| macOS 12+   | Xcode Command Line Tools and the matching Rust host                                                       |

Check `node --version`, `npm --version`, `rustc -vV` and `cargo --version`. On macOS, check `xcode-select -p` when needed. Rustup can download the pinned toolchain on first use. Explain missing system tools or permissions rather than bypassing OS protections. A global Vite+ installation or `tauri-driver` is not needed for an ordinary app build.

Back up existing HTML/assets and any app profile before first use on a machine with previous data. Check `node_modules` for custom content before `npm ci`, which replaces dependencies.

## Build an ordinary application

Obtain the intended reviewed source revision in a separate checkout, or extract the candidate's `source.zip` into a new directory. For a supplied candidate, match the source SHA and source ZIP hash to its manifest. Enter the source directory containing `package.json`, `src-tauri` and `AGENTS.md`, read the local instructions above, then run with the prepared environment:

```sh
npm ci
```

Windows, release executable only:

```powershell
npm run tauri -- build --no-bundle -- --locked --jobs 1
# Default output when CARGO_TARGET_DIR is unset:
& './src-tauri/target/release/mogledge.exe'
```

macOS, application only with ad-hoc signing:

```sh
npm run tauri -- build --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}' -- --locked --jobs 1
open 'src-tauri/target/release/bundle/macos/Mogledge.app'
```

Do not enable `e2e`/`e2e-embedded` or a QA identifier in the ordinary application. `npm run build` produces only frontend assets. `scripts/build.ps1` produces NSIS and is not the app-only command. The macOS configuration above selects ad-hoc signing; it does not identify a verified publisher or provide notarization. Installer generation/installation, Developer ID signing, notarization and system installation are separate actions. Do not disable OS protection to make a build launch.

For ongoing use, place the EXE or complete Mac bundle at a chosen fixed location before configuring shortcuts or login startup. Follow the [update guide](update-guide.md) when replacing an existing app; a build output or temporary checkout is not a stable installed target.

For a build-and-update request, complete the [AI existing-app workflow](update-guide.md#ai-build-and-update-workflow) at that fixed location instead of adding another ordinary trial app. An authorized update preserves the existing identifier, active profile and launch references; report the installed/running version separately from build success.

Use disposable HTML and a [dedicated QA profile](testing.md#native-qa) for verification when the regular profile must remain untouched. Even opening a fixture with the ordinary app can write its normal state database. Record build source, binary version/hash and what was actually verified. See [known limitations](known-limitations.md); build success is not full Native QA.

## HTML authoring

Read the [HTML skill](../.agents/skills/mogledge-html/SKILL.md) and [storage API](document-storage.md) before authoring or converting saved inputs. Authoring alone does not require rebuilding the desktop app or installing Rust/C++ tools.

Creating or registering a [dedicated folder](registered-folders.md) places the required [authoring kit](html-authoring-kit.md): guide/template and Codex/Claude Skills. A build request does not authorize registration of real user folders. Preserve existing HTML, instructions and Skills; retain approval already given for the same folder and options. Verification uses synthetic folders and a separate app profile.
