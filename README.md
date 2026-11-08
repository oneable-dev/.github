# oneable-dev/.github

Organization-wide reusable GitHub Actions workflows.

## Claude Review

`.github/workflows/claude-review.yml` reviews pull requests with
[Claude Code](https://github.com/anthropics/claude-code-action) and posts inline
comments plus one summary comment, all in English. It focuses on bugs, security
problems, and regressions, and follows the target repository's `CLAUDE.md` and
`AGENTS.md`.

Behavior:

- Runs on `opened`, `reopened`, `ready_for_review`, and `synchronize`.
- `opened`, `reopened`, `ready_for_review`: reviews the whole PR diff.
- `synchronize`: reviews only the changes since the last completed review (see
  "Incremental reviews"). If there is no usable previous review, for example after a
  force-push or rebase, it falls back to the whole PR diff.
- Skips draft PRs, fork PRs (no secrets), and any event other than `pull_request`.
  Bot-authored PRs and bot pushes are reviewed too.
- Authenticates with a Claude subscription OAuth token. No Claude GitHub App is
  required: the workflow passes `github.token` to the action, which skips the OIDC
  app-token exchange, so `id-token` permission is not needed.
- One review per PR at a time; a newer push cancels a review still in progress.

### Incremental reviews

Each review ends with a summary comment whose last line is a marker,
`<!-- claude-review:head=<40-hex sha> -->`, recording the PR head that was reviewed.
On `synchronize`, the workflow reads the newest such marker from comments posted by
`github-actions[bot]` and reviews `git diff <marker sha> <new head>`, ignoring hunks
that came only from merging the base branch.

- A run that is cancelled by a newer push, times out, or hits `max_turns` posts no
  marker, so its changes are included in the next run's review.
- The review is a full one when there is no marker, the marked commit is gone or is not
  an ancestor of the new head (force-push or rebase), or the marker equals the current
  head (a re-run of the same commit).
- If the model omits the marker, the next run safely falls back to a full review (or to
  the previous marker, which only widens the range). Do not delete or edit the bot's
  summary comments if you want incremental reviews to continue.
- If `gh pr diff` fails on a very large PR, the review uses `git diff base...head`.

### Caller template

Add `.github/workflows/claude-review.yml` to each repository:

```yaml
name: Claude Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    uses: oneable-dev/.github/.github/workflows/claude-review.yml@main
    permissions:
      contents: read
      pull-requests: write
      issues: write
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Optionally pass inputs with `with:` under `uses:`.

### Inputs

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `""` | Value for `--model`. Empty uses the Claude Code default. |
| `max_turns` | number | `30` | Value for `--max-turns`. |
| `timeout_minutes` | number | `15` | Job timeout in minutes. |
| `extra_prompt` | string | `""` | Extra repository-specific review instructions appended to the prompt. |
| `allowed_bots` | string | `"*"` | Bot actors allowed to trigger a review. The action rejects bot actors (for example Dependabot pushes) unless listed. |

### Secrets

| Secret | Required | Description |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | OAuth token from `claude setup-token`. Must be passed explicitly by the caller. |

### Register the secret

1. Run `claude setup-token` in your own terminal and sign in. Copy the token it prints.
2. Register it per repository. `gh` prompts for the value, so paste it yourself:

   ```sh
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo oneable-dev/<repo>
   ```

Never commit the token or paste it into a workflow file, issue, or chat.

Dependabot-triggered runs read secrets from the repository's Dependabot secrets,
not Actions secrets. Add the same secret there (`gh secret set ... --app dependabot`)
if you want Dependabot PRs reviewed.

### Turn it off or roll back

- Disable one repository's review:

  ```sh
  gh workflow disable "Claude Review" -R oneable-dev/<repo>
  ```

- Remove it permanently: delete the caller `.github/workflows/claude-review.yml`
  in that repository.
- Roll back for every repository: revert the change in this repository's `main`
  branch. Callers use `@main`, so the revert takes effect on the next run.
- Revoke access: delete the `CLAUDE_CODE_OAUTH_TOKEN` secret and revoke the token
  in your Claude account.

### Notes

- This repository must be public (or have Actions sharing enabled) for private
  repositories in the organization to call the workflow.
- Checkout uses full history so the incremental diff can be computed.
- Re-running a job with "Enable debug logging" (`ACTIONS_STEP_DEBUG`) can expose full
  logs, including the prompt and model output. Avoid it on repositories where that matters.
- `allowed_bots` defaults to `*`, so Dependabot, Renovate, and other bots can trigger
  reviews. Their PR title and body become part of the prompt and are a prompt-injection
  surface; the allowed tools are limited to read-only `git`/`gh` commands and PR comments,
  but to reduce risk set an explicit list instead, for example
  `with: { allowed_bots: "dependabot[bot],renovate[bot]" }`, or an empty value to
  reject all bot actors.
