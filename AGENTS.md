# Mogledge

## Before work

- Explicitly read `AGENTS.local.md` at the repository root if it exists. It is untracked and holds machine-specific development and HTML design instructions; do not replace the shared `AGENTS.md`. See [first-run instructions](docs/first-run.md#preserve-local-instructions).
- Read an environment-provided app development skill, if available, before development or documentation updates. Then read README, relevant docs, implementation and tests. Keep app development separate from the repository HTML authoring skill.
- If external development documentation is configured by the environment, read its `AI_README.md` and `manifest.json`; update only relevant chapters at that configured destination.
- Update relevant documentation and verification evidence when specifications, usage or development procedures change. Use English for public prose while preserving user data, Japanese UI/help/tests and license text.

## Implementation and verification

- Follow [coding standards](docs/coding-standards.md): meaningful names, cohesive responsibilities, existing UI/pure logic/IPC/persistence boundaries, typed inputs, failures and states. Comments explain reasons, invariants and performance constraints; update them with the change.
- Prefer a lightweight implementation. Do not add layers, dependencies or fragmentation only for readability, or mix unrelated cleanup and global formatting into a change. Review naming, responsibility and comment accuracy in the diff.
- Run `npm run check` for TS/React/lint configuration changes and relevant regression tests for behavior changes. Use the affected Rust crate's fmt/test/Clippy for Rust. For documentation only, check formatting, local links and the diff. Follow [verification scope and evidence](docs/testing.md#scope-and-evidence); unrun Native QA never counts as passed.
- Begin routine fixes with targeted checks/tests using the [three verification stages](docs/testing.md#three-verification-stages). Group application builds and full suites at required Native checks or integration points. HMR only establishes the behavior actually verified on the device; it does not replace Native QA.
- Check OS-dependent behavior, permission boundaries and drag risks on a small Native probe before the full implementation. Review appearance on an initial screen early. Implementation, independent review and documentation can run in parallel, but heavy Windows validation is sequential within the same environment. Generate or install an installer only when explicitly requested, including at release time. Share reviewable images/results and blockers early; see [staged work](docs/pr-workflow.md#staged-work).

## HTML authoring

Before creating, changing or converting HTML storage logic, read the [HTML skill](.agents/skills/my-knowledge-html/SKILL.md) and [storage API](docs/document-storage.md). Use canonical adapters and the standalone template. Verify restoration gating and protection against overwriting saved data after restoration failure. This workflow is for externally authored HTML, not app development.

## Build and update an existing app

- For an authorized build-and-update request, follow the [existing-app workflow](docs/update-guide.md#ai-build-and-update-workflow) through replacement at the confirmed fixed location and verification of the running app. Reuse authorization already given for that target; a build-only request ends with a verified artifact and its installation status.
- Save pending document input before normal Quit; unresolved saving or an active process stops replacement. Preserve the identifier, active profile, HTML/assets, local instructions, shortcuts and login registration.
- Reuse the existing build/cache and update procedures. Keep one managed previous-app rollback generation and verify the installed version/hash and launch target. Additional trial copies or registrations are not the default; independent QA remains a separately scoped use.
- Run device operations only on an accessible, authorized target OS. Report build, fixed-location update and launch verification separately, including any blocked step; do not report build success as an installed update.

## Documentation, commits and pull requests

- Do not put personal absolute paths, usernames beyond required technical attribution, real email addresses, unnecessary temporary branches, sessions, tool internals, logs or secrets in README, docs, commit messages or PR bodies.
- Describe procedures with repository-relative paths and generic placeholders. Include technical branch references, commit SHAs and verification results only when needed for review or traceability.
- Before committing, inspect `git status --short` and `git diff`, stage target files individually, and inspect `git diff --cached` for unintended files, private information or logs. Do not stage `.tools/`, generated logs or other output wholesale.
- Apply the same review to commit messages, pushed commits and PR titles/bodies. Verification records contain commands, results and necessary relative references.

## Merge and release

- Before a new implementation or reimplementation, inspect current main, its docs and relevant merged PRs. Distinguish completed implementation from remaining work; an open issue alone is not evidence of missing code.
- Before merging, reconcile issue acceptance criteria with the final diff and verification. Use `Closes` for completed implementation; use `Refs` with a reason and follow-up for incomplete work. Explain if there is no related issue. See [issue reconciliation](docs/pr-workflow.md#issue-reconciliation).
- After an authorized merge, inspect actual main, close completed issues, and mark incomplete issues with the established `[未完]` prefix, remaining reason and next tracking destination. Move QA-only follow-up into a QA issue without weakening required merge/release QA. Read back GitHub titles, bodies and states.
- Confirm the release's product version update before merging. Follow existing 0.x policy: features use minor, fixes use patch; consult release policy for incompatible changes. Update once per release, not once per stacked PR. Documentation/template-only changes with no product behavior change do not need a version bump; explain why in the PR.
- Keep product entries in `package.json`, root `package-lock.json`, `src-tauri/Cargo.toml`, product `Cargo.lock` entry, `tauri.conf.json` and current distribution/verification scripts aligned. Do not rewrite dependency versions or historical verification records.
- A release build must verify embedded executable version and installer name when an installer was requested. Record build-source SHA and its relationship to actual merged main. Distinguish later documentation-only changes from the binary's build source.
