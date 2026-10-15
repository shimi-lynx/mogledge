# Mogledge dedicated folders

From 0.9.0, the root selector opens only folders registered through **Settings → Dedicated folders**. Create a new folder beneath a selected parent, or register an existing folder without moving its HTML. Multiple dedicated folders can be registered. A missing or moved folder stays in the list and does not stop startup. Re-register a moved folder at its new location; its marker must match and the former location must be unavailable.

With no registered folders, including after unregistering the last one, startup shows the ordinary create/register onboarding. Retained legacy root settings do not produce a saved-folder warning. A selected registered folder that becomes unavailable keeps its warning and retry action.

## Setup and ownership

Registration places a complete template, guide, Codex Skill, Claude Skill, and `.mogledge/mogledge-folder.json` management marker. The marker contains a folder UUID for registration only; it is never part of an HTML saved-input key. The profile records the folder list and selected entry separately from user content.

Setup preflights all reserved destinations. Existing `AGENTS.md`, `AGENTS.local.md`, `CLAUDE.md`, unrelated Skills and HTML remain untouched. An unowned collision blocks registration rather than being adopted or overwritten. Cancelling the Native picker performs no setup. Interrupted setup remains incomplete; already placed owned material can be checked on retry. Registration is reported complete only after all required resources and the marker are present and the profile list is saved.

Unregister removes only the list entry. It retains the folder, HTML, kit, saved-input DB and recovery data. Unregistering the selected entry closes its runtime views. Switching dedicated folders requires saving current input first; running JavaScript and unsaved controls are not carried across the switch.

## Kit updates and AI handoff

Selection and AI handoff compare the selected folder's installed version, ownership manifest and file hashes with the bundled kit. Unmodified app-owned old files are backed up beneath `.mogledge/html-authoring/backups/` before replacement. The manifest advances only after all new outputs are verified. A failed replacement preserves the backup and attempts to roll back completed replacements without overwriting intervening edits. A locked or incomplete rollback is an update failure, not a current kit.

Edited, unowned or conflicting outputs are retained and shown as needing attention. Other unmodified owned resources can still update; the manifest does not claim the whole kit is current. AI handoff requires the latest verified guide, so an edited outdated guide blocks handoff until reconciled. Updates never edit HTML or the DB. There are no background updates across every registered folder and no network downloads.

Kit version 3 uses `.mogledge` and the installed `mogledge-html-authoring` Skill. Older `.my-knowledge` guides, manifests, backups and `my-knowledge-html-authoring` Skills stay intact, including user edits. The new canonical resources are installed separately. A legacy management marker is read for compatibility; its same folder UUID is copied to the canonical marker only after the new kit verifies. Conflicting canonical resources block setup without being overwritten, and inconsistent old/new markers fail closed. A failed or interrupted setup can retry without deleting the legacy resources. Explicitly direct existing AI sessions to the canonical guide and Skill; retained old Skills may still be discoverable.

Saved-input keys, browser storage keys, API globals/protocols, installed executable names and profile identifiers retain their compatibility names. These internal names do not select a new saved-data namespace.

AI handoff includes an instruction to read the latest verified guide by default, including a folder handoff with no extra request. This cannot guarantee that an existing AI conversation discards cached instructions. The app validates document IDs independently of whether an AI tool follows its Skill. See the [authoring kit](html-authoring-kit.md).

## Document identity and migration

HTML saved input uses its static `mogledge-document-id` UUID. The dedicated-folder ID, pathname and physical root are absent from that logical key. Rename, ordinary hierarchy changes, movement between dedicated folders, restart and atomic HTML replacement preserve input when the UUID is preserved. Tabs, favorites, workspace preferences and permission grants retain their existing physical identity checks and root-relative paths.

Canonical API paths use `/` on every OS, including nested Unicode folders. Internal Windows parent-directory checks preserve that representation; callers must not send backslashes or traversal paths. The 0.9.1 correction covers UUID admission, explicit document-ID edits and saved-data target inspection beneath multiple directory levels. See the [focused verification record](storage-fix-verification.md) for platform and recovery limits.

A different known file carrying the same UUID is held until the main UI explicitly shares that saved input or creates a new document ID. Missing IDs remain viewable and require an explicit add action before saving. Malformed or multiple IDs fail closed. Adding/changing an ID backs up the original HTML before guarded atomic replacement and revokes old grants. It never authorizes an iframe to select another namespace.

Legacy DB records remain intact. An exact physical association, or a previously captured root-independent object proof, permits copying retained input into a new UUID record within one quota-accounted transaction. Path similarity alone does not authorize migration. Unresolved legacy records require an explicit main-UI recovery choice or an explicit new document with an empty namespace; neither overwrites the old record or an existing UUID target. Copies consume additional quota. The DB schema and document storage API remain unchanged; the profile keeps a bounded identity catalog. Preserve both configuration/profile records and the saved-input DB when backing up or rolling back.

A deliberately copied known UUID can share data with trusted HTML. This feature is not an authentication boundary against a malicious author and does not synchronize DBs between PCs. See [document storage](document-storage.md).

## Verification scope

Synthetic Windows Native probes cover UUID parsing, copy decisions, rename, hierarchy and cross-folder moves, replacement, restart, legacy migration and original retention. Folder and kit probes cover setup, collisions, stale requests, unregister, missing folders, ownership-aware updating, edited files and locked-write rollback. Focused browser cases use a mocked Native bridge. These results do not establish macOS Native behavior, every picker/permission failure, or real-user-data migration. No real HTML/profile is modified for verification.
