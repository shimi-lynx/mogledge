# Mogledge

Mogledge is a local HTML desktop viewer built with Tauri 2, React, TypeScript and Vite+. Keep HTML mini apps and their assets in a folder, browse them in tabs or two columns, and switch between tools without discarding their live state.

Files created by your editor or external AI remain the source of truth. Search uses a rebuildable local SQLite index. HTML apps can explicitly save JSON input through a separate storage API. Mogledge does not connect to an AI API or automatically send your documents to a service.

## Use Mogledge

Open a local folder with **Open knowledge**, then select an HTML file. Use the title-bar **Features and usage** button for bundled offline help. Settings let you switch between English and Japanese; your selected language is preserved.

- Open documents in one or two columns; moving a tab keeps its live HTML state.
- Search static text, use quick open, favorites, recent documents and saved workspaces.
- Create, rename, move and recycle supported local files through explicit actions.
- Enable optional tray residency, recall shortcuts and login startup in Settings.
- Prepare an optional HTML authoring kit, or hand a selected path and request to an external AI tool as an unsent draft.

Read the [user guide](docs/user-guide.md), [data and backup guide](docs/data-management.md) and [known limitations](docs/known-limitations.md). Search cannot inspect live JavaScript state, and closing a document does not automatically save its inputs.

Settings → **App updates** offers manual checking, release notes, verified downloads and explicit restart for enrolled signed distributions. Ordinary source builds and current app-only candidates keep this feature disabled. See the [in-app update guide](docs/in-app-updates.md) for saved-input confirmation and the remaining distribution/Native conditions.

Windows supports retained OneDrive reads and a limited writer for new HTML, nested folders, HTML rename and HTML/empty-folder moves. Every affected ancestor and item must have a supported local representation. Items observed as offline/partial and unsupported links remain rejected. Directory enumeration and rename may involve provider communication, population or waits; zero communication is not guaranteed. Unknown outcomes preserve files: refresh before another attempt. Nonempty-folder moves, anchored drops, reorder and trash remain restricted. See [cloud-folder limitations](docs/known-limitations.md#cloud-folders-and-links).

## Mogledge and a web browser

Mogledge organizes local HTML tools; a web browser remains the place for general websites. Both can display HTML and use tabs, but their storage and permissions differ.

| Task                                       | Mogledge                                                                                                  | Web browser                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Organize local mini apps                   | Folder tree, two columns, favorites and saved workspace sets                                              | Ordinary browser navigation and tabs                                                              |
| Ask an external AI to edit a tool          | Selected path/working directory plus an unsent request                                                    | Share or paste a request through the chosen service                                               |
| Keep input between sessions                | Explicit async JSON storage API, independent of the source HTML                                           | The adapter uses origin-local `localStorage`; data is separate and not automatically synchronized |
| Use standard web storage                   | Sandboxed HTML is not a drop-in `localStorage`/IndexedDB/cookie web app                                   | Site storage follows the browser's origin, permission and quota rules                             |
| Open external websites or YouTube          | Confirm and open in the default browser; embedded external sites/CDNs are unsupported                     | Use the website directly                                                                          |
| Play local media or export generated files | Relative MP3/MP4 support and a confirmed image/text export API; Native codecs/pickers require platform QA | Normal browser playback/download subject to browser support and permissions                       |

See [supported boundaries](docs/security.md), [storage](docs/document-storage.md), [export](docs/html-artifact-export.md) and [known limitations](docs/known-limitations.md). Neither environment automatically saves arbitrary JavaScript/Canvas state.

## Build from source

Use Node.js 22.18+ in the 22.x series or 24.11+, and the Rust toolchain pinned in `rust-toolchain.toml`. Windows also requires MSVC C++ Build Tools, Windows SDK and WebView2. macOS 12+ requires Xcode Command Line Tools.

```sh
npm ci
```

Windows, application only:

```powershell
npm run tauri -- build --no-bundle -- --locked --jobs 1
```

macOS, application only with ad-hoc signing:

```sh
npm run tauri -- build --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}' -- --locked --jobs 1
```

Default outputs are `src-tauri/target/release/my-knowledge.exe` and `src-tauri/target/release/bundle/macos/Mogledge.app`. The technical package and executable name remains `my-knowledge`.

See [first build and local instructions](docs/first-run.md) before preparing a new machine, and [updating and rollback](docs/update-guide.md) before replacing an existing app. Preserve custom `AGENTS.md`, `AGENTS.local.md`, `CLAUDE.md`, skills, HTML and profiles. `npm run build` creates only the frontend, not a complete desktop application.

An installer is a separate, explicitly requested build. `scripts/build.ps1` generates Windows NSIS; ordinary app-only builds do not. Signing, notarization and platform QA are described in [known limitations](docs/known-limitations.md).

Self-build remains supported. A separate manual GitHub Actions workflow is prepared for Windows x64 unsigned and macOS Apple Silicon/Intel ad-hoc app ZIP candidates, without installers. No Actions candidate has been built or validated yet; no downloadable release is available from this preparation. The workflow requires explicit cost and license confirmation before running, and retained artifacts expire after three days. Follow the [candidate download and opening guide](docs/binary-distribution.md#downloading-and-opening-a-candidate) when a reviewed artifact is available. Ad-hoc signing is not Developer ID authentication or notarization, and OS trust prompts may remain. Actual dependency notices, OS launch/update QA and distribution approval remain required before release.

## Author HTML apps

The optional [HTML authoring kit](docs/html-authoring-kit.md) contains a complete template, a guide and project skills. Install it only into a folder you choose and approve. Existing instructions and files are protected.

For repository-based authoring, use the [HTML skill](.agents/skills/my-knowledge-html/SKILL.md), [storage API](docs/document-storage.md) and [artifact export API](docs/html-artifact-export.md). Restore saved input before calculation or saving; failed restoration must not overwrite existing input with defaults.

## Development

```sh
npm run dev
npm run check
npm test
```

See [CONTRIBUTING](CONTRIBUTING.md) and the [documentation index](docs/README.md) for architecture, security and targeted verification. The existing manual macOS validation workflow is for Native QA. The separately prepared distribution workflow supports Windows and both Mac architectures; it does not replace Native QA or run on pushes, pull requests or tags. Actions execution requires a separate cost/policy check and explicit run approval.

## License

Original project code is provided under the [MIT license](LICENSE). Preserve its copyright notice and license text when redistributing it.

Dependencies, bundled third-party code and assets retain their own licenses. Keep the licenses and copyright notices in `src-tauri/vendor/wry`. Binary redistribution must include the notices required by the software actually bundled; where a license such as MPL-2.0 requires covered source availability, provide the applicable source and instructions. The project MIT declaration alone does not complete a binary license audit.
