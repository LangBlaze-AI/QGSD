#!/usr/bin/env node
'use strict';

/**
 * escalation-classifier.cjs — Haiku-based escalation classifier for oscillation breaker events.
 *
 * When the oscillation breaker fires (a layer transitions to blocked), this module
 * classifies the root cause as GENUINE_REGRESSION, MEASUREMENT_NOISE, or
 * INSUFFICIENT_EVIDENCE using Claude Haiku with structured context.
 *
 * Requirements: OSC-03
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { readTrendWindow } = require('./oscillation-detector.cjs');
const { LAYER_KEYS } = require('./layer-constants.cjs');

const TAG = '[escalation-classifier]';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_DIFF_CHARS = 2000;
const HAIKU_TIMEOUT_MS = 10000;

const VALID_CLASSIFICATIONS = ['GENUINE_REGRESSION', 'MEASUREMENT_NOISE', 'INSUFFICIENT_EVIDENCE'];

// ── Layer-to-File Mapping ────────────────────────────────────────────────────

const LAYER_FILE_MAP = {
  r_to_f: ['.planning/formal/requirements.json', 'bin/requirement-map.cjs'],
  f_to_t: ['.planning/formal/spec/', 'bin/formal-test-sync.cjs'],
  c_to_f: ['.planning/formal/check-results.ndjson', 'bin/run-formal-verify.cjs'],
  t_to_c: ['test/', 'bin/*.test.cjs'],
  f_to_c: ['.planning/formal/check-results.ndjson'],
  r_to_d: ['docs/', '.planning/formal/requirements.json'],
  d_to_c: ['docs/'],
  p_to_f: ['.planning/formal/debt.json'],
  l1_to_l3: ['.planning/formal/gates/gate-a-grounding.json', '.planning/formal/gates/gate-b-abstraction.json'],
  l3_to_tc: ['.planning/formal/gates/gate-c-validation.json'],
  per_model_gates: ['.planning/formal/gates/per-model-gates.json'],
  git_heatmap: ['.planning/formal/evidence/git-heatmap.json'],
};

// ── Git Diff Extraction ──────────────────────────────────────────────────────

/**
 * Extract recent git diff for files related to a layer.
 *
 * @param {string} layer - Layer key (e.g., 'r_to_f')
 * @param {string} root - Project root directory
 * @param {number} [commitCount=5] - Number of commits to look back
 * @returns {string} Truncated diff (max 2000 chars)
 */
function getLayerGitDiff(layer, root, commitCount) {
  const count = commitCount || 5;
  const paths = LAYER_FILE_MAP[layer];
  if (!paths || paths.length === 0) return '';

  try {
    const result = spawnSync('git', ['diff', `HEAD~${count}`, '--', ...paths], {
      cwd: root || process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
    });

    if (result.status !== 0 || result.error) return '';

    const diff = (result.stdout || '').trim();
    return diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)' : diff;
  } catch (_) {
    return '';
  }
}

// ── Prompt Construction ──────────────────────────────────────────────────────

/**
 * Build the classification prompt for Haiku.
 *
 * @param {Object} context
 * @param {string} context.layer - Layer name
 * @param {number[]} context.deltas - Recent residual deltas
 * @param {string} context.gitDiffSummary - Truncated git diff
 * @param {number} context.oscillationCount - Number of oscillations detected
 * @param {number} context.currentResidual - Current residual value
 * @param {number} context.previousResidual - Previous residual value
 * @returns {string} Prompt string
 */
function buildClassificationPrompt(context = {}) {
  const deltasStr = (Array.isArray(context.deltas) ? context.deltas : []).join(', ');

  return `You are an oscillation classifier for the nForma consistency solver.

A layer's oscillation breaker has fired. Classify the root cause.

Layer: ${context.layer}
Recent residual deltas: ${deltasStr}
Current residual: ${context.currentResidual}
Previous residual: ${context.previousResidual}
Oscillation count: ${context.oscillationCount}

Recent git changes affecting this layer:
${context.gitDiffSummary || '(no changes detected)'}

Classify as exactly one of:
- GENUINE_REGRESSION: The residual increase reflects real quality degradation (new bugs, removed tests, broken formal models)
- MEASUREMENT_NOISE: The increase is an artifact of measurement (new requirements added, scope growth, tooling changes)
- INSUFFICIENT_EVIDENCE: Cannot determine cause from available data (too few sessions, no relevant git changes)

Respond with a JSON object only:
{"classification": "GENUINE_REGRESSION|MEASUREMENT_NOISE|INSUFFICIENT_EVIDENCE", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;
}

// ── Response Parsing ─────────────────────────────────────────────────────────

/**
 * Parse classification response from Haiku.
 *
 * @param {string|null} responseText - Raw response text
 * @returns {{ classification: string, confidence: number, reasoning: string }}
 */
function parseClassificationResponse(responseText) {
  const fallback = {
    classification: 'INSUFFICIENT_EVIDENCE',
    confidence: 0,
    reasoning: 'Failed to parse classifier response',
  };

  if (!responseText) return fallback;

  try {
    // Strip markdown code fences if present
    let text = responseText.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== 'object') return fallback;

    const classification = VALID_CLASSIFICATIONS.includes(parsed.classification)
      ? parsed.classification
      : 'INSUFFICIENT_EVIDENCE';

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

    const reasoning = typeof parsed.reasoning === 'string'
      ? parsed.reasoning.slice(0, 500)
      : 'No reasoning provided';

    return { classification, confidence, reasoning };
  } catch (_) {
    return fallback;
  }
}

// ── Haiku API Call ───────────────────────────────────────────────────────────

/**
 * Call Claude Haiku via direct HTTPS (synchronous via child process).
 *
 * @param {string} prompt - Classification prompt
 * @returns {string|null} Response text or null on failure
 */
function callHaiku(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write(TAG + ' WARNING: ANTHROPIC_API_KEY not set, skipping Haiku classification\n');
    return null;
  }

  // Use a child process to make the async HTTPS call synchronously
  const script = `
    const https = require('https');
    const data = JSON.stringify({
      model: '${HAIKU_MODEL}',
      max_tokens: 256,
      temperature: 0,
      messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: ${HAIKU_TIMEOUT_MS},
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text = parsed.content && parsed.content[0] && parsed.content[0].text;
          process.stdout.write(text || '');
        } catch (e) {
          process.stderr.write('Parse error: ' + e.message);
          process.exit(1);
        }
      });
    });

    req.on('error', (e) => {
      process.stderr.write('Request error: ' + e.message);
      process.exit(1);
    });

    req.on('timeout', () => {
      req.destroy();
      process.stderr.write('Request timeout');
      process.exit(1);
    });

    req.write(data);
    req.end();
  `;

  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: HAIKU_TIMEOUT_MS + 2000,
      env: process.env,
    });

    if (result.status !== 0 || result.error) {
      process.stderr.write(TAG + ' WARNING: Haiku call failed: ' +
        (result.stderr || (result.error && result.error.message) || 'unknown error') + '\n');
      return null;
    }

    return result.stdout || null;
  } catch (e) {
    process.stderr.write(TAG + ' WARNING: Haiku call exception: ' + e.message + '\n');
    return null;
  }
}

// ── Newly Blocked Detection ──────────────────────────────────────────────────

/**
 * Detect layers that transitioned from blocked:false to blocked:true.
 *
 * @param {Object|null} prevLayers - Previous verdict layers object
 * @param {Object|null} currLayers - Current verdict layers object
 * @returns {string[]} Array of newly blocked layer names
 */
function detectNewlyBlocked(prevLayers, currLayers) {
  if (!currLayers || typeof currLayers !== 'object') return [];

  const result = [];
  for (const key of LAYER_KEYS) {
    const curr = currLayers[key];
    if (!curr || !curr.blocked) continue;

    const prev = prevLayers && prevLayers[key];
    const wasBlocked = prev && prev.blocked;

    if (!wasBlocked) {
      result.push(key);
    }
  }

  return result;
}

// ── Main Classification ──────────────────────────────────────────────────────

/**
 * Classify an escalation event for a blocked layer.
 *
 * @param {Object} options
 * @param {string} options.layer - Layer name
 * @param {string} [options.root] - Project root
 * @param {string} [options.trendPath] - Override trend file path
 * @param {string} [options.verdictsPath] - Override verdicts file path
 * @returns {Object} Classification result
 */
function classifyEscalation(options = {}) {
  const root = options.root || process.cwd();
  const formalDir = path.join(root, '.planning', 'formal');
  const trendPath = options.trendPath || path.join(formalDir, 'solve-trend.jsonl');
  const verdictsPath = options.verdictsPath || path.join(formalDir, 'oscillation-verdicts.json');

  const fallback = {
    layer: options.layer,
    classification: 'INSUFFICIENT_EVIDENCE',
    confidence: 0,
    reasoning: 'Haiku classifier unavailable',
    context: { deltas: [], gitDiffAvailable: false, oscillationCount: 0 },
  };

  // Read verdicts to get oscillation info
  let verdicts = {};
  try {
    if (fs.existsSync(verdictsPath)) {
      verdicts = JSON.parse(fs.readFileSync(verdictsPath, 'utf8')).layers || {};
    }
  } catch (_) { /* fail-open */ }

  const layerVerdict = verdicts[options.layer];
  if (!layerVerdict) return fallback;

  // Read trend window and extract deltas
  const entries = readTrendWindow(trendPath, 20);
  const series = entries
    .map(e => (e && e.per_layer && typeof e.per_layer[options.layer] === 'number') ? e.per_layer[options.layer] : null)
    .filter(v => v !== null);

  const deltas = [];
  for (let i = 1; i < series.length; i++) {
    deltas.push(series[i] - series[i - 1]);
  }

  // Get git diff for context
  const gitDiffSummary = getLayerGitDiff(options.layer, root, 5);

  // Build and send classification prompt
  const prompt = buildClassificationPrompt({
    layer: options.layer,
    deltas,
    gitDiffSummary,
    oscillationCount: layerVerdict.oscillation_count || 0,
    currentResidual: series.length > 0 ? series[series.length - 1] : 0,
    previousResidual: series.length > 1 ? series[series.length - 2] : 0,
  });

  const responseText = callHaiku(prompt);
  const parsed = parseClassificationResponse(responseText);

  return {
    layer: options.layer,
    classification: parsed.classification,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    context: {
      deltas,
      gitDiffAvailable: gitDiffSummary.length > 0,
      oscillationCount: layerVerdict.oscillation_count || 0,
    },
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  classifyEscalation,
  buildClassificationPrompt,
  parseClassificationResponse,
  detectNewlyBlocked,
  getLayerGitDiff,
};

// ── CLI Mode ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  let layer = null;
  let root = process.cwd();

  for (const arg of args) {
    if (arg.startsWith('--layer=')) layer = arg.slice('--layer='.length);
    if (arg.startsWith('--project-root=')) root = path.resolve(arg.slice('--project-root='.length));
  }

  if (!layer) {
    process.stderr.write('Usage: node escalation-classifier.cjs --layer=<layer> [--project-root=<path>]\n');
    process.exit(1);
  }

  const result = classifyEscalation({ layer, root });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
