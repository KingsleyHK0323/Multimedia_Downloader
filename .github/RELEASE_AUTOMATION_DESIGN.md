# Protected release automation design

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

Status: review proposal only. No workflow, token, ruleset or remote setting is
changed by this document. Full automation is not enabled.

## Current conflict

`auto-patch-release.yml` currently generates a version commit and pushes it
straight to `Source_Code` using `GITHUB_TOKEN`. An active ruleset requiring a
pull request with an empty bypass list would reject that push. The normal new
release path would stop before its tag and reusable release workflow. A retry
for an already existing version commit and a release invoked for an existing
tag are distinct paths and must be reviewed separately.

## Proposed phases

1. On a verified merged `release:patch` pull request, create a deterministic
   release intent bound to repository, original PR number and merged commit.
   Refuse an unmerged PR, wrong base, missing metadata, ambiguous prior release,
   duplicate marker or unexpected version. Do not accept PR text as shell code.
2. Generate a version-only candidate from the current protected base in a new
   release branch. Verify the exact allowed version/changelog file changes,
   consistency, clean candidate and expected parent. Do not delete the branch.
   Keep source code, workflow, permissions, unrelated metadata and release
   labels outside the version change fail closed unless separately approved.
3. Create a uniquely identifiable release PR targeting `Source_Code`. It must
   never carry `release:patch`, so its own merge does not recursively request
   another release. Verify author, head SHA, base, marker and complete diff.
   Conflicting or duplicate PRs stop for human review; no existing PR is edited,
   closed or replaced automatically.
4. Enforce the server-side ruleset: PR required; branch up to date; the five
   expected checks bound to GitHub Actions; no bypass for merge identity; block
   force pushes and deletion. Independently require all five actual jobs to
   conclude success for the exact relevant run and attempt, since required
   checks may accept skipped or neutral conclusions. If the base advances,
   regenerate or update only through an authorized, non-destructive procedure
   and obtain fresh checks; ambiguity stops the process.
5. Only after verifying the release PR merged into the expected base and that
   the tagged commit is the actual merged version commit, create the version
   tag without replacing an existing tag and invoke the existing release build.
   A pre-existing tag or release must be checked against the exact commit and
   assets; conflicts stop rather than overwrite. No branch or tag deletion.

## Identity and trust requirements

A GitHub App installation token may be needed for the release branch and PR:
workflows triggered by PRs created or updated by `GITHUB_TOKEN` can require
human approval. This is a candidate, not an instruction to create credentials.
Before using any app, verify its issuer, installation, precise repository
scope, short lifetime, least required contents/PR permissions, auditability and
ability to trigger checks. Its merge identity must not bypass any applicable
rule. Creating or expanding credentials or access needs its own authorization.
Do not place tokens in source, logs, comments or chat.

The app's ability to create a PR is separate from authorization to merge it.
The user's bounded dependency-update exception does not authorize arbitrary
version-bump changes, workflow changes, removal of files or branches, or changes
to unknown content. Any code/data deletion confirmation required by project
rules remains separate. Existing `release:patch` behavior must not be widened.

## Evidence required before enabling

- Compare all applicable active rulesets and bypass actors with an account that
  can actually read them; missing access is unknown. Verify required-check app
  provenance and the merge token's real identity and non-bypass status.
- Resolve the non-atomic race between the repository auto-delete setting and
  merge, including a separately tested branch-deletion restriction. A ruleset
  targeting `Source_Code` does not protect `dependabot/**` or `release/**`.
- Verify the precise five checks, base/head changes, PR limits, duplicate and
  retry behavior, tag conflicts, release loops, GitHub App token permissions,
  workflow-trigger approval behavior and existing release migration in a safe
  separately authorized environment. No local runner/workflow is permitted.
- Distinguish tests with mocked API data from real server enforcement and
  release acceptance. A passing CI run does not establish upstream package
  safety or prove a complete release occurred.

## References

- https://docs.github.com/en/actions/concepts/security/github_token
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
## Implemented preflight draft

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

`protected-release-draft.yml` is a separate local `workflow_dispatch` draft.
It uses read-only contents and pull-request permissions, verifies the original
merged `release:patch` PR and source branch, checks commit ancestry, detects
existing release branch/PR candidates, and rechecks the base and original PR.
It performs no checkout, candidate generation, branch/PR creation, merge, tag
or release. Even after successful preflight it intentionally fails closed.
It is not a replacement for the existing release workflow and is not published.

An in-memory mock exercises selected control-flow branches; it does not verify
actual GitHub pagination, API permissions, Actions event behavior or atomicity.
A concurrent change can occur after the final read. Creating a version update
requires separately authorized content replacements; the dependency update
exception does not cover the application version or changelog.

GitHub documents `pull-requests: write` for PR creation and `contents: write`
for refs and merges. A read of protected-branch administration details may need
`administration: read`. Do not grant bypass to a release or merge identity.
`GITHUB_TOKEN` PR creation/update can require human approval for resulting PR
workflows; an App installation token is a candidate to investigate, not an
already-approved integration or a guarantee. A new reference must not overwrite
an existing tag; a 409/422 needs explicit investigation rather than blind retry.

Additional references:

- https://docs.github.com/en/rest/pulls/pulls
- https://docs.github.com/en/rest/git/refs
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
- https://docs.github.com/en/rest/repos/rules
## Additional local safeguards

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

The preflight rechecks the source PR's base repository and warns that legacy
release commits, tags and releases have not been checked. Absence of the new
marker does not establish that a prior release does not exist.

`protected-release-version-policy.mjs` is an unconnected, non-authorizing text
classifier for a single exact patch increment in four supported paths only:
README heading, engine version, Cargo package version, and the named Cargo.lock
package version. It rejects ambiguous multiline strings and unsupported contexts.
It intentionally does not cover JSON files, CHANGELOG, a complete ten-file
release, original byte encoding, semantic parser correctness, provenance,
permissions or server enforcement. A positive result explicitly reports
`completeRelease: false` and `mergeAuthorized: false`. It does not create or
approve any replacement, PR, tag or release.
<!-- OpenAI-Codex_Fork_GitHub_REPO: classifier limits -->

The local text classifier additionally rejects alternate line separators,
ambiguous multiline strings, a README heading outside the first line, and
selected duplicate or misplaced version declarations. These checks are
conservative heuristics, not full Python, TOML, Markdown or byte parsers. Some
legitimate files may be rejected; an accepted text match remains non-authorizing.
The watchdog's scan inventory completeness check is documented separately in
`AUTOMATION.md`; neither local update is present in PR #44.

<!-- OpenAI-Codex_Fork_GitHub_REPO: compare consistency -->

The draft preflight rejects missing or contradictory ancestry comparison metadata and remains read-only and unconditionally stopped. This does not lock the base or establish release safety.
