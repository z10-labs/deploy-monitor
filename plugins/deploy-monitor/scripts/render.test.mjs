import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate, validateConfig, normalize, renderPrompt, routineBody, triggerBody } from './render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, '..', '..', '..', 'examples', 'tutorspaces-api.json');
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));

const minimal = () => ({
  name: 'svc',
  repository: 'acme/svc',
  targets: [{ name: 'svc', url: 'https://svc.example.com', probes: [{ path: '/health', expect: [200] }] }],
});

// --- template engine --------------------------------------------------------

test('renders variables, dotted paths and arrays', () => {
  // Arrange
  const view = { a: 'x', b: { c: 'y' }, list: ['p', 'q'] };
  // Act
  const out = renderTemplate('{{a}}-{{b.c}}-{{list}}-{{missing}}', view);
  // Assert
  assert.equal(out, 'x-y-p, q-');
});

test('if/else uses truthiness of strings, arrays and booleans', () => {
  const tpl = '{{#if s}}S{{else}}s{{/if}}{{#if arr}}A{{else}}a{{/if}}{{#if flag}}F{{else}}f{{/if}}';
  assert.equal(renderTemplate(tpl, { s: '', arr: [], flag: false }), 'saf');
  assert.equal(renderTemplate(tpl, { s: 'x', arr: [1], flag: true }), 'SAF');
});

test('each exposes this, @index and item fields, and falls back to outer scope', () => {
  const tpl = '{{#each items}}{{@index}}:{{name}}/{{outer}};{{/each}}{{#each words}}{{this}}{{/each}}';
  const out = renderTemplate(tpl, { items: [{ name: 'a' }, { name: 'b' }], outer: 'o', words: ['x', 'y'] });
  assert.equal(out, '0:a/o;1:b/o;xy');
});

test('block tags on their own line leave no blank line behind', () => {
  const tpl = 'top\n{{#if yes}}\ninside\n{{/if}}\nbottom\n';
  assert.equal(renderTemplate(tpl, { yes: true }), 'top\ninside\nbottom\n');
  assert.equal(renderTemplate(tpl, { yes: false }), 'top\nbottom\n');
});

test('unclosed blocks throw', () => {
  assert.throws(() => renderTemplate('{{#if x}}never closed', {}), /unclosed/);
});

// --- validation -------------------------------------------------------------

test('validateConfig accepts the example and the minimal config', () => {
  assert.deepEqual(validateConfig(example()), []);
  assert.deepEqual(validateConfig(minimal()), []);
});

test('validateConfig reports missing and malformed fields', () => {
  const errors = validateConfig({ repository: 'not-a-repo', targets: [], bogus: 1, platform: 'heroku' });
  assert.ok(errors.some((e) => e.includes('"name"')));
  assert.ok(errors.some((e) => e.includes('owner/repo')));
  assert.ok(errors.some((e) => e.includes('targets')));
  assert.ok(errors.some((e) => e.includes('unknown top-level key "bogus"')));
  assert.ok(errors.some((e) => e.includes('"platform"')));
});

test('validateConfig checks probes', () => {
  const cfg = minimal();
  cfg.targets[0].probes = [{ path: 'health', expect: [] }, { path: '/x', expect: [200], method: 'PATCH' }];
  const errors = validateConfig(cfg);
  assert.ok(errors.some((e) => e.includes('probes[0].path')));
  assert.ok(errors.some((e) => e.includes('probes[0].expect')));
  assert.ok(errors.some((e) => e.includes('probes[1].method')));
});

// --- normalisation ----------------------------------------------------------

test('normalize applies defaults and derives probe text', () => {
  const v = normalize(minimal());
  assert.equal(v.defaultBranch, 'main');
  assert.equal(v.platform, 'generic');
  assert.equal(v.primaryLabel, 'deploy-monitor');
  assert.equal(v.fixPr.maxFiles, 3);
  assert.equal(v.targets[0].probes[0].curl, 'curl -sS -i --max-time 20 <url>/health');
  assert.equal(v.targets[0].probes[0].expectText, '200');
});

test('normalize renders multi-status expectations and non-GET methods', () => {
  const cfg = minimal();
  cfg.targets[0].probes = [{ path: '/drain', method: 'POST', expect: [401, 403], headers: { accept: 'application/json' } }];
  const p = normalize(cfg).targets[0].probes[0];
  assert.equal(p.curl, "curl -sS -i --max-time 20 -X POST -H 'accept: application/json' <url>/drain");
  assert.equal(p.expectText, '401 or 403');
});

// --- end-to-end rendering ---------------------------------------------------

test('tutorspaces example renders a complete, placeholder-free prompt', () => {
  const out = renderPrompt(example());
  assert.ok(!out.includes('{{'), 'no unrendered tags');
  for (const needle of [
    'https://tutorspaces-api.vercel.app',
    'https://tutorspaces-worker.vercel.app',
    'x-vercel-error',
    '--scope team_xYfve1tIZeqcx8XWepKpfbll',
    'curl -sS -i --max-time 20 -X POST <url>/internal/drain',
    'expect HTTP 401 or 403',
    '`packages/kernel`, `packages/contracts`, `packages/persistence/schema`',
    'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>',
    '**Events published / consumed**',
    'cd apps/api && VERCEL_ENV=production timeout 30 node dist/main.js',
    'contract/openapi.json',
    'tutorspaces-web',
    '@Dzithendo31',
    'Wait 4 minutes before the first probe',
    '## 7. Final report',
  ]) assert.ok(out.includes(needle), `missing: ${needle}`);
  assert.ok(!/\n{3,}/.test(out), 'no triple blank lines');
});

test('generic platform without fix PRs renders the disabled wording and no Vercel text', () => {
  const cfg = minimal();
  cfg.fixPr = { enabled: false };
  cfg.escalation = { successComment: false, pushNotification: false };
  const out = renderPrompt(cfg);
  assert.ok(out.includes('Fix PRs are disabled for this repository'));
  assert.ok(out.includes('Merge-triggered run: post nothing.'));
  assert.ok(!out.includes('**c. Notify.**'));
  assert.ok(!out.includes('vercel'));
  assert.ok(!out.includes('contract-drift'));
  assert.ok(out.includes('No platform log access is configured'));
});

test('fly and aws-lambda profiles mention their own tooling', () => {
  const fly = { ...minimal(), platform: 'fly' };
  const lambda = { ...minimal(), platform: 'aws-lambda', platformScope: { region: 'eu-west-1' } };
  assert.ok(renderPrompt(fly).includes('flyctl logs'));
  assert.ok(renderPrompt(lambda).includes('aws logs tail'));
  assert.ok(renderPrompt(lambda).includes('--region eu-west-1'));
});

test('rendering is deterministic', () => {
  assert.equal(renderPrompt(example()), renderPrompt(example()));
});

// --- API bodies -------------------------------------------------------------

test('routineBody has the routines-API shape with a user-role message', () => {
  const body = routineBody(example(), { uuid: 'ABCDEF12-3456-4789-8ABC-DEF012345678' });
  assert.equal(body.cron_expression, '0 5 * * *');
  assert.equal(body.job_config.ccr.environment_id, 'env_01QFiuVMFKeqwrzTcUTyMmDN');
  assert.equal(body.job_config.ccr.session_context.model, 'claude-sonnet-5-5');
  assert.deepEqual(body.job_config.ccr.session_context.sources, [{ git_repository: { url: 'https://github.com/Dzithendo31/tutorspaces-api' } }]);
  const ev = body.job_config.ccr.events[0].data;
  assert.equal(ev.uuid, 'abcdef12-3456-4789-8abc-def012345678');
  assert.equal(ev.message.role, 'user');
  assert.ok(ev.message.content.startsWith('You are the production deploy monitor for `tutorspaces-api`'));
});

test('routineBody requires an environment id', () => {
  assert.throws(() => routineBody(minimal()), /environmentId is required/);
  assert.equal(routineBody(minimal(), { environmentId: 'env_x' }).job_config.ccr.environment_id, 'env_x');
});

test('triggerBody matches the accepted webhook-trigger shape', () => {
  assert.deepEqual(triggerBody(example(), { routineTriggerId: 'trig_1' }), {
    routine_trigger_id: 'trig_1',
    source: 'github',
    hook_type: 'app',
    scope_id: 'Dzithendo31/tutorspaces-api',
    events: ['pull_request.closed'],
    filter: {},
  });
  assert.throws(() => triggerBody(minimal(), {}), /--routine/);
});
