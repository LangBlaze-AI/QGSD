'use strict';

// Drift guard for the QGSDQuorum ⟂ NFQuorum duplication.
//
// QGSDQuorum.tla is a byte-identical copy of NFQuorum.tla except its header (module
// name, file path, source-machine comment, generated date). Its generator source
// (src/machines/qgsd-workflow.machine.ts) was removed in the qgsd→nf rename, so it can
// no longer be regenerated — it's a frozen orphan (registered + TLC-checked + referenced
// by hazard-model.cjs and ~5 tests, so not cheaply removable).
//
// The real hazard of a frozen duplicate is SILENT DRIFT: if NFQuorum's logic changes
// (it IS regenerated from nf-workflow.machine.ts), QGSDQuorum won't follow, and the two
// checked models diverge without anyone noticing. This test fails the moment their
// BODIES diverge, forcing a conscious re-sync or a full dedupe.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TLA = path.join(__dirname, '..', '.planning', 'formal', 'tla');

// Erase the known-cosmetic header differences; anything left is real logic drift.
function normalize(s) {
  return s
    .replace(/QGSDQuorum/g, 'NFQuorum')
    .replace(/qgsd-workflow/g, 'nf-workflow')
    .replace(/^.*Generated:.*$/gm, ' * Generated: <normalized>');
}

test('QGSDQuorum.tla stays a faithful mirror of NFQuorum.tla (no silent logic drift)', () => {
  const nf = fs.readFileSync(path.join(TLA, 'NFQuorum.tla'), 'utf8');
  const qgsd = fs.readFileSync(path.join(TLA, 'QGSDQuorum.tla'), 'utf8');
  assert.strictEqual(
    normalize(qgsd), normalize(nf),
    'QGSDQuorum.tla has drifted from NFQuorum.tla. It is a frozen orphan duplicate (its '
    + 'generator source was removed in the qgsd→nf rename). Re-sync it to NFQuorum.tla, '
    + 'or complete the dedupe (remove QGSDQuorum + repoint hazard-model.cjs/tests/registry).'
  );
});
