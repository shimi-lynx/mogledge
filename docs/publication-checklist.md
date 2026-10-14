# Repository publication controls

Repository publication, application signing, release publication and installer installation require their own explicit authorization. Preparation or a draft PR does not authorize them. Follow [binary distribution](binary-distribution.md) and [in-app updates](in-app-updates.md) for the separate product gates.

The current repository remains private. Its Issues and pull-request features are enabled, and `pull_request_creation_policy` is `collaborators_only`. Retain this policy so public users can report issues while authorized collaborators can create PRs. Do not grant additional collaborators or disable all PRs as part of publication.

After an authorized visibility change, read back the repository visibility and these controls. Then activate a branch ruleset targeting exactly `refs/heads/main`:

- Require a pull request before merging, with zero required approvals. The sole owner must be able to merge their own PR.
- Leave the bypass list empty, including administrators and GitHub Apps.
- Restrict branch deletion and block force pushes.
- Leave code-owner approval and approval of the latest push disabled.
- Do not enable Restrict updates, or require a check that the current manual-only workflows cannot produce on a PR.

Read back the active ruleset, target, approval count and empty bypass list. Keep the PR requirement active for owner and authorized automation work; use a branch and PR for subsequent changes. Do not test the policy by making destructive pushes or deleting main.

These settings use [GitHub's branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) and [ruleset creation procedure](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository). They are a prepared publication step, not a claim that main protection is already active.
