# AI handoff working-root verification

## Behavior and boundaries

AI handoff uses the selected registered workspace root as the receiving tool's working directory. Child folders, deeper folders and files remain explicit task targets in the draft. The root selection uses the directory parameter without adding a duplicate path. Copy-only handoff states the working directory because the user must select it manually.

Dedicated-folder guide composition also applies to an empty request. It directs the AI to check applicable Codex or Claude instructions from the working root to the target and additional instructions below directories it edits. Existing instruction files are never rewritten. Legacy unregistered folders keep their existing optional-guide behavior. Native path/root guards, preview equality checks, fixed receiving schemes, inert drafts, length checks and copy-error handling remain in place.

The target is a task description, not an OS permission boundary. Root startup does not establish automatic discovery of nested instructions or Skills. No receiver trust or permission prompt is bypassed.

## Focused verification

Checks use Windows x64, current main `d2e6334c920046ae4562c18a8eec3fd86f7c65cc` plus the changes in this PR, existing dependency/build caches and one Cargo job. All paths, HTML and instructions in backend fixtures are synthetic.

| Scope                                                                                                                                                            | Command                                                                                                                                                                   | Result and limits                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root/child/grandchild/file, Japanese and spaced paths, empty and exact requests, current-root/preview validation, retained handles, URL encoding and size limits | `cargo test --manifest-path tests/backend/Cargo.toml --lib --locked --offline --jobs 1 -- ai_handoff::tests html_authoring::tests::trusted_native_guide --test-threads=1` | 10 passed. Real Windows filesystem and production backend modules; receiving-client dispatch intercepted. Existing `AGENTS.md`, `CLAUDE.md` and nested override bytes retained. Guide paths remain relative to the working root. |
| Draft composition, guide/target length accounting, copy failures, translations and dialog behavior                                                               | `npm test -- src/lib/aiHandoff.test.ts src/app/AiHandoffDialog.test.tsx`                                                                                                  | 24 passed. React/IPC mocked; no real clipboard or receiving client.                                                                                                                                                              |
| Frontend quality                                                                                                                                                 | `npm run check`                                                                                                                                                           | Passed: formatting, lint and TypeScript.                                                                                                                                                                                         |
| Rust formatting                                                                                                                                                  | `cargo fmt --manifest-path tests/backend/Cargo.toml`; `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                            | Passed.                                                                                                                                                                                                                          |

Receiving-client launch, actual draft receipt, clipboard, trust prompts and automatic instruction/Skill discovery were not exercised. macOS Native and a rebuilt desktop preview were not run. Existing user apps, profiles and authoring files were not changed.

Both affected crates also passed `cargo clippy --lib --locked --offline --jobs 1 -- -D warnings` using their respective manifests. Each local crate was forced to recheck after switching source worktrees while dependency caches were retained.

## Integration references

- [Codex desktop commands](https://learn.chatgpt.com/docs/reference/commands#deep-links): `codex://new` accepts a local directory in `path` and composer text in `prompt`.
- [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md): startup discovery walks from the recognized project root to cwd, selecting an override, standard file or configured fallback. Starting at a root does not guarantee discovery of child instructions.
- [Claude Code CLI links](https://code.claude.com/docs/en/deep-links): `claude-cli://open` separates `cwd` from unsent `q`; directory trust and permissions still apply.
- [Claude instruction loading](https://code.claude.com/docs/en/memory): ancestor instructions load at launch; deeper instructions load on demand.
- [Claude Desktop reference](https://code.claude.com/docs/en/desktop): the existing `claude://code/new?folder=...&q=...` local route is retained. The current reference explicitly describes its SSH extension; local-folder parameter compatibility with an installed desktop version remains a receiving-client check.

No new receiving scheme, shell command, handler registration or AI configuration is introduced. Codex CLI remains copy-only.
