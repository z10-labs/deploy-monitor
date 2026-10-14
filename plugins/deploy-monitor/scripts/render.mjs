#!/usr/bin/env node
/**
 * deploy-monitor renderer.
 *
 * Turns a per-repo `.claude/deploy-monitor.json` into:
 *   - the routine prompt (markdown)                       render <config>
 *   - the routines-API create body                       routine-body <config> [--environment env_id] [--prompt file]
 *   - the GitHub webhook-trigger create body             trigger-body <config> --routine trig_id
 *   - a validation report                                validate <config>
 *
 * No dependencies. Node 20+. Deterministic apart from the uuid in routine-body.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.join(HERE, '..', 'templates', 'routine-prompt.md');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
  defaultBranch: 'main',
  platform: 'generic',
  deploy: Object.freeze({ waitMinutesAfterMerge: 4, retryMinutes: 3 }),
  ci: Object.freeze({ workflow: 'CI' }),
  escalation: Object.freeze({
    assignees: Object.freeze([]),
    labels: Object.freeze(['deploy-monitor', 'bug']),
    mentionAuthor: true,
    pushNotification: true,
    successComment: true,
  }),
  fixPr: Object.freeze({
    enabled: true,
    maxFiles: 3,
    maxLines: 60,
    forbiddenPaths: Object.freeze([]),
    branchPrefix: 'claude/deploy-monitor',
    bodySections: Object.freeze([]),
    footer: '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  }),
  routine: Object.freeze({
    model: 'claude-sonnet-5-5',
    cron: '0 5 * * *',
    allowedTools: Object.freeze(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']),
    connectors: Object.freeze([]),
  }),
});

const PLATFORMS = ['vercel', 'fly', 'aws-lambda', 'generic'];
const METHODS = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE'];
const TOP_LEVEL_KEYS = new Set([
  '$schema', 'name', 'description', 'repository', 'defaultBranch', 'platform', 'platformScope',
  'deployModel', 'deploy', 'targets', 'build', 'ci', 'contract', 'repoRules', 'knownFailureModes',
  'runbookLinks', 'notifications', 'escalation', 'fixPr', 'routine',
]);

const NOTIFICATION_TYPES = Object.freeze({
  discord: { label: 'Discord', urlEnv: 'DISCORD_WEBHOOK_URL' },
  slack: { label: 'Slack', urlEnv: 'SLACK_WEBHOOK_URL' },
  teams: { label: 'Microsoft Teams', urlEnv: 'TEAMS_WEBHOOK_URL' },
  webhook: { label: 'Generic webhook', urlEnv: 'NOTIFY_WEBHOOK_URL' },
});
const NOTIFY_EVENTS = ['ok', 'fail', 'regression'];
const DEFAULT_NOTIFY_EVENTS = Object.freeze(['fail', 'regression']);

// ---------------------------------------------------------------------------
// Validation (mirrors schema/deploy-monitor.schema.json for the parts that matter)
// ---------------------------------------------------------------------------

export function validateConfig(cfg) {
  const errors = [];
  const push = (m) => errors.push(m);
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['config must be a JSON object'];

  for (const key of Object.keys(cfg)) if (!TOP_LEVEL_KEYS.has(key)) push(`unknown top-level key "${key}"`);
  if (typeof cfg.name !== 'string' || cfg.name.trim() === '') push('"name" is required');
  if (typeof cfg.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repository)) push('"repository" must be owner/repo');
  if (cfg.platform !== undefined && !PLATFORMS.includes(cfg.platform)) push(`"platform" must be one of ${PLATFORMS.join(', ')}`);
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) push('"targets" must be a non-empty array');
  else cfg.targets.forEach((t, i) => {
    const at = `targets[${i}]`;
    if (typeof t.name !== 'string' || t.name === '') push(`${at}.name is required`);
    if (typeof t.url !== 'string' || !/^https?:\/\//.test(t.url)) push(`${at}.url must be an http(s) URL`);
    if (!Array.isArray(t.probes) || t.probes.length === 0) push(`${at}.probes must be a non-empty array`);
    else t.probes.forEach((p, j) => {
      const pt = `${at}.probes[${j}]`;
      if (typeof p.path !== 'string' || !p.path.startsWith('/')) push(`${pt}.path must start with /`);
      if (!Array.isArray(p.expect) || p.expect.length === 0 || !p.expect.every((c) => Number.isInteger(c) && c >= 100 && c <= 599)) push(`${pt}.expect must be a non-empty array of HTTP status codes`);
      if (p.method !== undefined && !METHODS.includes(p.method)) push(`${pt}.method must be one of ${METHODS.join(', ')}`);
    });
  });
  if (cfg.contract !== undefined && (typeof cfg.contract !== 'object' || typeof cfg.contract.path !== 'string')) push('"contract.path" is required when "contract" is set');
  if (cfg.notifications !== undefined) {
    if (!Array.isArray(cfg.notifications)) push('"notifications" must be an array');
    else cfg.notifications.forEach((n, i) => {
      const at = `notifications[${i}]`;
      if (!NOTIFICATION_TYPES[n?.type]) push(`${at}.type must be one of ${Object.keys(NOTIFICATION_TYPES).join(', ')}`);
      if (n?.urlEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(n.urlEnv)) push(`${at}.urlEnv must be an environment variable name (UPPER_SNAKE_CASE)`);
      if (n?.events !== undefined && (!Array.isArray(n.events) || n.events.length === 0 || !n.events.every((e) => NOTIFY_EVENTS.includes(e)))) push(`${at}.events must be a non-empty subset of ${NOTIFY_EVENTS.join(', ')}`);
      if (n?.mentions !== undefined && (!Array.isArray(n.mentions) || !n.mentions.every((m) => typeof m === 'string'))) push(`${at}.mentions must be an array of strings`);
    });
  }
  if (cfg.fixPr?.maxFiles !== undefined && !(Number.isInteger(cfg.fixPr.maxFiles) && cfg.fixPr.maxFiles >= 1)) push('"fixPr.maxFiles" must be a positive integer');
  if (cfg.fixPr?.maxLines !== undefined && !(Number.isInteger(cfg.fixPr.maxLines) && cfg.fixPr.maxLines >= 1)) push('"fixPr.maxLines" must be a positive integer');
  if (cfg.routine?.cron !== undefined && cfg.routine.cron.trim().split(/\s+/).length !== 5) push('"routine.cron" must be a 5-field cron expression');
  return errors;
}

// ---------------------------------------------------------------------------
// Platform profiles: what a crash looks like and how to read logs (names only)
// ---------------------------------------------------------------------------

function platformProfile(cfg) {
  const scope = cfg.platformScope ?? {};
  switch (cfg.platform) {
    case 'vercel': {
      const scopeFlag = scope.teamId ? ` --scope ${scope.teamId}` : '';
      return {
        deployModel: `every push to \`${cfg.defaultBranch}\` becomes a production deployment through the Vercel GitHub integration.`,
        deployMetadata: [
          'Deployment metadata, best effort: try `gh api \'repos/' + cfg.repository + '/deployments?per_page=10\'` and `gh api repos/' + cfg.repository + '/deployments/<id>/statuses` for `state`, `environment_url`, `created_at`; also `gh api repos/' + cfg.repository + '/commits/<sha>/status` (Vercel posts one commit status per project with a `target_url`). If these 403, say so and rely on the probes below.',
        ].join('\n'),
        headers: 'Always capture the `x-vercel-error` and `x-vercel-id` response headers on every probe.',
        bootSignature: ' with HTTP 500 and `x-vercel-error: FUNCTION_INVOCATION_FAILED` (the function never finished booting)',
        evidence: [
          `   - If \`VERCEL_TOKEN\` is set in your environment: \`npx -y vercel@latest inspect <url> --logs --token "$VERCEL_TOKEN"${scopeFlag}\` for the build log, \`timeout 40 npx -y vercel@latest logs <url> --token "$VERCEL_TOKEN"${scopeFlag} --json | head -c 6000\` for runtime logs, and \`npx -y vercel@latest env ls production --token "$VERCEL_TOKEN"${scopeFlag}\` (run inside the target's root directory) for the NAMES of configured production variables. Never echo values.`,
          "   - If no token: say 'no Vercel token in this environment, reasoning from code and probes' and continue.",
          `   - Env fix commands use the form \`vercel env add NAME production${scopeFlag}\` followed by a redeploy.`,
        ].join('\n'),
      };
    }
    case 'fly': {
      const orgFlag = scope.org ? ` --org ${scope.org}` : '';
      return {
        deployModel: `CI runs \`fly deploy\` on every push to \`${cfg.defaultBranch}\`, so the deployed commit is the head of that branch.`,
        deployMetadata: 'Deployment metadata, best effort: the CI run on the deployed sha is the deploy record; `gh run view <id> --log` holds the `fly deploy` output. If `FLY_API_TOKEN` is set, `flyctl releases -a <app> --json | head -c 4000` lists releases with their image and status.',
        headers: 'Always capture the `fly-request-id` response header and the HTTP status on every probe.',
        bootSignature: ' with HTTP 502 or 503 from the Fly proxy while `flyctl status -a <app>` shows the machine restarting or in a failed health check',
        evidence: [
          `   - If \`FLY_API_TOKEN\` is set: \`flyctl status -a <app>${orgFlag}\`, \`timeout 40 flyctl logs -a <app> --no-tail | tail -c 6000\` for runtime logs, and \`flyctl secrets list -a <app>\` for the NAMES of configured secrets (digests only, never values). Install with \`curl -L https://fly.io/install.sh | sh\` if \`flyctl\` is missing.`,
          "   - If no token: say 'no Fly token in this environment, reasoning from code and probes' and continue.",
          '   - Env fix commands use the form `flyctl secrets set NAME=<value> -a <app>` (name only in the issue) which redeploys automatically.',
        ].join('\n'),
      };
    }
    case 'aws-lambda': {
      const regionFlag = scope.region ? ` --region ${scope.region}` : '';
      return {
        deployModel: `CI deploys to AWS Lambda on every push to \`${cfg.defaultBranch}\`, so the deployed commit is the head of that branch.`,
        deployMetadata: 'Deployment metadata, best effort: the CI run on the deployed sha is the deploy record (`gh run view <id> --log`). If AWS credentials are set, `aws lambda get-function --function-name <fn>' + regionFlag + ' --query \'Configuration.[LastModified,Version,State,LastUpdateStatus]\'` shows the live version.',
        headers: 'Always capture the `x-amzn-requestid` and `x-amzn-errortype` response headers on every probe.',
        bootSignature: ' with HTTP 502 and an init-phase error (`Runtime.ImportModuleError`, `Runtime.HandlerNotFound`, or an uncaught exception during init) in CloudWatch',
        evidence: [
          `   - If AWS credentials are set: \`aws logs tail /aws/lambda/<fn> --since 30m${regionFlag} | tail -c 6000\` for runtime logs, and \`aws lambda get-function-configuration --function-name <fn>${regionFlag} --query 'keys(Environment.Variables)'\` for the NAMES of configured variables. Never print values.`,
          "   - If no credentials: say 'no AWS credentials in this environment, reasoning from code and probes' and continue.",
          '   - Env fix commands are `aws lambda update-function-configuration --function-name <fn> --environment ...`; name the variables only and point at the deploy pipeline that owns them.',
        ].join('\n'),
      };
    }
    default:
      return {
        deployModel: `every push to \`${cfg.defaultBranch}\` is deployed to production, so the deployed commit is the head of that branch.`,
        deployMetadata: 'Deployment metadata, best effort: the CI run on the deployed sha is the deploy record (`gh run view <id> --log`).',
        headers: 'Always capture the HTTP status and any request-id or error response header on every probe.',
        bootSignature: ' (same error on every route, typically 5xx before any application code runs)',
        evidence: [
          "   - No platform log access is configured for this repository. Say so and reason from the probes, the diff and the local repro.",
        ].join('\n'),
      };
  }
}

// ---------------------------------------------------------------------------
// Notifications: one incoming-webhook payload per channel type. Angle-bracket
// placeholders are filled by the agent at run time; the URL comes from the
// environment and is never rendered.
// ---------------------------------------------------------------------------

const PLACEHOLDERS = Object.freeze({
  title: '<title: e.g. 🔴 Production deploy of <sha7> failed verification - <target>>',
  summary: '<summary: symptom, classification, root cause with confidence, names only>',
  links: 'PR: <pr_url>  Issue: <issue_url or n/a>  Run: <run_url>',
});

function notificationPayload(type, n, serviceName) {
  const mention = (n.mentions ?? []).join(' ');
  const username = n.username ?? 'deploy-monitor';
  const lead = mention ? `${mention} ${PLACEHOLDERS.title}` : PLACEHOLDERS.title;
  switch (type) {
    case 'discord':
      return {
        username,
        content: lead,
        allowed_mentions: { parse: ['users', 'roles'] },
        embeds: [{
          title: PLACEHOLDERS.title,
          url: '<issue_url or pr_url>',
          description: PLACEHOLDERS.summary,
          color: 15548997,
          fields: [
            { name: 'Service', value: serviceName, inline: true },
            { name: 'Target', value: '<target>', inline: true },
            { name: 'Commit', value: '<sha7>', inline: true },
            { name: 'Classification', value: '<classification>', inline: true },
            { name: 'Links', value: PLACEHOLDERS.links },
          ],
        }],
      };
    case 'slack':
      return {
        text: lead,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: PLACEHOLDERS.title } },
          { type: 'section', text: { type: 'mrkdwn', text: PLACEHOLDERS.summary } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Service*\n${serviceName}` },
            { type: 'mrkdwn', text: '*Target*\n<target>' },
            { type: 'mrkdwn', text: '*Commit*\n<sha7>' },
            { type: 'mrkdwn', text: '*Classification*\n<classification>' },
          ] },
          { type: 'context', elements: [{ type: 'mrkdwn', text: PLACEHOLDERS.links }] },
        ],
      };
    case 'teams':
      return {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: lead, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'TextBlock', text: PLACEHOLDERS.summary, wrap: true },
              { type: 'FactSet', facts: [
                { title: 'Service', value: serviceName },
                { title: 'Target', value: '<target>' },
                { title: 'Commit', value: '<sha7>' },
                { title: 'Classification', value: '<classification>' },
              ] },
            ],
            actions: [
              { type: 'Action.OpenUrl', title: 'Open issue', url: '<issue_url or pr_url>' },
              { type: 'Action.OpenUrl', title: 'Open run', url: '<run_url>' },
            ],
          },
        }],
      };
    default:
      return {
        source: 'deploy-monitor',
        event: '<event: ok | fail | regression>',
        service: serviceName,
        target: '<target>',
        sha: '<sha7>',
        verdict: '<ok | fail>',
        classification: '<classification or null>',
        confidence: '<certain | likely | unclear | null>',
        rootCause: '<one sentence, names only, or null>',
        prUrl: '<pr_url>',
        issueUrl: '<issue_url or null>',
        fixPrUrl: '<fix_pr_url or null>',
        runUrl: '<run_url>',
        mentions: n.mentions ?? [],
      };
  }
}

function notificationView(n, serviceName) {
  const base = NOTIFICATION_TYPES[n.type];
  const events = n.events ?? [...DEFAULT_NOTIFY_EVENTS];
  return {
    ...n,
    label: n.label ? `${base.label} (${n.label})` : base.label,
    urlEnv: n.urlEnv ?? base.urlEnv,
    events,
    eventsText: events.map((e) => '`' + e + '`').join(', '),
    colorNote: n.type === 'discord' ? ' Set `color` to 15548997 for fail, 5763719 for ok, 16705372 for regression.' : '',
    payload: JSON.stringify(notificationPayload(n.type, n, serviceName), null, 2),
  };
}

// ---------------------------------------------------------------------------
// Normalisation: config + defaults -> template view
// ---------------------------------------------------------------------------

const code = (s) => '`' + s + '`';
const joinCodes = (xs) => xs.map(code).join(', ');

function probeView(p) {
  const method = p.method ?? 'GET';
  const parts = ['curl -sS -i --max-time 20'];
  if (method !== 'GET') parts.push(`-X ${method}`);
  for (const [k, v] of Object.entries(p.headers ?? {})) parts.push(`-H '${k}: ${v}'`);
  parts.push(`<url>${p.path}`);
  const expect = p.expect.map(String);
  const expectText = expect.length === 1 ? expect[0] : `${expect.slice(0, -1).join(', ')} or ${expect.at(-1)}`;
  return { ...p, method, curl: parts.join(' '), expectText, summary: `${method} ${p.path}=<code>` };
}

export function normalize(input) {
  const cfg = {
    ...input,
    defaultBranch: input.defaultBranch ?? DEFAULTS.defaultBranch,
    platform: input.platform ?? DEFAULTS.platform,
    deploy: { ...DEFAULTS.deploy, ...(input.deploy ?? {}) },
    ci: { ...DEFAULTS.ci, ...(input.ci ?? {}) },
    build: { ...(input.build ?? {}) },
    escalation: { ...DEFAULTS.escalation, ...(input.escalation ?? {}) },
    fixPr: { ...DEFAULTS.fixPr, ...(input.fixPr ?? {}) },
    routine: { ...DEFAULTS.routine, ...(input.routine ?? {}) },
    knownFailureModes: input.knownFailureModes ?? [],
    runbookLinks: input.runbookLinks ?? [],
  };
  const profile = platformProfile(cfg);
  const targets = cfg.targets.map((t) => {
    const probes = t.probes.map(probeView);
    return {
      ...t,
      probes,
      secondaryUrlsText: t.secondaryUrls?.length ? joinCodes(t.secondaryUrls) : '',
      probeSummaryTemplate: probes.map((p) => p.summary).join(' '),
    };
  });
  const labels = cfg.escalation.labels.length ? cfg.escalation.labels : [...DEFAULTS.escalation.labels];
  const notifications = (input.notifications ?? []).map((n) => notificationView(n, cfg.name));
  const okNotifications = notifications.filter((n) => n.events.includes('ok'));
  return {
    ...cfg,
    targets,
    notifications,
    hasNotify: cfg.escalation.pushNotification || notifications.length > 0,
    okNotificationsText: okNotifications.map((n) => `${n.label} (env \`${n.urlEnv}\`)`).join(', '),
    repositoryUrl: `https://github.com/${cfg.repository}`,
    deployModel: cfg.deployModel ?? profile.deployModel,
    ciWorkflow: cfg.ci.workflow,
    primaryLabel: labels[0],
    labelsText: labels.join(','),
    assigneesText: cfg.escalation.assignees.length ? cfg.escalation.assignees.map((a) => `@${a}`).join(', ') : '',
    hasBootRepro: targets.some((t) => typeof t.bootRepro === 'string' && t.bootRepro !== ''),
    fixBaseBranch: cfg.fixPr.baseBranch ?? cfg.defaultBranch,
    forbiddenPathsText: cfg.fixPr.forbiddenPaths.length ? joinCodes(cfg.fixPr.forbiddenPaths) : '',
    bodySectionsText: cfg.fixPr.bodySections.length ? cfg.fixPr.bodySections.map((s) => `**${s}**`).join(', ') : '',
    runbookLinksText: cfg.runbookLinks.length ? joinCodes(cfg.runbookLinks) : '',
    platformDeployMetadata: profile.deployMetadata,
    platformHeaders: profile.headers,
    platformBootSignature: profile.bootSignature,
    platformEvidence: profile.evidence,
  };
}

// ---------------------------------------------------------------------------
// Tiny template engine: {{path}}, {{#if path}}...{{else}}...{{/if}}, {{#each path}}...{{/each}}
// Block tags that sit alone on a line are removed together with that line.
// ---------------------------------------------------------------------------

const TAG = /\{\{\s*(#if|#each|\/if|\/each|else)?\s*([^{}]*?)\s*\}\}/g;

function tokenize(src) {
  // Strip standalone block-tag lines so blocks do not leave blank lines behind.
  const standalone = /^[ \t]*(\{\{\s*(?:#if|#each|\/if|\/each|else)\b[^{}]*\}\})[ \t]*\r?\n/gm;
  const cleaned = src.replace(standalone, '$1');
  const tokens = [];
  let last = 0;
  for (const m of cleaned.matchAll(TAG)) {
    if (m.index > last) tokens.push({ type: 'text', value: cleaned.slice(last, m.index) });
    const kind = m[1] ?? 'var';
    tokens.push({ type: kind, value: m[2] });
    last = m.index + m[0].length;
  }
  if (last < cleaned.length) tokens.push({ type: 'text', value: cleaned.slice(last) });
  return tokens;
}

function parse(tokens) {
  let i = 0;
  function block(closers) {
    const nodes = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (closers.includes(t.type)) return nodes;
      i += 1;
      if (t.type === 'text' || t.type === 'var') nodes.push(t);
      else if (t.type === '#if') {
        const yes = block(['else', '/if']);
        let no = [];
        if (tokens[i]?.type === 'else') { i += 1; no = block(['/if']); }
        if (tokens[i]?.type !== '/if') throw new Error(`unclosed {{#if ${t.value}}}`);
        i += 1;
        nodes.push({ type: 'if', path: t.value, yes, no });
      } else if (t.type === '#each') {
        const body = block(['/each']);
        if (tokens[i]?.type !== '/each') throw new Error(`unclosed {{#each ${t.value}}}`);
        i += 1;
        nodes.push({ type: 'each', path: t.value, body });
      } else throw new Error(`unexpected {{${t.type}}}`);
    }
    return nodes;
  }
  const ast = block([]);
  if (i < tokens.length) throw new Error(`unexpected {{${tokens[i].type}}} at top level`);
  return ast;
}

function lookup(scopes, pathExpr) {
  if (pathExpr === 'this') return scopes[scopes.length - 1].value;
  if (pathExpr === '@index') return scopes[scopes.length - 1].index;
  const segs = pathExpr.split('.');
  for (let s = scopes.length - 1; s >= 0; s -= 1) {
    let cur = scopes[s].value;
    let ok = cur !== null && typeof cur === 'object' && segs[0] in cur;
    if (!ok) continue;
    for (const seg of segs) {
      if (cur === null || cur === undefined) { ok = false; break; }
      cur = cur[seg];
    }
    if (ok) return cur;
  }
  return undefined;
}

const truthy = (v) => Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
const stringify = (v) => Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v);

function evaluate(nodes, scopes) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'var') out += stringify(lookup(scopes, n.value));
    else if (n.type === 'if') out += evaluate(truthy(lookup(scopes, n.path)) ? n.yes : n.no, scopes);
    else if (n.type === 'each') {
      const items = lookup(scopes, n.path);
      if (Array.isArray(items)) items.forEach((item, index) => { out += evaluate(n.body, [...scopes, { value: item, index }]); });
    }
  }
  return out;
}

export function renderTemplate(template, view) {
  return evaluate(parse(tokenize(template)), [{ value: view, index: 0 }]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadConfig(file) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`invalid config ${file}:\n  - ${errors.join('\n  - ')}`);
  return cfg;
}

export function renderPrompt(cfg, templatePath = TEMPLATE_PATH) {
  const template = fs.readFileSync(templatePath, 'utf8');
  return renderTemplate(template, normalize(cfg)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function routineBody(cfg, { environmentId, prompt, uuid = randomUUID() } = {}) {
  const v = normalize(cfg);
  const env = environmentId ?? v.routine.environmentId;
  if (!env) throw new Error('environmentId is required: set routine.environmentId in the config or pass --environment');
  return {
    name: v.routine.name ?? `${v.name} deploy monitor`,
    cron_expression: v.routine.cron,
    enabled: true,
    job_config: {
      ccr: {
        environment_id: env,
        session_context: {
          model: v.routine.model,
          sources: [{ git_repository: { url: v.repositoryUrl } }],
          allowed_tools: [...v.routine.allowedTools],
        },
        events: [{
          data: {
            uuid: uuid.toLowerCase(),
            session_id: '',
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: prompt ?? renderPrompt(cfg) },
          },
        }],
      },
    },
  };
}

export function triggerBody(cfg, { routineTriggerId }) {
  if (!routineTriggerId) throw new Error('--routine trig_... is required');
  const v = normalize(cfg);
  return {
    routine_trigger_id: routineTriggerId,
    source: 'github',
    hook_type: 'app',
    scope_id: v.repository,
    events: ['pull_request.closed'],
    filter: {},
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) { opts[rest[i].slice(2)] = rest[i + 1]; i += 1; }
  }
  return { command, file, opts };
}

function main(argv) {
  const { command, file, opts } = parseArgs(argv);
  const usage = 'usage: render.mjs <render|validate|routine-body|trigger-body> <config.json> [--environment env_id] [--routine trig_id] [--prompt file] [--out file]';
  if (!command || !file) { process.stderr.write(usage + '\n'); return 2; }
  const write = (text) => { if (opts.out) fs.writeFileSync(opts.out, text); else process.stdout.write(text); };
  if (command === 'validate') {
    const errors = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (errors.length) { process.stderr.write(`invalid: ${file}\n  - ${errors.join('\n  - ')}\n`); return 1; }
    process.stdout.write(`valid: ${file}\n`);
    return 0;
  }
  const cfg = loadConfig(file);
  if (command === 'render') { write(renderPrompt(cfg)); return 0; }
  if (command === 'routine-body') {
    const prompt = opts.prompt ? fs.readFileSync(opts.prompt, 'utf8') : undefined;
    write(JSON.stringify(routineBody(cfg, { environmentId: opts.environment, prompt }), null, 2) + '\n');
    return 0;
  }
  if (command === 'trigger-body') { write(JSON.stringify(triggerBody(cfg, { routineTriggerId: opts.routine }), null, 2) + '\n'); return 0; }
  process.stderr.write(usage + '\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); } catch (err) { process.stderr.write(`${err.message}\n`); process.exit(1); }
}
