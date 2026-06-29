const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { linkFormalRefs } = require('./formal-ref-linker.cjs');

// Helper: create a minimal debt entry
function makeEntry(overrides = {}) {
  return {
    id: overrides.id || 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    fingerprint: overrides.fingerprint || 'abc123def4567890',
    title: overrides.title || 'Test entry',
    occurrences: 1,
    first_seen: '2026-03-04T12:00:00Z',
    last_seen: '2026-03-04T12:00:00Z',
    environments: ['production'],
    status: 'open',
    formal_ref: overrides.formal_ref !== undefined ? overrides.formal_ref : null,
    formal_ref_source: overrides.formal_ref_source !== undefined ? overrides.formal_ref_source : null,
    source_entries: [{ source_type: 'github', source_id: 'gh-1', observed_at: '2026-03-04T12:00:00Z' }]
  };
}

// Helper: create temp directory with mock requirements and spec
function setupTempDir(requirements = [], specModules = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-ref-'));
  const reqPath = path.join(tmpDir, 'requirements.json');
  fs.writeFileSync(reqPath, JSON.stringify(requirements), 'utf8');

  const specDir = path.join(tmpDir, 'spec');
  fs.mkdirSync(specDir, { recursive: true });
  for (const mod of specModules) {
    fs.mkdirSync(path.join(specDir, mod), { recursive: true });
  }

  return { tmpDir, reqPath, specDir };
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

test('linkFormalRefs', async (t) => {
  await t.test('entry with existing formal_ref is preserved, source set to "manual"', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir();
    try {
      const entries = [makeEntry({ formal_ref: 'requirement:DEBT-01' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref, 'requirement:DEBT-01');
      assert.strictEqual(result.entries[0].formal_ref_source, 'manual');
    } finally { cleanup(tmpDir); }
  });

  await t.test('entry with formal_ref_source already "manual" is not overwritten', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([{ id: 'DEBT-01', text: 'Schema validation' }]);
    try {
      const entries = [makeEntry({
        formal_ref: 'requirement:DEBT-01',
        formal_ref_source: 'manual',
        title: 'Schema validation fails'
      })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref, 'requirement:DEBT-01');
      assert.strictEqual(result.entries[0].formal_ref_source, 'manual');
    } finally { cleanup(tmpDir); }
  });

  await t.test('auto-detect: title matching a requirement keyword', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([
      { id: 'DEBT-01', text: 'Schema validation for debt entries' },
      { id: 'FP-01', text: 'Fingerprint generation algorithm' }
    ]);
    try {
      const entries = [makeEntry({ title: 'Schema validation fails on empty entries' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref, 'requirement:DEBT-01');
      assert.strictEqual(result.entries[0].formal_ref_source, 'auto-detect');
    } finally { cleanup(tmpDir); }
  });

  await t.test('spec-inferred: title matching a spec module name', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([], ['oscillation', 'quorum']);
    try {
      const entries = [makeEntry({ title: 'Oscillation in circuit breaker' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref, 'spec:oscillation');
      assert.strictEqual(result.entries[0].formal_ref_source, 'spec-inferred');
    } finally { cleanup(tmpDir); }
  });

  await t.test('no match: formal_ref remains null', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir(
      [{ id: 'DEBT-01', text: 'Schema validation' }],
      ['oscillation']
    );
    try {
      const entries = [makeEntry({ title: 'Completely unrelated error message' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref, null);
      assert.strictEqual(result.entries[0].formal_ref_source, null);
    } finally { cleanup(tmpDir); }
  });

  await t.test('priority: manual > auto-detect > spec-inferred', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir(
      [{ id: 'DEBT-01', text: 'Quorum deliberation timeout' }],
      ['quorum']
    );
    try {
      // Entry with title matching both requirement and spec — auto-detect wins over spec-inferred
      const entries = [makeEntry({ title: 'Quorum deliberation timeout error' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref_source, 'auto-detect');
    } finally { cleanup(tmpDir); }
  });

  await t.test('auto-detect: "Quorum deliberation timeout" matches requirement', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([
      { id: 'QR-01', text: 'Quorum deliberation must complete within timeout' }
    ]);
    try {
      const entries = [makeEntry({ title: 'Quorum deliberation timeout' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries[0].formal_ref, 'requirement:QR-01');
      assert.strictEqual(result.entries[0].formal_ref_source, 'auto-detect');
    } finally { cleanup(tmpDir); }
  });

  await t.test('multiple requirement matches: use best match (most keyword overlap)', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([
      { id: 'DEBT-01', text: 'Schema validation rules' },
      { id: 'DEBT-02', text: 'Schema validation for debt entry fingerprint' }
    ]);
    try {
      const entries = [makeEntry({ title: 'Schema validation for debt entry fails' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      // DEBT-02 should win: more keyword overlap
      assert.strictEqual(result.entries[0].formal_ref, 'requirement:DEBT-02');
    } finally { cleanup(tmpDir); }
  });

  await t.test('empty entries array returns empty', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir();
    try {
      const result = linkFormalRefs([], { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries.length, 0);
      assert.strictEqual(result.linkedCount, 0);
      assert.strictEqual(result.linkLog.length, 0);
    } finally { cleanup(tmpDir); }
  });

  await t.test('returns { entries, linkedCount, linkLog }', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([{ id: 'DEBT-01', text: 'Schema validation' }]);
    try {
      const entries = [makeEntry({ title: 'Schema validation fails' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.ok(Array.isArray(result.entries));
      assert.strictEqual(typeof result.linkedCount, 'number');
      assert.ok(Array.isArray(result.linkLog));
      assert.strictEqual(result.linkedCount, 1);
    } finally { cleanup(tmpDir); }
  });

  await t.test('fail-open: missing requirements file does not crash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-ref-'));
    const specDir = path.join(tmpDir, 'spec');
    fs.mkdirSync(specDir, { recursive: true });
    try {
      const entries = [makeEntry({ title: 'Test entry' })];
      const result = linkFormalRefs(entries, {
        requirementsPath: path.join(tmpDir, 'nonexistent.json'),
        specDir
      });
      assert.strictEqual(result.entries.length, 1);
    } finally { cleanup(tmpDir); }
  });

  await t.test('fail-open: missing spec directory does not crash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-ref-'));
    const reqPath = path.join(tmpDir, 'requirements.json');
    fs.writeFileSync(reqPath, '[]', 'utf8');
    try {
      const entries = [makeEntry({ title: 'Test entry' })];
      const result = linkFormalRefs(entries, {
        requirementsPath: reqPath,
        specDir: path.join(tmpDir, 'nonexistent-spec')
      });
      assert.strictEqual(result.entries.length, 1);
    } finally { cleanup(tmpDir); }
  });

  await t.test('fail-open: requirements.json with null array element does not crash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-ref-'));
    const reqPath = path.join(tmpDir, 'requirements.json');
    fs.writeFileSync(reqPath, JSON.stringify([null, { id: 'DEBT-01', text: 'Schema validation' }]), 'utf8');
    const specDir = path.join(tmpDir, 'spec');
    fs.mkdirSync(specDir, { recursive: true });
    try {
      const entries = [makeEntry({ title: 'Schema validation fails' })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries.length, 1);
      // the valid requirement should still auto-detect-match
      assert.strictEqual(result.entries[0].formal_ref, 'requirement:DEBT-01');
      assert.strictEqual(result.entries[0].formal_ref_source, 'auto-detect');
    } finally { cleanup(tmpDir); }
  });

  await t.test('non-string entry.title does not crash (treated as no keywords)', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir([{ id: 'DEBT-01', text: 'Schema validation' }]);
    try {
      const entries = [makeEntry({ title: 12345 })];
      const result = linkFormalRefs(entries, { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries.length, 1);
      assert.strictEqual(result.entries[0].formal_ref, null);
      assert.strictEqual(result.entries[0].formal_ref_source, null);
    } finally { cleanup(tmpDir); }
  });

  await t.test('fail-open: proximity node without edges array does not crash', () => {
    const { tmpDir, reqPath, specDir } = setupTempDir();
    const pfDir = path.join(tmpDir, '.planning', 'formal');
    fs.mkdirSync(pfDir, { recursive: true });
    fs.writeFileSync(
      path.join(pfDir, 'proximity-index.json'),
      JSON.stringify({ nodes: { 'code_file::bin/foo.cjs': { type: 'code_file' } } }),
      'utf8'
    );
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const entry = makeEntry({ title: 'Completely unrelated message' });
      entry.source_file = 'bin/foo.cjs';
      const result = linkFormalRefs([entry], { requirementsPath: reqPath, specDir });
      assert.strictEqual(result.entries.length, 1);
      assert.strictEqual(result.entries[0].formal_ref, null);
    } finally { process.chdir(origCwd); cleanup(tmpDir); }
  });
});
