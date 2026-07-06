'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { lintSkills } = require('./skill-invocation-lint.cjs');

const BIN = path.join(__dirname, 'skill-invocation-lint.cjs');

test('the real repo skill set has an intact invocation surface (0 unresolved refs)', () => {
  const findings = lintSkills();
  assert.deepStrictEqual(findings, [], 'unexpected unresolved skill references: ' + JSON.stringify(findings));
});

test('CLI exits 0 on the clean repo', () => {
  const out = execFileSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.match(out, /all skill tool\/agent\/workflow references resolve/);
});

// The false-positive controls the dogfood surfaced — encoded as regression guards on the
// pure extraction/strip helpers so they can't silently loosen.
const mod = require('./skill-invocation-lint.cjs');

test('resolveTool finds tools across all real locations', () => {
  // nf-tools lives in core/bin (not bin/); a repowise tool lives in bin/repowise/.
  assert.ok(mod.resolveTool('nf-tools.cjs'), 'nf-tools.cjs must resolve (core/bin)');
  assert.ok(mod.resolveTool('context-packer.cjs'), 'context-packer.cjs must resolve (bin/repowise)');
  assert.strictEqual(mod.resolveTool('definitely-not-real-xyz.cjs'), null);
});
