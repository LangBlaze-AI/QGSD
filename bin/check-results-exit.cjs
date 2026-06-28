'use strict';

const fs   = require('fs');
const { NDJSON_PATH } = require('./write-check-result.cjs');

if (!fs.existsSync(NDJSON_PATH)) {
  process.stderr.write('[check-results-exit] No check-results.ndjson found — nothing to check\n');
  process.exit(0);
}

const lines  = fs.readFileSync(NDJSON_PATH, 'utf8').split('\n').filter(l => l.trim().length > 0);
const parsed = [];
for (const l of lines) {
  let rec;
  try { rec = JSON.parse(l); } catch { continue; }       // skip corrupt lines (fail-open)
  if (rec && typeof rec === 'object') parsed.push(rec);   // skip non-object records
}
const fails  = parsed.filter(r => r.result === 'fail' || r.result === 'error');

if (fails.length > 0) {
  process.stderr.write('[check-results-exit] ' + fails.length + ' fail(s) found:\n');
  for (const f of fails) {
    process.stderr.write('  tool=' + f.tool + ' formalism=' + f.formalism + ' ts=' + f.timestamp + '\n');
  }
  process.exit(1);
}

process.stdout.write('[check-results-exit] All ' + parsed.length + ' check(s) pass/warn/inconclusive.\n');
process.exit(0);
