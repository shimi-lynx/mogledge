# Contributing

Read [AGENTS.md](AGENTS.md), any existing untracked `AGENTS.local.md`, and the [coding standards](docs/coding-standards.md) before changing the project. User instructions take precedence. Keep machine-specific development or HTML design instructions in the local file; never replace another machine's custom instructions during an update.

Start from current main and inspect related merged changes before implementing an issue. An open issue can describe remaining QA rather than missing implementation. Use an isolated branch when other work is in progress.

- [First build](docs/first-run.md): prerequisites and local instruction preservation.
- [Architecture](docs/architecture.md) and [security](docs/security.md): existing responsibility and trust boundaries.
- [Testing](docs/testing.md): select checks for the change and distinguish mock, browser and Native results.
- [PR workflow](docs/pr-workflow.md): acceptance criteria, versioning and permitted merge scope.
- [HTML authoring](.agents/skills/my-knowledge-html/SKILL.md): canonical storage and export adapters.

Use English for public documentation, comments added to templates and PR/issue descriptions. Preserve Japanese UI resources, Japanese help, test inputs and user content. Do not translate technical identifiers, filenames supplied by users, or upstream copyright and license text.

Keep private paths, real email addresses, credentials, session identifiers and unnecessary local work logs out of tracked files and GitHub descriptions. Publish only the evidence needed to assess the change. Report important unverified conditions explicitly.
