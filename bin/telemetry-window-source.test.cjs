#!/usr/bin/env node
'use strict';
// bin/telemetry-window-source.test.cjs
//
// STALL-TIMEOUT-03 resolves two windows and computes a `source` for each
// (per-slot / default / idle-budget / legacy-stall). recordTelemetry dropped both on
// the floor, so a TIMEOUT in the quorum-rounds log could not be attributed to the
// config that produced it — you could see that a slot died, never why its window was
// what it was. Accepted as improvement I5 by the 2026-08-07 quorum.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP = [];
process.on('exit', () => { for (const d of TMP) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

// Drive the REAL child so the fields are proven to survive the whole dispatch path,
// not just the function that formats them.
function dispatchAndReadTelemetry(providerExtras) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-telem-'));
  TMP.push(dir);
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cli = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(cli, "'use strict';\nprocess.stdout.write('verdict: APPROVE\\n');\n", 'utf8');
  const providersPath = path.join(dir, 'providers.json');
  fs.writeFileSync(providersPath, JSON.stringify({ providers: [{
    name: 'fake-slot', type: 'subprocess', mainTool: 'node', cli: 'node',
    args_template: [cli, '{prompt}'], ...providerExtras,
  }] }), 'utf8');

  spawnSync(process.execPath, [
    path.join(__dirname, 'call-quorum-slot.cjs'), '--slot', 'fake-slot', '--cwd', dir, '--round', '1',
  ], { cwd: dir, input: 'q\n', encoding: 'utf8', timeout: 30000,
       env: { ...process.env, UNIFIED_PROVIDERS_CONFIG: providersPath } });

  // Only the quorum-rounds log. A dispatch also writes .planning/telemetry/token-usage.jsonl,
  // whose records ALSO carry a `slot` field — reading both let a token-usage row win the
  // "last record" race and the assertions failed against a record that never had these
  // fields to begin with.
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/quorum-rounds.*\.jsonl?$/.test(e.name)) found.push(full);
    }
  })(path.join(dir, '.planning'));

  const records = [];
  for (const f of found) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.slot === 'fake-slot' && 'verdict' in r) records.push(r); } catch (_) {}
    }
  }
  return records;
}

test('TWS-1: the record carries both windows AND the source of each', () => {
  const recs = dispatchAndReadTelemetry({ idle_timeout_ms: 90000 });
  assert.ok(recs.length > 0, 'the dispatch wrote no telemetry record for the slot');
  const r = recs[recs.length - 1];
  assert.strictEqual(r.ttfb_source, 'default', 'an unconfigured TTFB must be attributed to the default');
  assert.strictEqual(r.ttfb_timeout_ms, 30000);
  assert.strictEqual(r.inter_chunk_source, 'idle-budget');
  assert.ok(r.inter_chunk_ceiling_ms > 0);
});

test('TWS-2: a per-slot window is attributed to the slot, not the default', () => {
  // The distinction the field exists for: 150000 could be a default in some future
  // build, so the number alone never answers "did MY config do this?".
  const recs = dispatchAndReadTelemetry({ ttfb_timeout_ms: 150000, inter_chunk_ceiling_ms: 660000 });
  const r = recs[recs.length - 1];
  assert.strictEqual(r.ttfb_timeout_ms, 150000);
  assert.strictEqual(r.ttfb_source, 'per-slot');
  assert.strictEqual(r.inter_chunk_source, 'per-slot');
});

test('TWS-3: a legacy stall_timeout_ms is reported as legacy, not silently normalised', () => {
  // Otherwise a config still on the old field looks identical to one that migrated.
  const recs = dispatchAndReadTelemetry({ stall_timeout_ms: 270000 });
  const r = recs[recs.length - 1];
  assert.strictEqual(r.inter_chunk_source, 'legacy-stall');
  assert.strictEqual(r.inter_chunk_ceiling_ms, 270000);
});

test('TWS-4: the fields are always present, so the schema is stable', () => {
  const r = dispatchAndReadTelemetry({}).pop();
  for (const k of ['ttfb_timeout_ms', 'ttfb_source', 'inter_chunk_ceiling_ms', 'inter_chunk_source']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), `record is missing ${k}`);
  }
});
