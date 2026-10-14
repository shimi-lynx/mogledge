# Documentation

These guides describe current Mogledge behavior. They separate user operations, HTML authoring and application development. Important unverified conditions remain in [known limitations](known-limitations.md).

| Guide                                                 | Purpose                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [User guide](user-guide.md)                           | Open HTML, tabs, search, workspaces, shortcuts and residency                        |
| [First build](first-run.md)                           | Prepare a machine and protect custom local AI instructions                          |
| [Update and rollback](update-guide.md)                | Replace the app while preserving profiles, files and launch entries                 |
| [In-app updates](in-app-updates.md)                   | Manual signed-update flow, safe disabled defaults and activation conditions         |
| [Updater dependency delta](in-app-update-licenses.md) | Exact target/material delta and remaining distribution conditions                   |
| [Mac notice mapping](mac-mit-notice-map.md)           | Reviewed provenance and a proposed notice set, without legal clearance              |
| [0.8.0 source integration](release-0.8.0.md)          | Update PR integration, version rationale and verification limits                    |
| [0.8.1 update interaction](release-0.8.1.md)          | Verified update action, unsaved-input warning and Native verification limits        |
| [0.8.2 saved-data corrections](release-0.8.2.md)      | Counted removal, decimal capacity editing and focused verification                  |
| [Data management](data-management.md)                 | Saved inputs, independent backups and advanced management/transfer tools            |
| [Storage API](document-storage.md)                    | Author HTML that explicitly restores and saves JSON input                           |
| [Artifact export API](html-artifact-export.md)        | Export generated images and text through a user-confirmed save action               |
| [HTML authoring kit](html-authoring-kit.md)           | Optional project-local guide, template and AI skills                                |
| [Architecture](architecture.md)                       | UI, Native, server, search and persistence responsibilities                         |
| [Security](security.md)                               | Trust boundaries, supported paths and restrictions                                  |
| [Identifier migration](identifier-migration.md)       | Startup gate and protection of old and new profiles                                 |
| [Cloud-file QA](onedrive-qa.md)                       | Retained reads, limited writes and provider verification                            |
| [Coding standards](coding-standards.md)               | Naming, types, responsibility and comments                                          |
| [Testing](testing.md)                                 | Targeted checks and browser/Native evidence                                         |
| [PR workflow](pr-workflow.md)                         | Staged work, issue reconciliation and release versioning                            |
| [Distribution candidates](binary-distribution.md)     | Manual candidate gates, platform verification and pending distribution review       |
| [Publication controls](publication-checklist.md)      | Collaborator PR policy and main protections after authorized publication            |
| [License material](license-materials.md)              | Pinned 0.7.2 dependency documents, collection results and unresolved SDK conditions |
| [Wry patch](wry-patch.md)                             | Required Windows initialization-script isolation                                    |

This repository starts with a reviewed source snapshot and a new initial commit. Private development history and historical UI-review artifacts are excluded. See [source preparation](source-preparation.md) for scope and remaining work. Their exclusion does not establish new platform QA or change compatibility.
