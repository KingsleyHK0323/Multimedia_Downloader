# Repository automation

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

This document describes the workflow files in this checkout. A local draft is
not active on GitHub until separately reviewed and published.

## Issue and pull request triage

`issue-pr-triage.yml` initializes only the five documented labels when absent:
`needs-info`, `area:frontend`, `area:engine`, `area:automation`, and
`area:docs`. Existing labels are not modified. If initialization cannot be
confirmed, classification skips. Recognized bug and feature forms with all
expected headings but missing required content may receive `needs-info`.
Bot and automation issues are excluded. Existing issue forms retain their
`bug` and `enhancement` labels.

For non-bot pull requests targeting `Source_Code`, the workflow classifies the
complete paginated file list, including rename source paths, using the area
labels. It rechecks the pull request before adding labels, does not check out or
execute pull request code, and does not remove labels, close issues, merge pull
requests, add `release:patch`, or dispatch releases. A change between the final
read and label update remains possible. Closed issues and stale labels are not
automatically changed; GitHub's native linked-issue behavior is separate.

## Dependabot

The existing `dependabot-auto-merge.yml` remains the sole Dependabot merger.
The draft requires a same-repository Dependabot PR, the expected CI workflow
and successful required jobs, complete paginated file data, matching head at
merge, and verified strict classic branch protection with the expected GitHub
Actions check source. Deletions, renames and changes without a verifiable patch
are excluded. A normal dependency version replacement usually contains deleted
lines and will therefore be skipped; this follows the project deletion gate,
so the draft is not equivalent to unrestricted full automation. It checks that
repository branch deletion on merge is disabled;
settings can still change between that check and the merge. It does not issue a
branch deletion command. Missing permissions, protection evidence or checks cause
a skip. In particular, an inaccessible protection API must not be interpreted
as an enabled policy. The current `Source_Code` branch was observed unprotected,
so the draft cannot currently establish the conditions for an automatic merge.
A merge actor's bypass privileges and all applicable rules must also be checked
before enabling it.

The existing Dependabot workflow still dispatches `auto-patch-release.yml`
after merging a PR carrying `release:patch`; that flow can write `Source_Code`,
create a tag and publish a Release. The new triage workflow does not apply that
label or dispatch a release. These drafts do not remove the existing release
linkage or expand its trigger; review it separately before triggering a release.

`weekly-dependabot-watchdog.yml` reports Dependabot branches without a matching
open PR in the job summary only. Absence of a PR is not evidence that a branch
is safe to remove. It never deletes branches or closes the watchdog issue.
For findings, it preserves existing issue content and adds a deduplicated bot
comment instead of overwriting it. Multiple marker issues cause a safe skip.
CI is considered current only when PR metadata identifies the exact PR and
head; insufficient metadata is reported as unknown.

## Known limits

- General non-bot PR auto-merge is not enabled by these files. GitHub's merge
  head precondition does not atomically lock the base branch. Server-enforced
  strict required checks and a merge identity unable to bypass them are needed.
- Repository auto-delete-on-merge must remain disabled. The workflow's read of
  this setting is not an atomic lock against later administrative changes.
  Branch deletion requires the project's separate two confirmations.
- GitHub event policies, label permissions, branch rulesets and the real CI
  behavior have not been validated by local syntax checks. The branch protection
  API may require Administration: read, which the standard workflow token may
  lack; in that case the merge skips. No admin credential is requested.
- The watchdog reads at most 100 runs in each current-head/branch query; it may
  report unknown when relevant run metadata is absent or outside that window.
- The existing AI roster issue workflow can treat a scan failure as a model
  retirement signal. Triage excludes bot/automation issues and does not assert
  that such a report is a confirmed retirement.
## Current merge hold — 2026-11-14

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

The draft now stops before every merge request. The checks described above are
necessary but do not establish that the merge identity cannot bypass all active
rules or that automatic branch deletion remains disabled at merge time. The
existing release dispatch is unreachable while this hold remains in place.

A future review must establish all active branch rules, strict required checks
bound to the expected GitHub Actions app, and that the actual merge identity
cannot bypass those rules. Confirm `delete_branch_on_merge` remains disabled
and establish a server-side guarantee against changing it during a merge, or
obtain explicit authorization under the project deletion rules. Repository
administration permissions and actual GitHub policy must be verified; a 403,
unknown rule, unknown actor, missing CI evidence or configuration race is not
approval. Settings changes and publication require separate authorization.

The project rule covers deletion of code and data as well as files and branches.
A version replacement changes existing content; the current instruction does
not establish an exception to the required two confirmations. Before relaxing
that gate, obtain an explicit interpretation and the required confirmations.

A dependency-file path allowlist alone does not prove content is safe: manifests
can change scripts or sources and lockfiles can change resolved sources and
integrity data. Any proposed relaxation needs full PR commit provenance and
signature checks, complete data, and strict content-aware review; unavailable or
ambiguous evidence must fail closed. Those checks would narrow risk rather than
prove trust. No general PR auto-merge is enabled.
## Review options and candidate server policy

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

1. Retain the deletion rule: automatically classify and monitor issues and PRs;
   present each dependency update for the two separate confirmations applicable
   to removed or replaced content. Do not automatically merge or delete branches.
2. A bounded exception, only if explicitly approved by the user: define exactly
   which dependency version-value substitutions and mechanically associated
   lockfile updates qualify, which files and ecosystems are allowed, what
   content checks and evidence are mandatory, and how an exception is revoked.
   Keep deletion of files, branches, unrelated values and all ambiguous changes
   under the existing two-confirmation rule. An exception proposal is not itself
   authorization and does not establish that any particular PR is safe.

For either option, a reviewable proposed server configuration is: protect
`Source_Code` with up-to-date branch checks for version-consistency, lint,
python-tests, frontend-check and rust-check, each bound to the expected GitHub
Actions app; disable bypass for administrators and the actual merge identity;
inspect every applicable active ruleset and its bypass actors with sufficient
permissions; keep automatic deletion on merge disabled; and consider a
`dependabot/**` ruleset restricting deletion with no bot bypass. Validate the
actual policies, actor permissions, required check names and deletion behavior
before authorizing publication or a merge. The restrict-deletions interaction
with merge-time deletion has not been tested. The GitHub merge head precondition
does not lock the base or repository settings, so a policy observation alone is
not an atomic guarantee. A successful required status can also include skipped
or neutral results; independently verify the exact CI attempt and conclusions.

References: https://docs.github.com/en/rest/repos/rules ;
https://docs.github.com/en/rest/branches/branch-protection ;
https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request ;
https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
## Additional review details — 2026-11-14

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

The triage draft additionally checks issue-title and PR-label changes before
labeling, recognizes the exact unchecked required form checkbox, and maps
`tests/` and `requirements-web.txt` to engine and `scripts/` to automation.
Missing required headings remain ambiguous and are skipped. A change between
final read and label update remains possible.

The watchdog treats invalid scan creation timestamps and missing current-head
CI evidence as unknown. Its branch inventory distinguishes local PR heads from
same-name fork heads, but the snapshot cannot establish branch ownership or
permission to delete. Existing closed watchdog issues are ignored when choosing
an open issue; findings can create a new open issue, and the first issue body's
unchanged findings do not generate a duplicate first comment. API failures and
concurrent issue changes remain possible. The watchdog Action still uses the
mutable `v7` tag; replacing it requires the applicable approval.

A concrete proposed Source_Code server policy for review is: an active ruleset
requiring a pull request, an up-to-date branch and the five named CI checks
bound individually to the expected GitHub Actions app; restrict deletions and
block force pushes; disable bypass for the actual merge token's app and every
role capable of bypass; and a separate `dependabot/**` deletion restriction.
Record the actual merge token issuer and repository permissions, every active
ruleset and bypass actor, expected app ID and check names, and the repository
branch-delete setting. An omitted bypass list is unknown, not empty. Confirm the
features are available to this repository, test the interaction between branch
restriction and merge-time deletion before relying on it, and do not assume a
merge queue works with the current CI: `merge_group` is not currently configured.
All of this is a proposal, not a remote change, and the merge hold remains.

See https://docs.github.com/en/rest/repos/rules and
https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets.
<!-- OpenAI-Codex_Fork_GitHub_REPO: review qualifications -->

The checkbox check recognizes only the exact single unchecked option; missing
or changed headings or checkbox text remain unknown. Path labels are coarse:
`tests/` and `scripts/` can include files better classified elsewhere. Concurrent
label decisions can still change after the final read. A same-name PR head with
missing repository identity is reported as unknown, not as a fork. Initial
finding deduplication compares issue-body bullet lines and can be affected by
human edits; concurrent runs and issue state changes may still race. Invalid
scan timestamps make ordering unknown. The summary does not establish that all
required CI jobs passed or that their source was trusted.
## Observed recovery and recurrence

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

When exactly one open bot watchdog issue exists and a completed audit finds no
reportable condition, the draft records a marked bot recovery observation as a
comment. It avoids repeating a recovery comment while that is the latest marked
state. If a finding is observed after that recorded recovery, it posts a fresh
finding comment even when its text equals an earlier finding. This is a
point-in-time observation, not proof of complete CI health.

Recovery can occur and recur between schedules, or the API call/job can fail
before its state comment is persisted. Multiple open marker issues prevent
recording recovery. Human changes, closed issues, deleted or edited comments,
and concurrent activity can make state incomplete; in these cases a recurrence
can still be missed. A branch-inventory API failure can stop the job before the
summary is written. This is not a guaranteed alerting system.

Form heading or checkbox variations are skipped because their origin is
ambiguous. Mapping all `tests/` files to engine is coarse. Both behavior and
actual GitHub API permissions remain unverified in a live workflow.
## AI roster status handling — local draft

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

The roster script's command-line entry point maps a successfully observed
substitution to exit 3, an inconclusive result or caught exception to exit 2,
and no observed substitution to exit 0. Legacy stdout wording is suppressed;
a difference from the selected candidate does not prove vendor retirement.
Python startup or parse errors may exit 1; the workflow fails before the legacy
retirement-issue step. Unknown exit values, report capture failure and status
output failure also fail the job. A successful exit 3 requests a fixed-text,
bot-owned issue with an exact marker, without including catalogue strings.
Runs share a concurrency group; this does not guarantee that all scheduled or
manual requests execute or prevent changes outside that group. Exact marker and
same-title ambiguity cause a safe skip. Existing unmarked issues are untouched.

The earlier documented retirement interpretation is superseded for this local
draft; the original legacy code and its misleading text remain in the files but
are bypassed in the intended command-line and workflow paths. CLI consumers that
expect exit 1 for a substitution will see exit 3. Python execution, YAML and
GitHub Actions behavior have not been validated here; the relevant conditions
must be tested before publication.

The PR classifier skips a renamed file when its previous path is unavailable;
the watchdog flags scan timestamps more than five minutes in the future as
unknown. API data, wall-clock skew and state changes remain unverified.
<!-- OpenAI-Codex_Fork_GitHub_REPO: remaining legacy summary -->

The existing workflow's exit-0 step still says all four defaults are live. That
line is retained and can overstate the evidence: exit 0 only means no default
substitution was observed in the verified catalogue result. It must be corrected
in a separately authorized change before treating the workflow as publication
ready. The pre-existing shell output assignment is followed by a corrected
same-name assignment; the intended last-value behavior requires real Actions
validation, as do the implicit success conditions on downstream steps.
## AI roster follow-up — local draft

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

The CLI now uses exit 5 for caught execution exceptions and unexpected main()
return values; exit 2 is reserved for a normally inconclusive catalogue result.
The workflow's unknown-status guard should fail for exit 5. Startup/parse errors
may exit 1 and are also guarded. This supersedes the earlier statement that a
caught exception uses exit 2. Importing the module and calling legacy `main()`
still has its prior 0/1/2 contract; the CLI wrapper has 0/2/3/5. A substitution
does not establish retirement. External callers and dynamically built commands
were not exhaustively discoverable.

The retained first status output is preceded by a subshell intended to restore
the captured process result; the following checked output writes that same
result. This removes the intended differing-value duplicate, but actual shell
and Actions output processing remain untested. Failure to write either output
or capture stdout should fail the step.

The existing exit-0 step can still print that all defaults are live and must not
be used as evidence of that claim. An additive alternative would disable the
existing job and add a replacement job with neutral output, but skipped jobs can
appear successful and job-name/check dependencies must be assessed. No such
replacement is enabled in this draft; separately review and test it or obtain
approval to amend the old condition. This remains a publication blocker.
## Exit-4 proposal assessment

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

Mapping normal CLI success from 0 to 4 does not work with the current draft:
the existing unknown-status guard fails for 4 before a neutral success step
could run. An arbitrary process failure can also return 4, so the code alone is
not reliable success evidence. Changing CLI success to nonzero additionally
breaks conventional shell success checks and may affect unknown external users.

A possible future design would retain CLI success 0 and have the workflow map
a verified completion record to a separate internal state. A per-run nonce,
strict unique record, captured process status and checked output writes could
reduce accidental collisions, but cannot defend against a modified trusted
script and require integration testing. The existing unknown-status guard still
needs an authorized change or a separately reviewed replacement job. No such
change is implemented; the old misleading exit-0 message remains a blocker.
## Roster completion evidence — local draft

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

For the workflow only, the runner supplies a formatted per-run completion
identifier. The CLI emits one matching identifier and classified status only
after its main function returns a recognized normal result. The workflow
requires one matching record, the captured Python status, a successful tee,
and successful status-output writes. Missing, duplicate or mismatched evidence
fails the step; this narrows accidental collisions such as a Python startup
failure returning 2. The identifier uses Bash RANDOM and is not an authentication
secret: a modified trusted script can forge it. Real shell, Python, Actions and
API behavior remain untested. The retained two status output lines are intended
to contain the same status, but have not been validated by GitHub Actions.

Before creating a candidate-substitution issue, an open bot-owned issue with
the exact legacy retirement title causes a warning and a safe skip for human
review. The legacy title is not evidence of retirement. The old exit-0 claim
still exists and remains a publication blocker. Direct import and invocation of
legacy `main()` retain old status codes and potentially misleading output;
only the CLI wrapper has the newer contract and neutral messages.
## Automation draft status — latest review

<!-- OpenAI-Codex_Fork_GitHub_REPO -->

The status-0 workflow message was changed with separate user confirmation to
“No default-model substitutions were observed in this check.” Earlier notes
claiming that the old status-0 text remains are historical and superseded. A
no-substitution result still does not prove that a default model is available.

`resolve_roster()` catches exceptions raised while fetching or filtering the
catalogue and returns `verified=False`. Exit 2 can therefore represent a
programming error inside that handling as well as an unavailable catalogue;
the wrapper cannot distinguish them. The imported `main()` still exposes its
legacy status and output, unlike the CLI. The two intended equal status writes
and real Actions conditions have not been verified in Bash or on GitHub. These
limits remain unresolved and the draft is not integration validated.

PR classification skips duplicate filenames in the returned changed-file
inventory. The watchdog reports the CI result as unknown when a head or branch
query is truncated, when its total count is unavailable, or when a candidate
run timestamp is invalid or over five minutes in the future. These are
conservative checks: concurrent API changes and GitHub search limits still
prevent a complete or atomic proof.