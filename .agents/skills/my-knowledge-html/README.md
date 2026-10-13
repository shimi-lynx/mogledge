# Repository HTML skill and bundled authoring kit

[SKILL.md](SKILL.md) defines canonical HTML generation/conversion inside this repository. The independent kit installed into a user's authoring root is generated from `kit/guide.md`, `kit/skill.md` and canonical assets. See [kit setup and ownership](../../../docs/html-authoring-kit.md). Installed instructions do not require development-repository paths, npm or generation commands.

```sh
node scripts/build-html-authoring-kit.mjs
node --test tests/storage/authoring-kit.test.mjs
```

The generator writes only the four bundled resources in `src-tauri/html-authoring-kit/`: guide, Codex/Claude skills and complete HTML template. It records SHA-256 provenance for the storage/export adapters, canonical template and API specs. Update source prose or canonical assets and regenerate; do not edit generated resources by hand. Check affected sample HTML/storage contracts and exact reproduction tests. Node/formatter dependencies apply only during generation.

A build assistant explains the destination root and confirms three independent choices:

1. Place the storage guide and complete persistent HTML template.
2. Place project-local Codex `.agents/skills` and Claude `.claude/skills` entries in that root.
3. Add a guide-read instruction to future AI handoff drafts.

Existing explicit consent for the same root/choices is sufficient. A build request alone is not installation consent; ordinary build scripts must not noninteractively write user roots. Preserve AGENTS.md, AGENTS.local.md, CLAUDE.md and unrelated skills. Initial setup only creates new files or confirms same-version, unchanged manifest-owned files. Preserve/skip/report older, modified or unowned conflicts. Updates require separate preservation and manual review. Setup does not send user content, reconfigure AI apps or write test state into production folders.

The installed guide/template links are relative to the installed skill location. Keep those links and each source's `{{PROVENANCE}}` marker intact. File placement is not proof of AI discovery or real Native operation; record actual checks separately following [testing](../../../docs/testing.md).
