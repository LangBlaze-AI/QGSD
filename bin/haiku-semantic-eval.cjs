#!/usr/bin/env node
'use strict';

/**
 * haiku-semantic-eval.cjs
 *
 * Evaluates candidate (model, requirement) pairs from candidates.json using
 * Claude Haiku for semantic match verdicts (yes/no/maybe).
 *
 * Usage:
 *   node bin/haiku-semantic-eval.cjs                  # evaluate unevaluated candidates
 *   node bin/haiku-semantic-eval.cjs --batch-size 5   # smaller batches
 *   node bin/haiku-semantic-eval.cjs --batch-delay-ms 10000  # longer delays
 *   node bin/haiku-semantic-eval.cjs --force           # re-evaluate all (ignore cache)
 *   node bin/haiku-semantic-eval.cjs --dry-run         # show what would be evaluated
 *
 * Requirements: SEM-02, SEM-05
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const FORMAL_DIR = path.join(process.cwd(), '.planning', 'formal');
const CANDIDATES_PATH = path.join(FORMAL_DIR, 'candidates.json');
const PROXIMITY_INDEX_PATH = path.join(FORMAL_DIR, 'proximity-index.json');

// ─────────────────────────────────────────────────────────────────────────────
// Raw HTTPS Haiku API helper (pattern from validate-requirements-haiku.cjs)
// ─────────────────────────────────────────────────────────────────────────────

function callHaikuAPI(apiKey, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429 || res.statusCode >= 500) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const text = ((parsed.content || [])[0] || {}).text || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Haiku response string into a verdict object.
 * Handles: raw JSON, markdown-fenced JSON, unparseable fallback.
 *
 * @param {string} text - Raw response text from Haiku
 * @returns {{ verdict: string, confidence: number, reasoning: string }}
 */
function parseHaikuResponse(text) {
  if (!text || typeof text !== 'string') {
    return { verdict: 'maybe', confidence: 0.0, reasoning: 'empty response' };
  }

  // Try 1: Direct JSON parse
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && parsed.verdict) {
      return {
        verdict: normalizeVerdict(parsed.verdict),
        confidence: clampConfidence(parsed.confidence),
        reasoning: parsed.reasoning || '',
      };
    }
  } catch { /* fall through */ }

  // Try 2: Extract from markdown fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && parsed.verdict) {
        return {
          verdict: normalizeVerdict(parsed.verdict),
          confidence: clampConfidence(parsed.confidence),
          reasoning: parsed.reasoning || '',
        };
      }
    } catch { /* fall through */ }
  }

  // Fallback: unparseable
  return { verdict: 'maybe', confidence: 0.0, reasoning: `unparseable: ${text.slice(0, 100)}` };
}

function clampConfidence(c) {
  if (typeof c !== 'number' || Number.isNaN(c)) return 0.5;
  return Math.max(0, Math.min(1, c));
}

function normalizeVerdict(v) {
  const s = String(v).toLowerCase().trim();
  if (s === 'yes') return 'yes';
  if (s === 'no') return 'no';
  return 'maybe';
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache check (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a candidate has a cached verdict that is still valid.
 *
 * @param {object} candidate - Candidate object from candidates.json
 * @returns {boolean} true if evaluation should be skipped
 */
function shouldSkipCached(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!candidate.verdict) return false;
  if (!candidate.evaluation_timestamp) return false;
  // Cached and proximity_score unchanged = skip
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch evaluation (exported for testability)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a batch of candidates against Haiku.
 *
 * @param {Array} candidates - Array of candidate objects to evaluate
 * @param {string} apiKey - Anthropic API key
 * @param {object} opts - { apiCall? } for test injection
 * @returns {Promise<Array>} Evaluated candidates with verdicts
 */
async function evaluateCandidatesBatch(candidates, apiKey, opts = {}) {
  const apiCall = opts.apiCall || callHaikuAPI;
  const results = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      results.push(candidate);
      continue;
    }
    const prompt = `You are evaluating whether a formal model semantically satisfies a requirement.
Model path: ${candidate.model}
Requirement ID: ${candidate.requirement}
Does this model address the intent of this requirement? Consider both direct coverage and transitive coverage through related models.
Respond ONLY with valid JSON: {"verdict":"yes"|"no"|"maybe","confidence":0.0-1.0,"reasoning":"..."}`;

    let retries = 0;
    const MAX_RETRIES = 3;
    let evaluated = false;

    while (retries < MAX_RETRIES && !evaluated) {
      try {
        const text = await apiCall(apiKey, prompt, 200);
        const parsed = parseHaikuResponse(text);
        candidate.verdict = parsed.verdict;
        candidate.confidence = parsed.confidence;
        candidate.reasoning = parsed.reasoning;
        candidate.evaluation_timestamp = new Date().toISOString();
        evaluated = true;
      } catch (err) {
        retries++;
        if (err.statusCode === 429 || (err.statusCode && err.statusCode >= 500)) {
          const delay = Math.pow(2, retries) * 1000; // 2s, 4s, 8s
          process.stderr.write(`[haiku-eval] WARN: HTTP ${err.statusCode} on ${candidate.model} <-> ${candidate.requirement}, retry ${retries}/${MAX_RETRIES} in ${delay}ms\n`);
          await sleep(delay);
        } else {
          process.stderr.write(`[haiku-eval] WARN: Error on ${candidate.model} <-> ${candidate.requirement}: ${err.message}, retry ${retries}/${MAX_RETRIES}\n`);
          await sleep(2000);
        }
      }
    }

    if (!evaluated) {
      process.stderr.write(`[haiku-eval] WARN: Skipping ${candidate.model} <-> ${candidate.requirement} after ${MAX_RETRIES} retries\n`);
      candidate.verdict = 'maybe';
      candidate.confidence = 0.0;
      candidate.reasoning = 'evaluation failed after retries';
      candidate.evaluation_timestamp = new Date().toISOString();
    }

    results.push(candidate);
  }

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { batchSize: 10, batchDelayMs: 5000, force: false, dryRun: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i].startsWith('--batch-size')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.batchSize = parseInt(val, 10);
    } else if (argv[i].startsWith('--batch-delay-ms')) {
      const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[++i];
      args.batchDelayMs = parseInt(val, 10);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage: node bin/haiku-semantic-eval.cjs [options]

Options:
  --batch-size <n>       Candidates per batch (default: 10)
  --batch-delay-ms <n>   Delay between batches in ms (default: 5000)
  --force                Re-evaluate all candidates (ignore cache)
  --dry-run              Show what would be evaluated without API calls
  --help                 Show this help message
`);
    process.exit(0);
  }

  // Validate API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('[haiku-eval] ERROR: ANTHROPIC_API_KEY environment variable not set\n');
    process.exit(1);
  }

  // Validate candidates.json exists
  if (!fs.existsSync(CANDIDATES_PATH)) {
    process.stderr.write('[haiku-eval] ERROR: candidates.json not found \u2014 run candidate-discovery first\n');
    process.exit(1);
  }

  // Load and validate
  const data = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));

  // Validate proximity_index_hash
  if (fs.existsSync(PROXIMITY_INDEX_PATH)) {
    const indexContent = fs.readFileSync(PROXIMITY_INDEX_PATH, 'utf8');
    const currentHash = crypto.createHash('sha256').update(indexContent).digest('hex').slice(0, 8);
    if (data.metadata.proximity_index_hash !== currentHash) {
      process.stderr.write(`[haiku-eval] ERROR: Graph changed (hash ${data.metadata.proximity_index_hash} != ${currentHash}); rerun candidate-discovery first\n`);
      process.exit(1);
    }
  }

  // Filter candidates to evaluate
  const toEvaluate = args.force
    ? data.candidates
    : data.candidates.filter(c => !shouldSkipCached(c));

  process.stderr.write(`[haiku-eval] ${data.candidates.length} total candidates, ${toEvaluate.length} to evaluate (${data.candidates.length - toEvaluate.length} cached)\n`);

  if (args.dryRun) {
    process.stderr.write('[haiku-eval] Dry run \u2014 would evaluate:\n');
    for (const c of toEvaluate) {
      process.stderr.write(`  ${c.model} <-> ${c.requirement} (score: ${c.proximity_score})\n`);
    }
    process.exit(0);
  }

  // Process in batches
  const batchCount = Math.ceil(toEvaluate.length / args.batchSize);
  for (let i = 0; i < batchCount; i++) {
    const batchStart = i * args.batchSize;
    const batch = toEvaluate.slice(batchStart, batchStart + args.batchSize);

    await evaluateCandidatesBatch(batch, apiKey);

    const yesCount = batch.filter(c => c.verdict === 'yes').length;
    const noCount = batch.filter(c => c.verdict === 'no').length;
    const maybeCount = batch.filter(c => c.verdict === 'maybe').length;
    process.stderr.write(`[haiku-eval] Batch ${i + 1}/${batchCount}: evaluated ${batch.length} candidates (${yesCount} yes, ${noCount} no, ${maybeCount} maybe)\n`);

    // Delay between batches (skip after last batch)
    if (i < batchCount - 1 && args.batchDelayMs > 0) {
      await sleep(args.batchDelayMs);
    }
  }

  // Write back
  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(data, null, 2) + '\n');
  process.stderr.write(`[haiku-eval] Written updated candidates to: ${CANDIDATES_PATH}\n`);

  // Summary
  const yesTotal = data.candidates.filter(c => c.verdict === 'yes').length;
  const noTotal = data.candidates.filter(c => c.verdict === 'no').length;
  const maybeTotal = data.candidates.filter(c => c.verdict === 'maybe').length;
  process.stderr.write(`[haiku-eval] Final: ${yesTotal} yes, ${noTotal} no, ${maybeTotal} maybe out of ${data.candidates.length} candidates\n`);
}

if (require.main === module) {
  main();
}

module.exports = { parseHaikuResponse, evaluateCandidatesBatch, shouldSkipCached };
