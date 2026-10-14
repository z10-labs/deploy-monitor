# deploy-monitor

A Claude Code plugin that watches your production deploys. After every merge it probes the live service, and when something is wrong it works out which PR did it, who worked on it (humans and agents), posts the diagnosis on that PR, opens an assigned issue with a hand-off prompt, and, only when the cause is small and certain, opens a draft fix PR. It never merges, never touches platform settings, and never prints a secret.

This repository is also the Z10 Labs plugin marketplace.

## Install

```bash
claude plugin marketplace add z10-labs/deploy-monitor
claude plugin install deploy-monitor@z10-labs
```

Then, inside a Claude Code session in the repository you want monitored:

```text
/deploy-monitor init      # reads the repo and drafts .claude/deploy-monitor.json
/deploy-monitor create    # creates the cloud routine, the merge trigger, and runs it once
```

`/deploy-monitor status`, `run`, `render`, `trigger` and `actions` are the other subcommands. See [SKILL.md](plugins/deploy-monitor/skills/deploy-monitor/SKILL.md).

## How it works

The monitor is a **prompt rendered from a config**. The procedure is generic and lives in [routine-prompt.md](plugins/deploy-monitor/templates/routine-prompt.md). Everything about your service lives in `.claude/deploy-monitor.json`, validated against [the schema](plugins/deploy-monitor/schema/deploy-monitor.schema.json):

| Config section | What it controls |
| :- | :- |
| `targets[]` | Each deployed service: primary URL, informational secondary URLs, probes with expected statuses, a local boot-repro command |
| `platform` | `vercel`, `fly`, `aws-lambda` or `generic`: which headers mean a crash, which CLI reads build and runtime logs, which token env var to look for |
| `build`, `ci`, `contract` | How to build and test locally, which workflow must be green, which committed API contract to diff |
| `knownFailureModes`, `runbookLinks`, `repoRules` | Repo memory the classifier checks first, where fixes point, rules from your `CLAUDE.md` |
| `notifications[]` | Chat channels: Discord, Slack, Teams or a generic webhook, each with its own events and the env var holding its webhook URL |
| `escalation` | Assignees, labels, whether to mention the author, push a mobile notification, or post a success comment |
| `fixPr` | The draft-PR gate: max files and lines, forbidden paths, branch prefix, required PR body sections, co-author trailer |
| `routine` | Model, daily cron (UTC), cloud environment, allowed tools, which connectors to keep |

The rendered prompt runs as a **Claude Code cloud routine** with two triggers: a GitHub trigger on merged pull requests and a daily sweep. A run ends with a fixed report block, so run logs are comparable.

### What a run does

1. Finds the deployed commit (`origin/<default branch>` HEAD) and the previous one.
2. Probes every target. Secondary URLs such as a not-yet-attached custom domain are informational.
3. Checks CI on the default branch and diffs the API contract.
4. On failure: finds the PR, the author and any Claude co-author trailers, classifies the failure (`build-failed`, `boot-failed`, `route-500`, `ci-red`, `contract-drift`), reads platform logs if a token is present (names only), and reproduces boot failures locally.
5. Raises it: one marked comment on the PR, one issue per fingerprint, a push notification, and a draft fix PR only inside the `fixPr` gate.

### Portability notes

- **Routines are personal.** A routine runs on the account of whoever creates it and acts under their GitHub identity. Each team member who wants their own copy runs `/deploy-monitor create`; the config in the repo is the shared part.
- **The GitHub trigger filter is not settable through the API yet.** The trigger fires on `pull_request.closed`; set "base branch = main, merged = true" in the routine's web UI. The prompt is idempotent, so a stray fire costs a run, not a duplicate comment.
- **Sandbox GitHub access** is a GitHub App token: some REST endpoints (deployments) answer 403, so the prompt falls back to the GitHub MCP tools. In GitHub Actions the token is complete.
- **Platform logs** need a token in the cloud environment (`VERCEL_TOKEN`, `FLY_API_TOKEN`, AWS credentials). Without one the routine still works but reports causes as "likely" rather than "certain".

## Notifications: Discord, Slack, Teams, anything with a webhook

Every run reports to GitHub (a marked comment on the PR, an issue per fingerprint). Chat channels are added in the config and all work the same way: an incoming-webhook URL, read from an environment variable at run time, posted to with `curl`. The URL is the secret, so it never appears in the config, the prompt, or a comment.

```json
"notifications": [
  { "type": "discord", "events": ["fail", "regression"], "mentions": ["<@&ROLE_ID>"], "label": "#deploys" },
  { "type": "slack",   "events": ["ok", "fail", "regression"] },
  { "type": "teams",   "urlEnv": "OPS_TEAMS_URL" },
  { "type": "webhook", "events": ["fail"] }
]
```

| Type | Default env var | Payload |
| :- | :- | :- |
| `discord` | `DISCORD_WEBHOOK_URL` | `content` with mentions plus one embed (title, summary, service, target, commit, classification, links); red, green or amber colour by event |
| `slack` | `SLACK_WEBHOOK_URL` | Block Kit: header, summary, four fields, a context line with links |
| `teams` | `TEAMS_WEBHOOK_URL` | Adaptive Card 1.4 with a FactSet and Open-issue / Open-run actions (Workflows-style incoming webhook) |
| `webhook` | `NOTIFY_WEBHOOK_URL` | A flat JSON event: `event`, `service`, `target`, `sha`, `verdict`, `classification`, `confidence`, `rootCause`, `prUrl`, `issueUrl`, `fixPrUrl`, `runUrl`, `mentions`. Point n8n, PagerDuty, Opsgenie or your own service at it |

`events` picks what each channel hears: `fail` (a failed deploy), `regression` (a previously verified deploy now failing with no new commit), `ok` (a verified merge). Default is `fail` and `regression`. An unset variable is reported as "notification skipped", never an error, so a config can list channels before every environment has the secret.

Where to put the URL:

- **Cloud routine**: the environment's variables at [claude.ai/code/environments](https://claude.ai/code/environments) (or a network secret on Pro and Max). Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL.
- **GitHub Actions**: a repository secret with the same name; the workflow template already passes the four defaults through.

Mentions use the platform's own syntax (`<@&ROLE_ID>` for a Discord role, `<@U0123>` for a Slack user). Adding a new chat platform is one `case` in `notificationPayload` in `scripts/render.mjs`, one enum value in the schema, and one test.

## GitHub Actions variant

`/deploy-monitor actions` installs [deploy-monitor.yml](plugins/deploy-monitor/templates/deploy-monitor.yml), which runs the same rendered prompt through the Claude Code GitHub Action on the platform's `deployment_status` event, a daily schedule, and manual dispatch. Use it when your team does not use claude.ai routines, or when you want the trigger to be the actual deployment rather than the merge.

## Example

[examples/acme-api.json](examples/acme-api.json) is a worked example: a Node.js monorepo deploying two Vercel projects, with a boot-time env check as the known failure mode and strict PR body requirements from its `CLAUDE.md`. Render it with:

```bash
node plugins/deploy-monitor/scripts/render.mjs render examples/acme-api.json
```

## Development

```bash
npm test                   # node:test suite for the renderer, validator and API bodies
npm run validate           # claude plugin validate on the marketplace and the plugin
npm run render:example
```

The renderer is dependency-free Node 20+. Platform profiles live in `scripts/render.mjs`; add one there, add a `platform` enum value to the schema, and add a test that renders it.

## License

MIT
