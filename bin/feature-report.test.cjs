'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { generateReport } = require('./feature-report.cjs');
const { createFeatureEvent } = require('./feature-telemetry-schema.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feature-report-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function writeEvents(dir, events) {
  const telDir = path.join(dir, '.planning', 'telemetry');
  fs.mkdirSync(telDir, { recursive: true });
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(telDir, 'feature-events.jsonl'), content);
}

function makeEvent(overrides = {}) {
  return {
    feature_id: 'formal_loop',
    action: 'complete',
    session_id: 'sess-001',
    timestamp: new Date().toISOString(),
    outcome: 'success',
    duration_ms: 1000,
    schema_version: '1',
    user_id: 'local',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('feature-report', () => {
  const tempDirs = [];

  after(() => {
    for (const d of tempDirs) cleanup(d);
  });

  describe('empty file / missing file', () => {
    it('returns report with total_events: 0 for missing file', () => {
      const dir = createTempDir();
      tempDirs.push(dir);
      const report = generateReport(dir, { since: '30d' });
      assert.equal(report.total_events, 0);
      assert.deepEqual(report.bug_links, []);
      assert.ok(report.insights.some(i => i.includes('No feature telemetry events found')));
    });

    it('returns report with total_events: 0 for empty file', () => {
      const dir = createTempDir();
      tempDirs.push(dir);
      const telDir = path.join(dir, '.planning', 'telemetry');
      fs.mkdirSync(telDir, { recursive: true });
      fs.writeFileSync(path.join(telDir, 'feature-events.jsonl'), '');
      const report = generateReport(dir, { since: '30d' });
      assert.equal(report.total_events, 0);
    });
  });

  describe('valid events', () => {
    it('computes correct per-feature metrics for 10 events across 3 features', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const events = [
        // formal_loop: 4 events, 3 success, 1 failure
        makeEvent({ feature_id: 'formal_loop', action: 'complete', session_id: 'sess-1', outcome: 'success', duration_ms: 1000 }),
        makeEvent({ feature_id: 'formal_loop', action: 'complete', session_id: 'sess-1', outcome: 'success', duration_ms: 2000 }),
        makeEvent({ feature_id: 'formal_loop', action: 'complete', session_id: 'sess-2', outcome: 'success', duration_ms: 1500 }),
        makeEvent({ feature_id: 'formal_loop', action: 'fail', session_id: 'sess-3', outcome: 'failure', duration_ms: 500 }),

        // quorum_consensus: 3 events, 2 success, 1 failure
        makeEvent({ feature_id: 'quorum_consensus', action: 'complete', session_id: 'sess-1', outcome: 'success', duration_ms: 3000 }),
        makeEvent({ feature_id: 'quorum_consensus', action: 'complete', session_id: 'sess-2', outcome: 'success', duration_ms: 4000 }),
        makeEvent({ feature_id: 'quorum_consensus', action: 'fail', session_id: 'sess-3', outcome: 'failure', duration_ms: 1000 }),

        // debug_pipeline: 3 events, all success
        makeEvent({ feature_id: 'debug_pipeline', action: 'complete', session_id: 'sess-1', outcome: 'success', duration_ms: 800 }),
        makeEvent({ feature_id: 'debug_pipeline', action: 'complete', session_id: 'sess-2', outcome: 'success', duration_ms: 900 }),
        makeEvent({ feature_id: 'debug_pipeline', action: 'complete', session_id: 'sess-3', outcome: 'success', duration_ms: 700 }),
      ];

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '30d' });

      assert.equal(report.total_events, 10);

      // formal_loop metrics
      const fl = report.features.formal_loop;
      assert.equal(fl.usage_count, 4); // 3 complete + 1 fail
      assert.equal(fl.unique_sessions, 3);
      assert.equal(fl.success_count, 3);
      assert.equal(fl.failure_count, 1);
      assert.equal(fl.success_rate, 3 / 4);

      // quorum_consensus metrics
      const qc = report.features.quorum_consensus;
      assert.equal(qc.usage_count, 3);
      assert.equal(qc.unique_sessions, 3);

      // debug_pipeline metrics
      const dp = report.features.debug_pipeline;
      assert.equal(dp.usage_count, 3);
      assert.equal(dp.success_rate, 1.0);
      assert.ok(dp.avg_duration_ms > 0);
    });
  });

  describe('bug linkage', () => {
    it('links bugs to features via bug_link field', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const events = [
        makeEvent({
          feature_id: 'formal_loop',
          bug_link: { issue_url: 'https://github.com/org/repo/issues/42', detection_type: 'detected' },
        }),
        makeEvent({
          feature_id: 'debug_pipeline',
          bug_link: { issue_url: 'https://github.com/org/repo/issues/42', detection_type: 'detected' },
        }),
      ];

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '30d' });

      assert.equal(report.bug_links.length, 1);
      assert.equal(report.bug_links[0].issue_url, 'https://github.com/org/repo/issues/42');
      assert.ok(report.bug_links[0].features.includes('formal_loop'));
      assert.ok(report.bug_links[0].features.includes('debug_pipeline'));
    });
  });

  describe('time window filtering', () => {
    it('filters out events older than --since window', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const now = Date.now();
      const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
      const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const events = [
        makeEvent({ timestamp: fiveDaysAgo, session_id: 'recent' }),
        makeEvent({ timestamp: fortyDaysAgo, session_id: 'old' }),
      ];

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '7d' });

      assert.equal(report.total_events, 1);
      assert.equal(report.features.formal_loop.unique_sessions, 1);
    });
  });

  describe('invalid event skipping', () => {
    it('skips invalid events and counts them', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const telDir = path.join(dir, '.planning', 'telemetry');
      fs.mkdirSync(telDir, { recursive: true });

      const validEvt = JSON.stringify(makeEvent());
      const invalidEvt = JSON.stringify({ bad: 'event' });
      const brokenJson = 'not-json{';

      fs.writeFileSync(
        path.join(telDir, 'feature-events.jsonl'),
        [validEvt, invalidEvt, brokenJson, validEvt].join('\n') + '\n'
      );

      const report = generateReport(dir, { since: '30d' });
      assert.equal(report.total_events, 2);
      assert.equal(report.invalid_events, 2);
    });
  });

  describe('insight generation', () => {
    it('generates high-failure insight for feature with >50% failure rate', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const events = [
        makeEvent({ feature_id: 'formal_loop', action: 'fail', outcome: 'failure' }),
        makeEvent({ feature_id: 'formal_loop', action: 'fail', outcome: 'failure' }),
        makeEvent({ feature_id: 'formal_loop', action: 'complete', outcome: 'success' }),
        // Need at least one other feature to avoid it being the only "top" insight
        makeEvent({ feature_id: 'debug_pipeline', action: 'complete', outcome: 'success' }),
      ];

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '30d' });
      assert.ok(report.insights.some(i => i.includes('failure rate') && i.includes('formal_loop')));
    });

    it('generates bug-catcher insight for features with bug_links', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const events = [
        makeEvent({
          feature_id: 'debug_pipeline',
          bug_link: { issue_url: 'https://github.com/org/repo/issues/99', detection_type: 'detected' },
        }),
      ];

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '30d' });
      assert.ok(report.insights.some(i => i.includes('detected') && i.includes('debug_pipeline')));
    });

    it('generates unused-feature insight for features with 0 uses', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      // Only use formal_loop — other features should show as unused
      const events = [
        makeEvent({ feature_id: 'formal_loop', action: 'complete', outcome: 'success' }),
      ];

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '30d' });
      // At least some features should be flagged as unused
      assert.ok(report.insights.some(i => i.includes('0 uses')));
    });
  });

  describe('CLI integration', () => {
    it('exits 0 and produces valid JSON with --json flag', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const result = spawnSync(process.execPath, [
        path.join(__dirname, 'feature-report.cjs'),
        '--json',
        `--project-root=${dir}`,
      ], { encoding: 'utf8', timeout: 15000 });

      assert.equal(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.ok(report.generated_at);
      assert.equal(report.total_events, 0);
    });
  });

  describe('end-to-end pilot', () => {
    it('generates meaningful report from realistic week of nForma usage', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const now = Date.now();
      const events = [];

      // Simulate a week of formal_loop usage (most active, some failures)
      for (let i = 0; i < 8; i++) {
        const ts = new Date(now - (6 - i % 7) * 24 * 60 * 60 * 1000).toISOString();
        events.push(makeEvent({
          feature_id: 'formal_loop',
          action: i < 6 ? 'complete' : 'fail',
          session_id: `sess-${i % 3}`,
          timestamp: ts,
          outcome: i < 6 ? 'success' : 'failure',
          duration_ms: 1000 + i * 200,
        }));
      }

      // Simulate quorum_consensus usage (moderate)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now - (5 - i) * 24 * 60 * 60 * 1000).toISOString();
        events.push(makeEvent({
          feature_id: 'quorum_consensus',
          action: 'complete',
          session_id: `sess-${i}`,
          timestamp: ts,
          outcome: 'success',
          duration_ms: 3000 + i * 500,
        }));
      }

      // Simulate debug_pipeline catching a bug
      events.push(makeEvent({
        feature_id: 'debug_pipeline',
        action: 'complete',
        session_id: 'sess-debug-1',
        timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
        outcome: 'success',
        duration_ms: 5000,
        bug_link: {
          issue_url: 'https://github.com/nforma-ai/nforma/issues/61',
          detection_type: 'detected',
        },
      }));

      // Simulate pre_commit_gate preventing a bug
      events.push(makeEvent({
        feature_id: 'pre_commit_gate',
        action: 'complete',
        session_id: 'sess-gate-1',
        timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
        outcome: 'success',
        duration_ms: 800,
        bug_link: {
          issue_url: 'https://github.com/nforma-ai/nforma/issues/62',
          detection_type: 'prevented',
        },
      }));

      // Leave some features unused (task_classification, model_staleness, etc.)

      writeEvents(dir, events);
      const report = generateReport(dir, { since: '30d' });

      // Verify total events
      assert.equal(report.total_events, events.length);

      // Verify features with data have correct metrics
      assert.ok(report.features.formal_loop.usage_count >= 6);
      assert.ok(report.features.quorum_consensus.usage_count >= 4);
      assert.ok(report.features.debug_pipeline.usage_count >= 1);

      // Verify bug linkage
      assert.ok(report.bug_links.length >= 2);

      // Verify insights exist and are meaningful
      assert.ok(report.insights.length >= 1);
      // Should have a "top feature" insight
      assert.ok(report.insights.some(i => i.includes('most-used')));
      // Should have insights about bug detection
      assert.ok(report.insights.some(i => i.includes('detected') || i.includes('prevented')));
      // Should flag unused features
      assert.ok(report.insights.some(i => i.includes('0 uses')));
    });
  });

  describe('prototype-pollution bug_link.issue_url', () => {
    it('does not crash when issue_url is "__proto__"', () => {
      const dir = createTempDir();
      tempDirs.push(dir);

      const events = [
        makeEvent({
          feature_id: 'formal_loop',
          bug_link: { issue_url: '__proto__', detection_type: 'detected' },
        }),
      ];

      writeEvents(dir, events);
      let report;
      assert.doesNotThrow(() => { report = generateReport(dir, { since: '30d' }); });
      assert.equal(report.bug_links.length, 1);
      assert.equal(report.bug_links[0].issue_url, '__proto__');
      assert.ok(report.bug_links[0].features.includes('formal_loop'));
    });

    it('does not crash when issue_url is "constructor"', () => {
      const dir = createTempDir();
      tempDirs.push(dir);
      writeEvents(dir, [makeEvent({
        feature_id: 'debug_pipeline',
        bug_link: { issue_url: 'constructor', detection_type: 'detected' },
      })]);
      let report;
      assert.doesNotThrow(() => { report = generateReport(dir, { since: '30d' }); });
      assert.equal(report.bug_links.length, 1);
      assert.equal(report.bug_links[0].issue_url, 'constructor');
    });
  });

  describe('null/invalid opts argument', () => {
    it('does not crash when opts is null', () => {
      const dir = createTempDir();
      tempDirs.push(dir);
      let report;
      assert.doesNotThrow(() => { report = generateReport(dir, null); });
      assert.equal(report.total_events, 0);
      assert.equal(report.time_window, '30d');
    });
  });
});
