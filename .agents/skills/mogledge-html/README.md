# Repository HTML skill and bundled authoring kit

[SKILL.md](SKILL.md) defines canonical HTML generation/conversion inside this repository. The independent kit installed into a user's authoring root is generated from `kit/guide.md`, `kit/skill.md` and canonical assets. See [kit setup and ownership](../../../docs/html-authoring-kit.md). Installed instructions do not require development-repository paths, npm or generation commands.

```sh
node scripts/build-html-authoring-kit.mjs
node --test tests/storage/authoring-kit.test.mjs
```

The generator writes only the four bundled resources in `src-tauri/html-authoring-kit/`: guide, Codex/Claude skills and complete HTML template. It records SHA-256 provenance for the storage/export adapters, canonical template and API specs. Update source prose or canonical assets and regenerate; do not edit generated resources by hand. Check affected sample HTML/storage contracts and exact reproduction tests. Node/formatter dependencies apply only during generation.

Creating a Mogledge dedicated folder or registering an existing one requires the guide/template, project-local Codex and Claude skills, and a management marker. Multiple dedicated folders can be registered. Use the main app's explicit registration actions; cancellation, conflict or partial failure does not complete registration. AI handoff drafts include a guide-reading instruction by default. An ordinary build does not register a folder, and developer scripts do not write user folders.

Preserve AGENTS.md, AGENTS.local.md, CLAUDE.md, unrelated skills, HTML and assets. Selected-folder checks, including before AI handoff, back up app-owned unchanged older kit files recoverably before updating to kit version 3. Edited/unowned/conflicting files are retained with an update-available notice. A failed write retains the old version without claiming the latest. Kit updates must not modify user HTML or saved-input databases, update every folder in the background or fetch network resources. Existing AI conversations must explicitly reread updated guide/Skill files. Unregistering keeps files and saved input. Document UUIDs, rather than dedicated-folder IDs, identify saved input across moves between registered folders. Setup does not send user content, reconfigure AI apps or write test state into production folders.

The installed guide/template links are relative to the installed skill location. Keep those links and each source's `{{PROVENANCE}}` marker intact. File placement is not proof of AI discovery or real Native operation; record actual checks separately following [testing](../../../docs/testing.md).
