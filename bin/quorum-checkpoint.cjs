#!/usr/bin/env node
'use strict';

/**
 * quorum-checkpoint.cjs — Structured FALLBACK-01 checkpoint writer + validator.
 *
 * Replaces the fragile HTML-comment `<!-- FALLBACK_CHECKPOINT -->` transcript
 * marker (issue #172). The orchestrator running `/nf:quorum` invokes this script
 * after handling UNAVAIL slots; it writes a schema-validated JSON file to
 * `.planning/quorum/checkpoints/round-<N>.json`. The Stop hook (`nf-stop.js`)
 * reads and validates that file instead of regex-parsing the transcript, so
 * LLM stylistic variation (code fences, whitespace, array notation) can no
 * longer bypass or trigger the FALLBACK-01 gate.
 *
 * The HTML comment is still rendered to stdout for human readability in the
 * transcript — but it is generated deterministically from the structured data,
 * not authored free-hand, and it is no longer the gating mechanism.
 *
 * Dual use:
 *   - CLI:    node quorum-checkpoint.cjs --round 1 --fallback-dispatched true ...
 *   - module: require('./quorum-checkpoint.cjs') → { validateCheckpoint, ... }
 *
 * Exit codes (CLI): 0 = checkpoint written, 1 = bad args / schema validation
 * failure (the file is NOT written when validation fails — malformed
 * checkpoints never reach disk).
 */

const fs   = require('node:fs');
const path = require('node:path');

const CHECKPOINT_SCHEMA_VERSION = 1;

// JSON Schema (draft-07 subset) — single source of truth for the checkpoint
// shape. Enforced by validateCheckpoint() on both the write path (this script)
// and the read path (nf-stop.js), so writer and reader can never drift.
const CHECKPOINT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'FALLBACK-01 quorum checkpoint',
  type: 'object',
  additionalProperties: false,
  required: [
    'round', 'unavail_primaries', 'fallback_dispatched', 't1_slots_tried',
    't2_slots_tried', 'all_tiers_exhausted', 'proceed_reason', 'timestamp',
    'schema_version',
  ],
  properties: {
    round:               { type: 'integer', minimum: 1 },
    unavail_primaries:   { type: 'array', items: { type: 'string' } },
    fallback_dispatched: { type: 'boolean' },
    t1_slots_tried:      { type: 'array', items: { type: 'string' } },
    t2_slots_tried:      { type: 'array', items: { type: 'string' } },
    all_tiers_exhausted: { type: 'boolean' },
    proceed_reason:      { type: 'string', minLength: 1 },
    timestamp:           { type: 'string', minLength: 1, format: 'date-time' },
    schema_version:      { type: 'integer', enum: [CHECKPOINT_SCHEMA_VERSION] },
  },
};

// ─── Minimal JSON Schema validator ───────────────────────────────────────────
// Supports only the keywords used by CHECKPOINT_SCHEMA (type, required,
// properties, additionalProperties:false, items, minimum, minLength, enum).
// Kept dependency-free on purpose — bin scripts loaded by hooks must not pull
// in npm packages.
function validateAgainstSchema(value, schema, p) {
  const errors = [];
  const label = p || '(root)';
  const typeOf = (v) => Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);

  if (schema.type) {
    const actual = typeOf(value);
    if (schema.type === 'integer') {
      if (actual !== 'number' || !Number.isInteger(value)) {
        errors.push(`${label}: expected integer, got ${actual}`);
        return errors;
      }
    } else if (actual !== schema.type) {
      errors.push(`${label}: expected ${schema.type}, got ${actual}`);
      return errors; // wrong type — deeper checks would be noise
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${label}: value ${JSON.stringify(value)} not in allowed set`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${label}: ${value} is below minimum ${schema.minimum}`);
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${label}: string shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'string' && schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
    errors.push(`${label}: must be a valid ISO-8601 date-time`);
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of (schema.required || [])) {
      if (!(req in value)) errors.push(`${label}: missing required field "${req}"`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) errors.push(`${label}: unexpected field "${k}"`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) {
          errors.push(...validateAgainstSchema(value[k], sub, p ? `${p}.${k}` : k));
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, schema.items, `${label}[${i}]`));
    });
  }

  return errors;
}

/**
 * Validate a checkpoint object against CHECKPOINT_SCHEMA.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateCheckpoint(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['checkpoint must be a JSON object'] };
  }
  const errors = validateAgainstSchema(obj, CHECKPOINT_SCHEMA, '');
  return { valid: errors.length === 0, errors };
}

/**
 * Whether a (valid) checkpoint satisfies FALLBACK-01 — i.e. it is safe to
 * proceed to consensus. True when fallback slots were dispatched OR every
 * tier was exhausted. The Stop hook gates on exactly this predicate.
 */
function checkpointSatisfiesFallback(cp) {
  if (cp === null || typeof cp !== 'object') return false;
  return cp.fallback_dispatched === true || cp.all_tiers_exhausted === true;
}

/** Build a normalized checkpoint object (timestamp + schema_version filled in). */
function buildCheckpoint(opts) {
  return {
    round:               opts.round,
    unavail_primaries:   opts.unavailPrimaries   || [],
    fallback_dispatched: opts.fallbackDispatched === true,
    t1_slots_tried:      opts.t1SlotsTried       || [],
    t2_slots_tried:      opts.t2SlotsTried       || [],
    all_tiers_exhausted: opts.allTiersExhausted  === true,
    proceed_reason:      opts.proceedReason      || '',
    timestamp:           opts.timestamp          || new Date().toISOString(),
    schema_version:      CHECKPOINT_SCHEMA_VERSION,
  };
}

/** Absolute path of the checkpoint file for a given round. */
function checkpointPath(root, round) {
  return path.join(root, '.planning', 'quorum', 'checkpoints', `round-${round}.json`);
}

/**
 * Validate then write a checkpoint to disk. Throws (without writing) if the
 * checkpoint fails schema validation — malformed checkpoints never reach disk.
 * @returns {string} the file path written
 */
function writeCheckpoint(root, checkpoint) {
  const { valid, errors } = validateCheckpoint(checkpoint);
  if (!valid) {
    const err = new Error('checkpoint failed schema validation: ' + errors.join('; '));
    err.validationErrors = errors;
    throw err;
  }
  const dest = checkpointPath(root, checkpoint.round);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8');
  return dest;
}

/**
 * Read + validate the checkpoint file for a round.
 * @returns {{ exists, valid, satisfied, errors, checkpoint, path }}
 *   satisfied is only meaningful when valid is true.
 */
function readCheckpoint(root, round) {
  const p = checkpointPath(root, round);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return { exists: false, valid: false, satisfied: false, errors: ['checkpoint file not found'], checkpoint: null, path: p };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { exists: true, valid: false, satisfied: false, errors: ['invalid JSON: ' + e.message], checkpoint: null, path: p };
  }
  const { valid, errors } = validateCheckpoint(obj);
  return {
    exists: true,
    valid,
    satisfied: valid && checkpointSatisfiesFallback(obj),
    errors,
    checkpoint: valid ? obj : null,
    path: p,
  };
}

/** Render the human-readable HTML comment (backwards-compat transcript marker). */
function renderHtmlComment(cp) {
  const fmt = (arr) => (arr && arr.length) ? arr.join(', ') : 'none';
  return [
    '<!-- FALLBACK_CHECKPOINT',
    `  round: ${cp.round}`,
    `  unavail_primaries: [${fmt(cp.unavail_primaries)}]`,
    `  fallback_dispatched: ${cp.fallback_dispatched}`,
    `  t1_slots_tried: [${fmt(cp.t1_slots_tried)}]`,
    `  t2_slots_tried: [${fmt(cp.t2_slots_tried)}]`,
    `  all_tiers_exhausted: ${cp.all_tiers_exhausted}`,
    `  proceed_reason: ${cp.proceed_reason}`,
    '-->',
  ].join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

// Tokens that mean "empty list" in the slot-list flags — the orchestrator may
// pass any of these instead of an actual comma-separated list.
const EMPTY_LIST_TOKENS = new Set(['none', 'empty-pool', 'empty pool', 'not-needed', 'not needed', 'n/a', '-', '']);

function parseList(s) {
  if (s === undefined || s === null) return [];
  if (EMPTY_LIST_TOKENS.has(String(s).trim().toLowerCase())) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && !EMPTY_LIST_TOKENS.has(x.toLowerCase()));
}

function parseBool(s, flag) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw new Error(`--${flag} must be "true" or "false" (got ${JSON.stringify(s)})`);
}

// Parse argv into a flag map. Supports `--key value` and `--key=value`.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      args[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[tok.slice(2)] = 'true'; // bare flag
      } else {
        args[tok.slice(2)] = next;
        i++;
      }
    }
  }
  return args;
}

function cli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write('[quorum-checkpoint] ' + e.message + '\n');
    return 1;
  }

  // Required flags
  const missing = ['round', 'fallback-dispatched', 'all-tiers-exhausted', 'proceed-reason']
    .filter((f) => args[f] === undefined);
  if (missing.length > 0) {
    process.stderr.write('[quorum-checkpoint] missing required flag(s): ' + missing.map((f) => '--' + f).join(', ') + '\n');
    return 1;
  }

  const round = parseInt(args.round, 10);
  if (!Number.isInteger(round) || round < 1) {
    process.stderr.write('[quorum-checkpoint] --round must be a positive integer (got ' + JSON.stringify(args.round) + ')\n');
    return 1;
  }

  let checkpoint;
  try {
    checkpoint = buildCheckpoint({
      round,
      unavailPrimaries:   parseList(args['unavail-primaries']),
      fallbackDispatched: parseBool(args['fallback-dispatched'], 'fallback-dispatched'),
      t1SlotsTried:       parseList(args['t1-slots']),
      t2SlotsTried:       parseList(args['t2-slots']),
      allTiersExhausted:  parseBool(args['all-tiers-exhausted'], 'all-tiers-exhausted'),
      proceedReason:      String(args['proceed-reason']),
    });
  } catch (e) {
    process.stderr.write('[quorum-checkpoint] ' + e.message + '\n');
    return 1;
  }

  const root = args.cwd ? path.resolve(args.cwd) : process.cwd();

  let dest;
  try {
    dest = writeCheckpoint(root, checkpoint);
  } catch (e) {
    process.stderr.write('[quorum-checkpoint] ' + e.message + '\n');
    return 1;
  }

  // stdout: the human-readable HTML comment (transcript marker) + confirmation.
  process.stdout.write(renderHtmlComment(checkpoint) + '\n');
  process.stdout.write('FALLBACK-01 checkpoint written: ' + dest + '\n');
  if (checkpoint.unavail_primaries.length > 0 &&
      !checkpoint.fallback_dispatched && !checkpoint.all_tiers_exhausted) {
    process.stdout.write(
      'WARNING: unavail_primaries present but fallback not dispatched and tiers not ' +
      'exhausted — dispatch T1/T2 fallback Tasks before evaluating consensus.\n');
  }
  return 0;
}

module.exports = {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_SCHEMA_VERSION,
  validateCheckpoint,
  checkpointSatisfiesFallback,
  buildCheckpoint,
  checkpointPath,
  writeCheckpoint,
  readCheckpoint,
  renderHtmlComment,
  parseList,
  parseBool,
};

if (require.main === module) {
  process.exit(cli(process.argv.slice(2)));
}
