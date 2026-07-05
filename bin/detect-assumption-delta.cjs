#!/usr/bin/env node
'use strict';

/**
 * bin/detect-assumption-delta.cjs — deterministic scope-drift scanner.
 *
 * Ported from open-gsd/gsd-core's assumption-delta capability (pure-function +
 * STDIN CLI, no framework coupling) and FUSED with nForma's formal layer: every
 * detected drift signal carries a suggested TLA+/Alloy invariant so the finding
 * routes straight into `nf:close-formal-gaps` instead of staying a prose note.
 *
 * Detects three abstraction-drift signals in phase-scope prose — a phase now
 * describes something PLURAL / OPTIONAL / CHOSEN that a formal model likely
 * treats as SINGULAR / REQUIRED / DERIVED:
 *   - pluralization  (one X → several X)      → model as a set/sequence, not a scalar
 *   - optional       (required → optional)    → domain must admit absence (∪ {NULL})
 *   - chosen         (derived → chosen/param)  → model as a CONSTANT with an ASSUME bound
 *
 * Exports: detectAssumptionDelta, suggestInvariant, DEFAULT_TERMS
 * CLI: echo "$PHASE_SECTION" | node bin/detect-assumption-delta.cjs [--json] [--terms csv]
 *      exit 0 = signal detected, 1 = none, 2 = startup error.
 */

// Curated cue vocabulary. Bare "or" is intentionally EXCLUDED from pluralization
// (prose-frequency false positives) — the cues name a *second/alternative* thing.
const DEFAULT_TERMS = {
  pluralization: ['second', 'another', 'additional', 'multiple', 'several', 'each',
    'alternative', 'fallback', 'per-', 'plural', 'list of', 'set of', 'array of'],
  optional: ['optional', 'optionally'],
  chosen: ['chosen', 'configurable', 'parameter', 'parameterize', 'parameterized',
    'tunable', 'per-project', 'per-user'],
};

const MAX_TERMS_PER_KIND = 64;
const MAX_TERM_LEN = 40;

function normalizeTerms(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase().slice(0, MAX_TERM_LEN);
    // Require at least one alphanumeric so punctuation-only "terms" (e.g. "-")
    // cannot match prose punctuation as a signal.
    if (!t || !/[a-z0-9]/.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TERMS_PER_KIND) break;
  }
  return out;
}

function resolveTerms(terms) {
  const merge = (key) => {
    const t = terms && terms[key];
    return Array.isArray(t) ? normalizeTerms(t) : [...DEFAULT_TERMS[key]];
  };
  return { pluralization: merge('pluralization'), optional: merge('optional'), chosen: merge('chosen') };
}

// Minimal CommonMark-ish fenced-code stripper (```…``` and ~~~…~~~), CRLF-safe —
// so a cue term inside a code snippet does not fire.
function stripFencedCode(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (m && line.trim().startsWith(fence[0])) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    out.push(line);
  }
  return out.join('\n');
}

function makeSnippet(line, term) {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 120) return cleaned;
  const idx = cleaned.toLowerCase().indexOf(term);
  const start = Math.max(0, idx - 50);
  return (start > 0 ? '…' : '') + cleaned.slice(start, start + 110) + '…';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Suggest a formal invariant for a drift signal — the nForma fusion.
 * @returns {{ kind, layer, hint, invariant_sketch }}
 */
function suggestInvariant(signal) {
  switch (signal.kind) {
    case 'pluralization':
      return {
        kind: 'pluralization', layer: 'multiplicity',
        hint: 'This entity became plural — a formal model treating it as a scalar is now wrong. Model it as a set/sequence and bound its cardinality.',
        invariant_sketch: 'TypeOK: the var must be a function/set domain (e.g. items \\in [Ids -> T]); add a Cardinality bound invariant.',
      };
    case 'optional':
      return {
        kind: 'optional', layer: 'nullability',
        hint: 'This field became optional — invariants must not assume it is always present.',
        invariant_sketch: 'Widen the domain to admit absence: x \\in T  →  x \\in T \\cup {NULL}; guard every read on x # NULL.',
      };
    case 'chosen':
      return {
        kind: 'chosen', layer: 'parameterization',
        hint: 'This value became a free choice — model it as a CONSTANT with an ASSUME bound, not a hardcoded literal.',
        invariant_sketch: 'Lift the literal to a CONSTANT C with ASSUME C \\in ValidRange; re-check invariants hold for all C in range.',
      };
    default:
      return { kind: signal.kind, layer: 'unknown', hint: '', invariant_sketch: '' };
  }
}

/**
 * Detect assumption-delta signals in phase-scope prose.
 * @param {string} text  Roadmap phase section / scope prose. Non-string → { detected:false }.
 * @param {object} [terms]  Optional per-kind vocabulary override.
 * @returns {{ detected, signals:Array<{kind,term,snippet,suggestion}>, terms }}
 */
function detectAssumptionDelta(text, terms) {
  const effective = resolveTerms(terms);
  if (typeof text !== 'string') return { detected: false, signals: [], terms: effective };
  const stripped = stripFencedCode(text);
  if (stripped.trim().length === 0) return { detected: false, signals: [], terms: effective };

  const signals = [];
  for (const kind of ['pluralization', 'optional', 'chosen']) {
    const cueTerms = effective[kind];
    if (cueTerms.length === 0) continue;
    // Word-boundary anchored, case-insensitive; interior-substring matches excluded.
    const escaped = cueTerms.map(escapeRegex).join('|');
    const pattern = new RegExp('(^|[^a-zA-Z0-9])(' + escaped + ')([^a-zA-Z0-9]|$)', 'gi');
    const seen = new Set();
    for (const line of stripped.split('\n')) {
      for (const m of line.matchAll(pattern)) {
        const matched = (m[2] || '').toLowerCase();
        if (!matched) continue;
        const key = kind + ':' + matched;
        if (seen.has(key)) continue;
        seen.add(key);
        const signal = { kind, term: matched, snippet: makeSnippet(line, matched) };
        signal.suggestion = suggestInvariant(signal);
        signals.push(signal);
      }
    }
  }
  return { detected: signals.length > 0, signals, terms: effective };
}

// ─── CLI ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  let termsOverride;
  const termsIdx = argv.indexOf('--terms');
  const termsVal = termsIdx !== -1 ? argv[termsIdx + 1] : undefined;
  if (typeof termsVal === 'string' && !termsVal.startsWith('-')) {
    const list = termsVal.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (list.length > 0) termsOverride = { pluralization: list };
  }
  const chunks = [];
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const result = detectAssumptionDelta(chunks.join(''), termsOverride);
    if (wantJson) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (result.detected) {
      process.stdout.write('Assumption-delta signals (' + result.signals.length + '):\n');
      for (const s of result.signals) {
        process.stdout.write('  [' + s.kind + '] "' + s.term + '" — ' + s.snippet + '\n');
        process.stdout.write('    → formal(' + s.suggestion.layer + '): ' + s.suggestion.invariant_sketch + '\n');
      }
    } else {
      process.stdout.write('No assumption-delta signals detected.\n');
    }
    process.exit(result.detected ? 0 : 1);
  });
  process.stdin.on('error', (err) => {
    process.stderr.write('ERROR: detect-assumption-delta.cjs stdin read failed: ' + err.message + '\n');
    process.exit(2);
  });
}

module.exports = { detectAssumptionDelta, suggestInvariant, DEFAULT_TERMS };
