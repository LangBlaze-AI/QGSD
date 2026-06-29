#!/usr/bin/env node
'use strict';
// bin/check-trace-schema-drift.cjs
// Detects when .planning/formal/trace/trace.schema.json is modified without co-modifying
// bin/validate-traces.cjs and at least one trace emitter file in the same commit.
//
// Exit code 0: no schema change, or schema changed atomically
// Exit code 1: schema drift detected (validator or emitter not updated)

const { execFileSync } = require('child_process');
const { writeCheckResult } = require('./write-check-result.cjs');
const { getRequirementIds } = require('./requirement-map.cjs');

const SCHEMA_FILE = '.planning/formal/trace/trace.schema.json';
const VALIDATOR_FILE = 'bin/validate-traces.cjs';

const KNOWN_EMITTERS = [
  'bin/validate-traces.cjs',
  'hooks/nf-stop.js',
  'hooks/nf-prompt.js',
  'hooks/dist/nf-stop.js',
  'hooks/dist/nf-prompt.js',
];

/**
 * Check whether the list of changed files represents a schema drift situation.
 *
 * @param {string[]} changedFiles  List of file paths changed in the current commit
 * @returns {{ status: 'pass'|'fail', reason: string, [key: string]: any }}
 */
function checkSchemaDrift(changedFiles) {
  const files = (Array.isArray(changedFiles) ? changedFiles : []).filter(f => typeof f === 'string');
  const hasSchemaChange = files.some(f =>
    f === SCHEMA_FILE || f.endsWith('/' + SCHEMA_FILE) || f.includes('trace.schema.json')
  );

  if (!hasSchemaChange) {
    return { status: 'pass', reason: 'no-schema-change' };
  }

  const validatorUpdated = files.some(f =>
    f === VALIDATOR_FILE || f.includes(VALIDATOR_FILE)
  );
  // Emitter check: at least one KNOWN_EMITTER changed (can include validate-traces.cjs,
  // but validator_updated alone does not satisfy emitter_updated — need a non-validator emitter
  // OR validate-traces.cjs satisfies both when it IS the emitter.
  // Per spec: atomic requires validator AND an emitter. validate-traces.cjs counts as emitter only
  // when a separate hook file (nf-stop.js, nf-prompt.js, etc.) is also present.
  const NON_VALIDATOR_EMITTERS = KNOWN_EMITTERS.filter(e => e !== VALIDATOR_FILE);
  const emitterUpdated = files.some(f =>
    NON_VALIDATOR_EMITTERS.some(emitter => f === emitter || f.includes(emitter))
  );

  if (validatorUpdated && emitterUpdated) {
    return { status: 'pass', reason: 'schema-change-atomic', files: files.length };
  }

  return {
    status: 'fail',
    reason: 'schema-drift-detected',
    schema_changed: true,
    validator_updated: validatorUpdated,
    emitter_updated: emitterUpdated,
    changed_files: files,
  };
}

if (require.main === module) {
  const _startMs = Date.now();
  try {
    const raw = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], { encoding: 'utf8' });
    const changedFiles = raw.split('\n').filter(f => f.trim().length > 0);
    const result = checkSchemaDrift(changedFiles);
    const _runtimeMs = Date.now() - _startMs;
    try {
      writeCheckResult({
        tool: 'check-trace-schema-drift',
        formalism: 'trace',
        result: result.status,
        check_id: 'ci:trace-schema-drift', surface: 'ci', property: 'Trace schema drift — no non-atomic conformance schema changes between commits',
        runtime_ms: _runtimeMs, summary: (result.status === 'pass' ? 'pass' : 'fail') + ': ci:trace-schema-drift in ' + _runtimeMs + 'ms', triage_tags: [],
        requirement_ids: getRequirementIds('ci:trace-schema-drift'),
        metadata: result,
      });
    } catch (e) {
      process.stderr.write('[check-trace-schema-drift] Warning: failed to write check result: ' + e.message + '\n');
    }
    process.exit(result.status === 'pass' ? 0 : 1);
  } catch (err) {
    const _runtimeMs = Date.now() - _startMs;
    const meta = { reason: 'git-error', error: err.message };
    try {
      writeCheckResult({ tool: 'check-trace-schema-drift', formalism: 'trace', result: 'error', check_id: 'ci:trace-schema-drift', surface: 'ci', property: 'Trace schema drift — no non-atomic conformance schema changes between commits', runtime_ms: _runtimeMs, summary: 'error: ci:trace-schema-drift (git error)', triage_tags: [], requirement_ids: getRequirementIds('ci:trace-schema-drift'), metadata: meta });
    } catch (_) { /* swallow */ }
    process.stderr.write('[check-trace-schema-drift] git error: ' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = { checkSchemaDrift, KNOWN_EMITTERS };
