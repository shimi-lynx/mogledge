# HTML authoring kit

Mogledge installs a storage API guide, a complete HTML template and project-local Codex/Claude Code authoring skills when creating or registering a dedicated folder. Multiple dedicated folders can be registered. Authoring and HTML execution do not require the Mogledge source repository, npm or internal source paths.

## Dedicated-folder registration

Use the main app's explicit **Create dedicated folder** or **Register existing folder** action. Both require the complete authoring kit and a management marker before registration can finish:

| Required content   | Relative destination                                    |
| ------------------ | ------------------------------------------------------- |
| Guide and template | `.mogledge/html-authoring/GUIDE.md` and `template.html` |
| Codex skill        | `.agents/skills/mogledge-html-authoring/SKILL.md`       |
| Claude Code skill  | `.claude/skills/mogledge-html-authoring/SKILL.md`       |
| Management marker  | `.mogledge/mogledge-folder.json`                        |

Cancellation, a conflict or partial installation does not complete registration. Preserve existing instruction files, skills, HTML and other assets. Resolve conflicts explicitly rather than overwriting them. An ordinary app build does not register a folder; developer generation scripts only prepare bundled resources.

AI handoff drafts include a relative instruction to read the guide by default. They preserve the selected working folder and the user's request; no file contents are attached or sent automatically. A handoff remains an unsent draft.

Unregistering keeps the folder, HTML, installed kit and saved-input database. The dedicated-folder ID authorizes and tracks that folder; it is not part of the document storage key. Moving the same logical document between registered dedicated folders retains its UUID and saved input.

## Ownership and conflicts

Kit payload version is 3 and storage API version is v1. Ownership covers only its fixed guide/template/skill files. `.mogledge/html-authoring/manifest.json` records version and hashes. Initial setup creates new files or confirms that same-version, unmodified, manifest-owned files match the current bundle. The selected folder is checked for the bundled kit version and ownership hashes, including before AI handoff. App-owned, unchanged older files receive a recoverable backup before updating. Edited, unowned or conflicting files are preserved and reported with an update-available notice. A failed write retains the old version and must not be reported as current. The app does not update every registered folder in the background or fetch kit resources from the network.

The management marker is separate from the ownership manifest: `{ "version": 1, "id": "<folder UUID>", "kind": "mogledge-managed-folder" }`. The active profile maintains its own folder registry. Neither this marker nor a kit update changes HTML document UUIDs or saved-input databases.

Existing AGENTS.md, AGENTS.local.md, CLAUDE.md and unrelated skills are not changed. Partial failures do not roll back by deleting original or already-created files. Preview, explicit apply, cancellation, root revalidation and conflict reporting remain subject to the normal Native write boundary. Setup does not bypass OneDrive, placeholder, link or ordinary-local write restrictions.

Guide instructions are included in AI handoff drafts by default for registered dedicated folders. Unregistering does not delete the installed kit or undo drafts already handed off.

## Authoring with the template

Start the AI in the selected root and have it read the installed skill and `.mogledge/html-authoring/GUIDE.md`. The template is a complete calculator example. Copy it to a new chosen output, replace its `REPLACE_WITH_NEW_UUID` placeholder in the static `mogledge-document-id` meta content with a fresh UUID v4 for a new independent document, then modify inputs, calculations and presentation. Preserve an existing document's UUID during edits and regeneration, including atomic replacement and moves between roots. Keep exactly one canonical non-nil UUID; malformed/multiple metadata blocks Native storage. A missing ID requires an explicit main-app add-ID action before storage, while viewing remains available. A copy retaining its UUID requires the main app's share-or-new-document choice. UUIDs can deliberately share data within the same PC/profile and are not secrets. Preserve its first two inline adapter scripts, `MyKnowledgeStorage` followed by `MyKnowledgeExport`, unchanged and in order. Define the application appId/schema, validation, restore sequence and save errors in the app script. The resulting complete HTML must run without the kit or sibling runtime scripts.

Startup follows asynchronous read → validate → restore → calculate. Disable editing while restore is pending. Initial read/schema/data failure disables saving and must not overwrite old state with defaults. Explicit Save cancels debounce and awaits the latest write and flush. A present Native descriptor selects only Native transport, including failures; never fall back to localStorage. Ordinary-browser localStorage is separate, and `file:`, policy and origin quota need separate checks.

[Document storage](document-storage.md) defines byte accounting, configurable logical limits versus runtime capacity, UUID-only admission, ordinary JSON transfer, backup and older-app compatibility. [Artifact export](html-artifact-export.md) defines generated-file export, separate from saved JSON. The installed guide includes these essential contracts without requiring the development repository.

Treat user text, names and paths as data. Preserve originals and user instructions. Verify isolated fixtures; do not write test values into the user's production root/profile or send their files/state to an AI service without instruction.

Legacy `.my-knowledge` resources and `my-knowledge-html-authoring` skills are compatibility paths only. Canonical resources use `.mogledge` and `mogledge-html-authoring`. Preserve edited legacy guides and skills at their existing paths; install the new canonical resources separately rather than overwriting those originals. Canonical edited/unowned conflicts are still preserved and reported. An old skill path does not make a new guide current: explicitly read the canonical guide and Skill after migration.

## Skill discovery

The kit places project skills in Codex's `.agents/skills` and Claude Code's `.claude/skills` layout. Both entries use the same YAML name/description and self-contained instructions. Their links return from the installed SKILL.md directory to the root's guide/template.

The bundled template deliberately has an invalid UUID placeholder, so Native saving is blocked until an author replaces it with a fresh valid UUID.

Successful file placement does not prove the AI discovered or applied a skill. AI version, settings, policy and starting directory can affect this. If discovery fails, explicitly ask it to read the installed SKILL.md and GUIDE.md. Do not work around discovery by global installation, rewriting AGENTS/CLAUDE files or changing AI configuration. Record actual discovery/use separately from setup success. Have the AI read the latest installed guide and Skill; an already running AI conversation may cache older instructions and is not automatically refreshed by a file update.

Reference entry points:

- [Codex skill roots implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)
- [Codex skills documentation](https://developers.openai.com/codex/skills/)
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)

## Regenerate the bundled kit

See the [repository skill README](../.agents/skills/mogledge-html/README.md).

```sh
node scripts/build-html-authoring-kit.mjs
node --test tests/storage/authoring-kit.test.mjs
```

Sources are `kit/guide.md` and `kit/skill.md` in the repository skill, plus canonical `assets/generated-sample.json`, `assets/template.html`, `assets/storage.js` and `assets/export.js`. The development generator uses the existing HTML assembly CLI and writes only the four bundled resources in `src-tauri/html-authoring-kit/`. It embeds SHA-256 provenance for canonical adapters/template/API specs; focused tests check exact regeneration and installed relative links. Do not edit generated resources by hand. Generation-time Node/formatter dependencies do not become dependencies of installed instructions or finished HTML.

Follow [testing](testing.md) for validation. Browser/mock results, file placement and source-level checks do not establish real Native setup or automatic AI skill discovery.
