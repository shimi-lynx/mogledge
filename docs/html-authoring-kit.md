# HTML authoring kit

Mogledge can optionally place a storage API guide, a complete HTML template and project-local Codex/Claude Code authoring skills in the selected knowledge root. Once installed, authoring and HTML execution do not require the Mogledge source repository, npm or internal source paths.

## Optional setup and user choices

Building the app and setting up a user's authoring folder are separate operations. A build assistant explains the target root and these choices, then applies only the user's confirmed preferences:

| Choice                  | Files or behavior                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Guide and template      | `.my-knowledge/html-authoring/GUIDE.md` and `template.html`                                                                      |
| Codex and Claude skills | `.agents/skills/my-knowledge-html-authoring/SKILL.md` and `.claude/skills/my-knowledge-html-authoring/SKILL.md` in the same root |
| Read-guide instruction  | Add a relative guide reference to future AI handoff drafts for that root; no file contents are attached or sent                  |

Explicit consent already given for the same root and choices remains sufficient. An unanswered question or an ordinary build request does not authorize installation or guide inclusion. When no root/preferences are selected, build can proceed and setup can wait until **AI HTML authoring** in app settings. Ordinary build/generation scripts do not noninteractively write to user roots. Setup does not send drafts to AI services, write test state into a production folder or change OS protection settings.

For example:

> Build the app. Explain the selected root and the three optional HTML kit choices: guide/template, Codex/Claude skills, and guide-read instructions in future handoffs. Reuse my existing confirmed choices for that root. Apply other choices only after confirmation. Preserve existing AGENTS.md, AGENTS.local.md, CLAUDE.md, skills and user HTML.

## Ownership and conflicts

Kit payload version is 1 and storage API version is v1. Ownership covers only its fixed guide/template/skill files. `.my-knowledge/html-authoring/manifest.json` records version and hashes. Initial setup creates new files or confirms that same-version, unmodified, manifest-owned files match the current bundle. Older, edited or unowned files/manifests are preserved and reported as conflicts; they are skipped rather than overwritten. Updates require separate original preservation and manual review.

Existing AGENTS.md, AGENTS.local.md, CLAUDE.md and unrelated skills are not changed. Partial failures do not roll back by deleting original or already-created files. Preview, explicit apply, cancellation, root revalidation and conflict reporting remain subject to the normal Native write boundary. Setup does not bypass OneDrive, placeholder, link or ordinary-local write restrictions.

Guide inclusion starts OFF and does not alter an unconfigured empty request. Folder handoffs retain the folder working directory and the user's request; prefer a relative guide reference. Turning inclusion OFF does not remove installed files or undo drafts already handed off.

## Authoring with the template

Start the AI in the selected root and have it read the installed skill and `.my-knowledge/html-authoring/GUIDE.md`. The template is a complete calculator example. Copy it to a new chosen output, then modify inputs, calculations and presentation. Preserve its first two inline adapter scripts, `MyKnowledgeStorage` followed by `MyKnowledgeExport`, unchanged and in order. Define the application appId/schema, validation, restore sequence and save errors in the app script. The resulting complete HTML must run without the kit or sibling runtime scripts.

Startup follows asynchronous read → validate → restore → calculate. Disable editing while restore is pending. Initial read/schema/data failure disables saving and must not overwrite old state with defaults. Explicit Save cancels debounce and awaits the latest write and flush. A present Native descriptor selects only Native transport, including failures; never fall back to localStorage. Ordinary-browser localStorage is separate, and `file:`, policy and origin quota need separate checks.

[Document storage](document-storage.md) defines byte accounting, configurable logical limits versus runtime capacity, identity, confirmed previous-state handoff, backup and older-app compatibility. [Artifact export](html-artifact-export.md) defines generated-file export, separate from saved JSON. The installed guide includes these essential contracts without requiring the development repository.

Treat user text, names and paths as data. Preserve originals and user instructions. Verify isolated fixtures; do not write test values into the user's production root/profile or send their files/state to an AI service without instruction.

## Skill discovery

The kit places project skills in Codex's `.agents/skills` and Claude Code's `.claude/skills` layout. Both entries use the same YAML name/description and self-contained instructions. Their links return from the installed SKILL.md directory to the root's guide/template.

Successful file placement does not prove the AI discovered or applied a skill. AI version, settings, policy and starting directory can affect this. If discovery fails, explicitly ask it to read the installed SKILL.md and GUIDE.md. Do not work around discovery by global installation, rewriting AGENTS/CLAUDE files or changing AI configuration. Record actual discovery/use separately from setup success.

Reference entry points:

- [Codex skill roots implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs)
- [Codex skills documentation](https://developers.openai.com/codex/skills/)
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)

## Regenerate the bundled kit

See the [repository skill README](../.agents/skills/my-knowledge-html/README.md).

```sh
node scripts/build-html-authoring-kit.mjs
node --test tests/storage/authoring-kit.test.mjs
```

Sources are `kit/guide.md` and `kit/skill.md` in the repository skill, plus canonical `assets/generated-sample.json`, `assets/template.html`, `assets/storage.js` and `assets/export.js`. The development generator uses the existing HTML assembly CLI and writes only the four bundled resources in `src-tauri/html-authoring-kit/`. It embeds SHA-256 provenance for canonical adapters/template/API specs; focused tests check exact regeneration and installed relative links. Do not edit generated resources by hand. Generation-time Node/formatter dependencies do not become dependencies of installed instructions or finished HTML.

Follow [testing](testing.md) for validation. Browser/mock results, file placement and source-level checks do not establish real Native setup or automatic AI skill discovery.
