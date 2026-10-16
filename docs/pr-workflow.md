# Development and pull requests

## Staged work

Start from current main and inspect related merged PRs, implementation, docs and acceptance tests. Confirm what is already implemented before reimplementing an open issue. Use an isolated branch/checkout when other work is active.

Share a recognizable initial UI for appearance review and small Native evidence for OS-dependent risks early. Implementation, independent review and documentation may proceed independently; avoid concurrent editing of one file and run heavy Windows verification sequentially. Keep reviewable results and blockers visible.

Use targeted checks during ordinary work, then group required Native/application checks at integration. Follow [testing](testing.md); do not replace real device acceptance with browser/mock success.

## PR contents

Use the repository PR template. Describe the concrete problem and resulting behavior, acceptance criteria, source/environment/commands/results, reuse rationale and important limits. Keep personal paths, real emails, temporary work logs and tool internals out of titles/bodies.

Review [coding standards](coding-standards.md), `git status --short`, the full diff and staged diff before committing. Stage intended files individually. Do not include caches, credentials, raw logs or `.tools/` output.

Write public-facing prose, including Issue/PR titles and bodies, in English and preserve user text, filenames, Japanese localization/help/tests and upstream license notices. Send multiline GitHub text through a structured argument or UTF-8 `--body-file`. After every Issue/PR creation or update, read back title/body/state and verify language as well as accuracy. On Windows, use UTF-8 console output before decoding CLI JSON.

## Issue reconciliation

Before an authorized merge, compare every related issue's acceptance conditions against final implementation and evidence. Use `Closes #number` when implementation is complete. Use `Refs #number` plus the remaining reason and tracking destination when incomplete. Explain why if no related issue exists.

After merging, inspect actual main rather than assuming a PR state proves its content. Close implementation-complete issues and retain incomplete work with the English `[Incomplete]` prefix, reason and follow-up. Move remaining QA-only work to a QA issue. Preserve mandatory Native/security release conditions and read back the resulting GitHub bodies, titles and states.

Human review is not a repository requirement, but that does not authorize an unrequested merge. Draft creation, merge, public repository creation, release publication and installer installation are distinct scopes.

## Product version

For 0.x, feature releases normally increment minor and fixes increment patch; inspect policy before incompatible changes. Increment once for the release, including stacked PRs. Documentation/template-only changes that do not alter application behavior or compatibility do not require a product version bump; explain this in the PR.

Align product entries in `package.json`, root `package-lock.json`, `src-tauri/Cargo.toml`, product `Cargo.lock` entry, `tauri.conf.json` and current distribution/verification procedures. Never rewrite dependency versions or historical evidence as part of a product bump.

For an explicitly requested release build, verify the ordinary executable's embedded version, identifier and features. Verify installer name/version only when requested. Record build source and its relationship to actual merged main; distinguish later documentation-only changes from the binary's source.

## Publication

A separate public repository should contain the reviewed current source/documentation and required licenses. Copying a clean tree does not clean the original private history or make existing private issue/PR text public-ready. Audit commit identity, tracked files, third-party notices and the intended audience before an independently authorized publication. Keep old private history intact; do not rewrite or force-push it merely to prepare documentation.
