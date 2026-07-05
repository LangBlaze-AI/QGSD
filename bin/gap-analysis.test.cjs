'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gapAnalysis, extractPlanRefs } = require('./gap-analysis.cjs');

const BIN = path.join(__dirname, 'gap-analysis.cjs');

test('gapAnalysis: COVERED vs MISSING by plan references', () => {
  const reqs = [{ id: 'ADAPT-01' }, { id: 'ADR-01' }, { id: 'BLD-01' }];
  const refs = new Set(['ADAPT-01', 'ADR-01']);
  const r = gapAnalysis(reqs, refs);
  assert.strictEqual(r.covered, 2);
  assert.deepStrictEqual(r.missing, ['BLD-01']);
});

test('gapAnalysis fusion: a MISSING requirement with formal_models is HIGH priority', () => {
  const reqs = [
    { id: 'WIZ-05', formal_models: ['QGSDSetupWizard.tla'] },
    { id: 'WIZ-06', formal_models: [] },
  ];
  const r = gapAnalysis(reqs, new Set()); // nothing planned
  assert.deepStrictEqual(r.missing_formal, ['WIZ-05'], 'only the formally-modeled one is a HIGH gap');
  const wiz05 = r.rows.find((x) => x.id === 'WIZ-05');
  assert.strictEqual(wiz05.priority, 'HIGH');
  const wiz06 = r.rows.find((x) => x.id === 'WIZ-06');
  assert.strictEqual(wiz06.priority, 'normal');
});

test('extractPlanRefs pulls req-IDs from PLAN.md requirements fields + inline mentions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
  try {
    fs.writeFileSync(path.join(dir, 'PLAN.md'), 'requirements: [ADAPT-01, ADR-01]\n\nAlso touches BLD-01 inline.\n');
    const { refs, planCount } = extractPlanRefs(dir);
    assert.strictEqual(planCount, 1);
    assert.ok(refs.has('ADAPT-01') && refs.has('ADR-01') && refs.has('BLD-01'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('extractPlanRefs descends one level into phase subdirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
  try {
    const sub = path.join(dir, 'phase-03'); fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'PLAN.md'), 'requirements: [SUB-01]\n');
    const { refs } = extractPlanRefs(dir);
    assert.ok(refs.has('SUB-01'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fail-open: missing plans dir → empty refs, no throw', () => {
  const { refs, planCount } = extractPlanRefs('/no/such/dir/xyz');
  assert.strictEqual(refs.size, 0);
  assert.strictEqual(planCount, 0);
});

test('CLI: --json emits coverage with HIGH formal gaps, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-cli-'));
  try {
    const reqJson = path.join(dir, 'requirements.json');
    fs.writeFileSync(reqJson, JSON.stringify({ requirements: [
      { id: 'XX-01', phase: '3', formal_models: ['M.tla'] },
      { id: 'XX-02', phase: '3', formal_models: [] },
    ] }));
    fs.writeFileSync(path.join(dir, 'PLAN.md'), 'requirements: [XX-02]\n');
    const out = execFileSync(process.execPath, [BIN, '--phase', '3', '--req-json', reqJson, '--plans-dir', dir, '--json'], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.strictEqual(r.covered, 1);
    assert.deepStrictEqual(r.missing_formal, ['XX-01']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
