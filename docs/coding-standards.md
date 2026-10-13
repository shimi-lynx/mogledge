# Coding standards

Apply these rules to new code and the changed area. Preserve lightweight operation and existing boundaries; do not refactor unrelated code to satisfy a style preference.

1. Name by responsibility, action and unit. Keep workspace/view/tab/revision terminology consistent and distinguish identifiers from paths, bytes from MiB, and milliseconds from seconds.
2. Keep responsibilities cohesive. Prefer meaningful variables and early returns over extra layers or files that only forward calls. No arbitrary function-size limit applies.
3. Preserve UI, pure logic, Native IPC and persistence boundaries. Reuse existing placement and APIs; do not add a runtime dependency or generic wrapper only for readability.
4. Express inputs, failures and states with existing types/enums, and validate at trust boundaries. Keep natural inference. Explain necessary `any`, assertions or suppressions; types do not replace runtime checks. Use `===`/`!==`, `const` for stable bindings and `let` for reassignment.
5. Comments explain reasons, invariants, race handling and performance constraints. Update them when behavior changes; avoid restating every instruction.
6. Match verification to the change. Behavior changes need relevant regression coverage. Changes to scanning, allocations, rendering, iframe lifetime, I/O or resident processing need appropriate measurements and explicit limits.

## Verification and review

| Change                      | Automated checks                                  | Diff review                                                            |
| --------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| TS/React/lint configuration | `npm run check` for formatter, lint and types     | Names, responsibility, types, boundary checks and suppression reasons  |
| Documentation               | Targeted formatting and local-link checks         | Accurate instructions, live references and no private work information |
| Rust                        | Affected crate fmt/test/Clippy with `-D warnings` | Ownership, failure/state handling, IPC/filesystem permissions          |
| Behavior or performance     | Relevant unit/browser/Native QA and benchmark     | Acceptance criteria, comparisons and unverified limits                 |

Use existing strict TS and formatter settings. Preserve exclusions for vendor/generated/local output; do not globally enable pedantic rules, introduce readability scores or reformat the repository. Format only changed files using `npm run fmt -- <files>` and inspect the diff.

Read [testing](testing.md) for evidence reuse and staged checks, and [PR workflow](pr-workflow.md) for recording the results. The author or an AI can review these criteria; they do not independently grant merge permission.
