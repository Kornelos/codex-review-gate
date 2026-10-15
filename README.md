# Codex Review Gate

Require a clean Codex review stamp on the **current pull request commit** before
merging. A dependency-free Node.js script reads GitHub review evidence and
publishes the `Codex Review` commit status through a dedicated GitHub App.

This is a self-hosted workflow template. Each repository owner creates their
own private App and stores its key in their own protected GitHub environment.
There is no hosted service or shared installation credential.

Independent community project; not an official OpenAI product. A Codex GitHub
review integration is required separately. This project enforces review results;
it does not run an AI model or perform the review itself.

## What passes

Evidence must come from `chatgpt-codex-connector[bot]` **and** GitHub account ID
`199175422`. The gate accepts:

- A clean Codex comment beginning `Codex Review: Didn't find any major issues.`
  and a `Reviewed commit` reference matching the current head. Short references
  must resolve unambiguously through GitHub's API to the full head SHA.
- A Codex `APPROVED` review with the exact current head SHA.
- A completed Code Review row in the latest Codex summary for this head,
  plus a Codex thumbs-up reaction on the PR created at or after completion.

New findings or dismissed reviews invalidate older clean results. A running
current review or a draft PR stays pending. A new commit needs a fresh stamp.
Human approvals, copied comments, bare reactions, and completion alone do not
pass. API errors attempt to publish an error status.

## Install

1. Copy these three files from `template/` into the same paths in the consuming
   repository, preserving any existing `.github` contents:

   ```text
   .github/scripts/codex-review-gate.mjs
   .github/workflows/codex-review-gate.yml
   .github/workflows/codex-review-event.yml
   ```

   Optionally copy `.github/scripts/codex-review-gate.test.mjs` for local tests.
   Keep the bridge workflow's file name, job name, and contents consistent with
   the trusted copy: the publisher compares its exact source before accepting
   a bridge notification. Review changes before copying future versions.

2. Register a **private GitHub App** owned by your account or organization.
   Grant only repository **Commit statuses: Read and write**, plus mandatory
   **Metadata: Read**. Disable webhooks. No OAuth callback or hosted server is
   needed. Install it only on the intended repository. Use a dedicated App,
   rather than sharing a general automation identity.

3. Before adding the key, create the consuming repository's environment named
   `codex-review-gate`. Under **Deployment branches and tags**, select
   **Selected branches and tags**. Allow exactly the actual default **branch**,
   such as `main`, and **zero tags**. Do not use unrestricted access or the
   broader protected-branches setting. If your repository's GitHub plan cannot
   enforce this restriction, stop here. Never move the key into ordinary
   repository or organization secrets as a workaround.

4. In that environment, add:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Variable | `CODEX_REVIEW_GATE_CLIENT_ID` | Your App's client ID |
   | Secret | `CODEX_REVIEW_GATE_PRIVATE_KEY` | Your App's full generated PEM key |

   Keep the key out of source files, logs, artifacts, comments, and chat. Each
   workflow run requests a short-lived token restricted to this repository's
   statuses and revokes it when the job ends.

5. Review and merge the workflow files using your existing merge policy. The
   trusted publisher must execute default-branch code only. Verify a feature
   branch cannot start a job using the protected environment.

6. Run **Codex review gate** manually from the default branch. Leave the optional
   PR number blank to reconcile all open default-branch PRs; supplying a number
   prioritizes that PR and still reconciles the others. Check the PR's actual
   `Codex Review` commit status and its App identity. A green workflow job alone
   is not evidence that a PR passed: a scan with no open PRs also succeeds.

7. In **Settings → Rules → Rulesets**, edit your default-branch rule. Add the exact
   required status **Codex Review** and select **your dedicated App** as its
   expected source. Do not select GitHub Actions or Any source. Preserve existing
   checks, protections, enforcement, and bypass settings.

8. Verify an unstamped PR is blocked, a current clean review passes, and pushing
   another commit blocks the new head until reviewed again. This is an
   administrator setup step; copying the files alone does not enforce merging.

The templates work with a default branch other than `main`; set the environment
branch restriction to that exact branch and update the explanatory workflow
comments. The publisher discovers the repository and default branch from the
GitHub event. Do not put repository names, App IDs, tokens, or keys in the code.

## Everyday use

Enable automatic reviews in your Codex integration, or comment `@codex review` on
the PR. Address findings, push fixes, and request another review as needed.
Resolving a thread does not supply a new stamp.

PR changes and Codex conversation comments trigger reconciliation. A credential-free
review-event bridge wakes the trusted publisher after Codex review submissions,
edits, and dismissals. The publisher reads current API state; it does not execute
PR code or consume bridge outputs or artifacts.

GitHub Actions has no reaction event. The schedule reconciles open PRs every
15 minutes, subject to GitHub scheduling delays. Manually rerun the gate to
refresh sooner after a reaction-only result. Pending queued events can be replaced
by newer ones; every accepted event therefore reconciles all open PRs.

## Security and limitations

- The ordinary workflow token has read permissions. Only the dedicated App token
  writes statuses. Binding the required context to that App prevents a contributor's
  `GITHUB_TOKEN` status from satisfying the requirement under the shared Actions
  identity. Protect trusted default-branch workflow and script changes.
- The App key is available to trusted workflows allowed into the protected
  environment. Repository administrators and people able to change those controls
  remain trusted. See [SECURITY.md](SECURITY.md).
- Commit statuses belong to a SHA rather than a PR. Multiple open default-branch
  PRs with the same head are blocked; give each PR a distinct head commit.
- Status revocations are eventually reconciled. An API outage that also blocks
  writes cannot revoke a previously published success. This is not a synchronous
  merge-time API check or a guarantee that reviewed code is correct.
- The parser relies on observed Codex output formats. Format changes can leave
  a PR pending until the parser is updated. This release supports GitHub.com,
  default-branch PRs, and the documented Codex identity; GitHub Enterprise Server,
  merge queues, and other review providers have not been validated.
- A scan uses `1 + 5N` base API reads for `N` PRs, plus pagination and matching
  short-SHA resolution. Busy repositories can exhaust API quotas. Inspect failed
  workflow runs and retry after access or quotas recover.

## Development

Use Node.js 22 or newer. No dependency installation, credentials, or network
access is needed for the tests:

```sh
npm test
npm run check
```

Tests cover stamp authentication, stale and conflicting evidence, summary/reaction
timing, duplicate heads, pagination, API failures, event reconciliation, and head
changes during a run. The distribution check validates the public file allowlist,
immutable action references, and common credential markers. It supplements manual
review; it is not a general-purpose secret scanner.

## Rollback

Remove only `Codex Review` from required checks **before** disabling/removing the
workflow. Preserve the other CI requirements. If retiring the gate, revoke its
key and uninstall the dedicated App. Keep the environment restriction until its
key is removed.

## License

[MIT](LICENSE).
