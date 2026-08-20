# Spec: repository and pull-request authority

## Goal

Allow approved project agents to branch, edit, test, create PRs, review, and
merge without GitHub tokens or direct default-branch write access.

## Repository profile

An approved provisioning contract may attach:

```text
repository_id, source_mount_mode[read-only|workspace], branch_prefix,
head_prefix, allowed_actions, merge_policy[disabled|parent-review|automated-checks]
```

The host repository broker verifies every operation against an effective,
attenuated repository grant. GitHub App credentials and owner tokens never
enter containers.

## Workflow

- A coding child gets bounded branch/workspace scope and may create a PR.
- Its parent dispatches test/review children with read-only source and PR data.
- A parent with `pr-merge` and a satisfied policy may merge.
- GitHub rulesets and required checks remain independently enforced.

## Goal-mode implementation boundary

Build on the existing host-side repository broker and GitHub App broker; do
not mount a GitHub token, private key, `.git` credential helper, or broad host
checkout into a child. Repository work is authorized by exact repository ID,
branch/head prefix, action, and live ancestor relation.

`automated-checks` means the host reads configured GitHub check conclusions and
branch-protection state through the broker before merge. It never treats an
agent assertion as a passing check. `parent-review` requires an authenticated
parent broker operation; it is not a Discord text signal.

## Required verification

- Coding child can branch/write/PR inside its prefix but cannot target another
  repository or default branch.
- Read-only test child cannot call write/PR/merge operations.
- Merge denies missing grants, failed checks, protected-branch violations, and
  cross-project pull requests.

## Acceptance criteria

- A child cannot write outside its repository/branch prefix.
- A reviewer cannot mutate source unless its profile says so.
- PR creation/merge are auditable and credential-free.
