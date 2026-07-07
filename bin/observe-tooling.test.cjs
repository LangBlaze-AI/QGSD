'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  OBSERVE_TOOLS,
  parseVersion,
  interpretTool,
  detectObserveTooling,
  renderToolingStatus,
  annotateResultsWithTooling,
  runCli,
} = require('./observe-tooling.cjs');

// Real fixtures captured from the live CLIs.
const SENTRY_VERSION = 'sentry-cli 3.6.0';
const SENTRY_INFO_AUTHED =
  'Sentry Server: https://sentry.io\nDefault Organization: acme\n\nAuthentication Info:\n  Method: Auth Token\n  User: a@b.co\n';
const GCX_VERSION = 'gcx version v0.4.2 built from homebrew on 2026-06-29T10:13:22Z';
const GCX_CONTEXT = 'default\n';

const tool = (name) => OBSERVE_TOOLS.find((t) => t.name === name);
const ok = (stdout) => ({ status: 0, stdout, error: undefined });
const enoent = () => ({ status: null, stdout: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });

describe('parseVersion', () => {
  it('extracts sentry-cli version', () => {
    assert.equal(parseVersion(SENTRY_VERSION), '3.6.0');
  });
  it('extracts gcx version ignoring the v prefix and trailing build info', () => {
    assert.equal(parseVersion(GCX_VERSION), '0.4.2');
  });
  it('returns null when no version token is present', () => {
    assert.equal(parseVersion('command not found'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion(undefined), null);
  });
});

describe('interpretTool', () => {
  it('installed + authed → healthy with version', () => {
    const s = interpretTool(tool('sentry-cli'), ok(SENTRY_VERSION), ok(SENTRY_INFO_AUTHED));
    assert.deepEqual(
      { installed: s.installed, authed: s.authed, healthy: s.healthy, version: s.version, hint: s.hint },
      { installed: true, authed: true, healthy: true, version: '3.6.0', hint: null }
    );
    assert.deepEqual(s.sources, ['sentry', 'sentry-feedback']);
  });

  it('installed but NOT authed → auth hint, not healthy', () => {
    // sentry-cli info with no auth block (no "Method:" line)
    const s = interpretTool(tool('sentry-cli'), ok(SENTRY_VERSION), ok('Sentry Server: https://sentry.io\n'));
    assert.equal(s.installed, true);
    assert.equal(s.authed, false);
    assert.equal(s.healthy, false);
    assert.match(s.hint, /sentry-cli login/);
  });

  it('not installed (ENOENT) → install hint, auth probe irrelevant', () => {
    const s = interpretTool(tool('gcx'), enoent(), {});
    assert.equal(s.installed, false);
    assert.equal(s.authed, false);
    assert.equal(s.healthy, false);
    assert.equal(s.version, null);
    assert.match(s.hint, /brew install grafana\/grafana\/gcx/);
  });

  it('gcx installed + context set → healthy', () => {
    const s = interpretTool(tool('gcx'), ok(GCX_VERSION), ok(GCX_CONTEXT));
    assert.equal(s.healthy, true);
    assert.equal(s.version, '0.4.2');
  });

  it('gcx installed but empty current-context → not authed', () => {
    const s = interpretTool(tool('gcx'), ok(GCX_VERSION), ok('   \n'));
    assert.equal(s.installed, true);
    assert.equal(s.authed, false);
    assert.match(s.hint, /gcx login/);
  });

  it('non-zero version exit is treated as not installed', () => {
    const s = interpretTool(tool('gcx'), { status: 127, stdout: '', error: undefined }, {});
    assert.equal(s.installed, false);
  });
});

describe('detectObserveTooling', () => {
  it('probes each tool with an injected spawnFn and skips auth when uninstalled', () => {
    const calls = [];
    const spawnFn = (bin, args) => {
      calls.push(`${bin} ${args.join(' ')}`);
      if (bin === 'sentry-cli' && args[0] === '--version') return ok(SENTRY_VERSION);
      if (bin === 'sentry-cli' && args[0] === 'info') return ok(SENTRY_INFO_AUTHED);
      if (bin === 'gcx' && args[0] === '--version') return enoent(); // gcx missing
      throw new Error(`unexpected spawn: ${bin} ${args}`);
    };
    const statuses = detectObserveTooling({ spawnFn });
    const sentry = statuses.find((s) => s.name === 'sentry-cli');
    const gcx = statuses.find((s) => s.name === 'gcx');
    assert.equal(sentry.healthy, true);
    assert.equal(gcx.installed, false);
    // gcx auth (`config current-context`) must NOT have been probed after ENOENT.
    assert.ok(!calls.some((c) => c.startsWith('gcx config')), 'auth probe skipped when uninstalled');
  });

  it('a thrown spawn degrades that tool to not-installed (fail-open)', () => {
    const spawnFn = () => { throw new Error('boom'); };
    const statuses = detectObserveTooling({ spawnFn });
    assert.ok(statuses.every((s) => s.installed === false && s.healthy === false));
  });

  it('sourceTypes allowlist: only probes CLIs backing a configured source type', () => {
    const calls = [];
    const spawnFn = (bin, args) => { calls.push(bin); return ok(bin === 'gcx' ? GCX_VERSION : SENTRY_VERSION); };
    // Only a grafana source is configured → gcx probed, sentry-cli NOT.
    const statuses = detectObserveTooling({ spawnFn, sourceTypes: ['grafana'] });
    assert.deepEqual(statuses.map((s) => s.name), ['gcx'], 'only gcx probed');
    assert.ok(!calls.includes('sentry-cli'), 'sentry-cli must not be shelled out for a grafana-only run');
  });

  it('sourceTypes allowlist: internal-only run probes NOTHING (fast no-op path)', () => {
    const calls = [];
    const spawnFn = (bin) => { calls.push(bin); return ok(''); };
    const statuses = detectObserveTooling({ spawnFn, sourceTypes: new Set(['internal', 'github']) });
    assert.deepEqual(statuses, [], 'no CLI-backed source configured → no tools');
    assert.equal(calls.length, 0, 'no subprocess probes at all');
  });
});

describe('renderToolingStatus', () => {
  it('renders a ✓ for healthy and ✗ + hint for unhealthy', () => {
    const out = renderToolingStatus([
      interpretTool(tool('sentry-cli'), ok(SENTRY_VERSION), ok(SENTRY_INFO_AUTHED)),
      interpretTool(tool('gcx'), enoent(), {}),
    ]);
    assert.match(out, /✓ sentry-cli 3\.6\.0  authenticated/);
    assert.match(out, /✗ gcx  not installed/);
    assert.match(out, /brew install grafana\/grafana\/gcx/);
  });
  it('does not throw on empty/garbage input', () => {
    assert.doesNotThrow(() => renderToolingStatus([]));
    assert.doesNotThrow(() => renderToolingStatus(undefined));
  });
});

describe('annotateResultsWithTooling', () => {
  it('adds a tooling_hint to an errored grafana result when gcx is missing', () => {
    const results = [
      { source_type: 'grafana', status: 'error', error: 'HTTP fetch failed', issues: [] },
      { source_type: 'github', status: 'ok', issues: [] },
    ];
    const statuses = [interpretTool(tool('gcx'), enoent(), {})];
    annotateResultsWithTooling(results, statuses);
    assert.match(results[0].tooling_hint, /gcx not installed/);
    assert.match(results[0].tooling_hint, /likely tooling, not drift/);
    assert.equal(results[1].tooling_hint, undefined, 'ok results untouched');
  });

  it('does NOT annotate when the backing tool is healthy', () => {
    const results = [{ source_type: 'sentry', status: 'error', error: 'rate limited', issues: [] }];
    const statuses = [interpretTool(tool('sentry-cli'), ok(SENTRY_VERSION), ok(SENTRY_INFO_AUTHED))];
    annotateResultsWithTooling(results, statuses);
    assert.equal(results[0].tooling_hint, undefined, 'healthy tool cannot explain the error');
  });

  it('distinguishes not-installed from not-authenticated in the hint', () => {
    const results = [{ source_type: 'sentry-feedback', status: 'error', error: 'x', issues: [] }];
    const statuses = [interpretTool(tool('sentry-cli'), ok(SENTRY_VERSION), ok('no auth here'))];
    annotateResultsWithTooling(results, statuses);
    assert.match(results[0].tooling_hint, /sentry-cli not authenticated/);
  });

  it('is a no-op on non-array results', () => {
    assert.equal(annotateResultsWithTooling(null, []), null);
  });
});

describe('runCli (autodetection script)', () => {
  const healthy = { name: 'gcx', installed: true, authed: true, healthy: true, version: '0.4.2', sources: ['grafana'], hint: null };
  const unhealthy = { name: 'sentry-cli', installed: false, authed: false, healthy: false, version: null, sources: ['sentry', 'sentry-feedback'], hint: 'brew install ...' };
  const detectStub = (statuses) => { const fn = (opts) => { fn.lastOpts = opts; return statuses; }; return fn; };

  it('human output renders the status table and exits 0 by default (even when unhealthy)', () => {
    const { output, code } = runCli([], { detect: detectStub([healthy, unhealthy]) });
    assert.equal(code, 0, 'a plain report never fails the process');
    assert.match(output, /tooling preflight/);
    assert.match(output, /✓ gcx/);
    assert.match(output, /✗ sentry-cli/);
  });

  it('--json emits machine-readable status with all_healthy flag', () => {
    const { output } = runCli(['--json'], { detect: detectStub([healthy, unhealthy]) });
    const parsed = JSON.parse(output);
    assert.equal(parsed.all_healthy, false);
    assert.equal(parsed.tools.length, 2);
    assert.equal(parsed.tools[0].name, 'gcx');
  });

  it('--strict exits 1 when any probed CLI is unhealthy, 0 when all healthy', () => {
    assert.equal(runCli(['--strict'], { detect: detectStub([healthy, unhealthy]) }).code, 1);
    assert.equal(runCli(['--strict'], { detect: detectStub([healthy]) }).code, 0);
  });

  it('--source filters detection to the backing CLI(s) via sourceTypes', () => {
    const detect = detectStub([healthy]);
    runCli(['--source', 'grafana'], { detect });
    assert.deepEqual(detect.lastOpts, { sourceTypes: ['grafana'] });
  });

  it('--source does not swallow a following flag as its value', () => {
    const detect = detectStub([unhealthy]);
    // `--source --strict`: --strict must NOT be consumed as a source value,
    // so no sourceTypes filter is applied AND --strict still takes effect.
    const { code } = runCli(['--source', '--strict'], { detect });
    assert.equal(detect.lastOpts && detect.lastOpts.sourceTypes, undefined, '--strict must not become a source filter');
    assert.equal(code, 1, '--strict must still be honored (unhealthy → exit 1)');
  });

  it('empty status set (filter matches nothing) prints a friendly note, exit 0', () => {
    const { output, code } = runCli(['--source', 'github'], { detect: detectStub([]) });
    assert.equal(code, 0);
    assert.match(output, /no CLI-backed tools match/);
  });

  it('--help prints usage and exits 0 without probing', () => {
    let probed = false;
    const { output, code } = runCli(['--help'], { detect: () => { probed = true; return []; } });
    assert.equal(code, 0);
    assert.equal(probed, false, 'help must not shell out');
    assert.match(output, /Usage:/);
    assert.match(output, /sentry-cli/);
  });
});
