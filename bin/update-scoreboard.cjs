#!/usr/bin/env node
'use strict';

/**
 * update-scoreboard.cjs
 *
 * CLI script to update .planning/quorum-scoreboard.json atomically.
 * Reads current JSON, applies score delta for one model/round, recalculates
 * all cumulative stats from scratch, writes back.
 *
 * Usage (round vote):
 *   node bin/update-scoreboard.cjs \
 *     --model <name> --result <code> --task <label> --round <n> --verdict <v> \
 *     [--scoreboard <path>] [--category <cat>] [--subcategory <subcat>] \
 *     [--task-description <text>]
 *
 * Usage (team identity — once per session):
 *   node bin/update-scoreboard.cjs init-team \
 *     --claude-model <model-id> \
 *     --team '<json-object-of-agent-identities>' \
 *     [--scoreboard <path>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const https = require('https');

// ---------------------------------------------------------------------------
// Score delta lookup
// ---------------------------------------------------------------------------

const DEFAULT_SCORE_DELTAS = {
  TP:      1,
  TN:      5,
  FP:     -3,
  FN:     -1,
  'TP+':   3,   // +1 TP effectiveness + +2 improvement bonus
  'TN+':   7,   // +5 TN effectiveness + +2 constructive alternative adopted
  UNAVAIL: 0,
  '':      0,
};

/**
 * Load calibrated deltas from config file if available.
 * Falls back to DEFAULT_SCORE_DELTAS if no config or invalid config.
 */
function loadScoreDeltas() {
  try {
    const pp = require('./planning-paths.cjs');
    const configPath = pp.resolveWithFallback(process.cwd(), 'calibrated-deltas');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.deltas && typeof parsed.deltas === 'object') {
        const required = ['TP', 'TN', 'FP', 'FN', 'TP+', 'TN+', 'UNAVAIL', ''];
        const allPresent = required.every(k => typeof parsed.deltas[k] === 'number');
        if (allPresent) {
          return { deltas: parsed.deltas, source: 'calibrated' };
        }
      }
    }
  } catch (_) {
    // Any error — fail-open to defaults
  }
  return { deltas: DEFAULT_SCORE_DELTAS, source: 'default' };
}

const VALID_MODELS   = ['claude', 'gemini', 'opencode', 'copilot', 'codex', 'antigravity', 'deepseek', 'minimax', 'qwen-coder', 'kimi', 'llama4'];
const VALID_RESULTS  = ['TP', 'TN', 'FP', 'FN', 'TP+', 'TN+', 'UNAVAIL', ''];
const VALID_VERDICTS = ['APPROVE', 'BLOCK', 'DELIBERATE', 'CONSENSUS', 'GAPS_FOUND', '—'];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
        ? argv[++i]
        : '';
      args[name] = value;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Default scoreboard path helper
// ---------------------------------------------------------------------------
function defaultScoreboardPath() {
  try {
    return require('./planning-paths.cjs').resolveWithFallback(process.cwd(), 'quorum-scoreboard');
  } catch (_) {
    return '.planning/quorum-scoreboard.json';
  }
}

// ---------------------------------------------------------------------------
// Usage / validation
// ---------------------------------------------------------------------------

const USAGE = `Usage: node bin/update-scoreboard.cjs --model <name> --result <code> --task <label> --round <n> --verdict <v> [--scoreboard <path>] [--category <cat>] [--subcategory <subcat>] [--task-description <text>]
  --model             claude | gemini | opencode | copilot | codex
  --result            TP | TN | FP | FN | TP+ | TN+ | (empty for not scored)
  --task              task label, e.g. "quick-25"
  --round             round number (integer)
  --verdict           APPROVE | BLOCK | DELIBERATE | CONSENSUS | GAPS_FOUND | —
  --category          (optional) explicit parent category name
  --subcategory       (optional) explicit subcategory name
  --task-description  (optional) debate question/topic text; used by Haiku auto-classification when --category/--subcategory omitted
  --slot              slot name (e.g. claude-1) — use instead of --model for MCP server instances
  --model-id          full model id from health_check (e.g. "deepseek-ai/DeepSeek-V3") — required with --slot`;

function validate(args) {
  const errors = [];

  // --slot and --model are mutually exclusive
  if (args.slot && args.model) {
    errors.push('--slot and --model are mutually exclusive');
  } else if (args.slot) {
    // Slot mode: require --model-id
    if (!args['model-id']) errors.push('--model-id is required when using --slot');
  } else {
    // Model mode: require --model
    if (!args.model)   errors.push('--model is required');
  }
  if (!args.task)    errors.push('--task is required');
  if (!args.round)   errors.push('--round is required');
  if (!args.verdict) errors.push('--verdict is required');
  // --result can be empty string (not scored), but must be present as key
  if (!('result' in args)) errors.push('--result is required (use empty string for not scored)');

  if (args.model && !VALID_MODELS.includes(args.model)) {
    errors.push(`--model must be one of: ${VALID_MODELS.join(', ')}`);
  }

  // VALID_VERDICTS was declared but never enforced — an invalid verdict was silently
  // accepted (dogfood), so a typo'd/wrong-cased verdict polluted the scoreboard.
  if (args.verdict && !VALID_VERDICTS.includes(args.verdict)) {
    errors.push(`--verdict must be one of: ${VALID_VERDICTS.join(', ')}`);
  }

  const result = args.result || '';
  if (!VALID_RESULTS.includes(result)) {
    errors.push(`--result must be one of: TP, TN, FP, FN, TP+, TN+, (empty)`);
  }

  const roundNum = parseInt(args.round, 10);
  if (isNaN(roundNum) || roundNum < 1) {
    errors.push('--round must be a positive integer');
  }

  if (errors.length > 0) {
    process.stderr.write(USAGE + '\n\nErrors:\n' + errors.map(e => '  ' + e).join('\n') + '\n');
    process.exit(1);
  }

  return {
    model:           args.model,
    slot:            args.slot            || null,
    modelId:         args['model-id']     || null,
    result:          result,
    task:            args.task,
    round:           roundNum,
    verdict:         args.verdict,
    scoreboard:      args.scoreboard || defaultScoreboardPath(),
    category:        args.category        || null,
    subcategory:     args.subcategory     || null,
    taskDescription: args['task-description'] || null,
  };
}

// ---------------------------------------------------------------------------
// JSON schema helpers
// ---------------------------------------------------------------------------

function emptyModelStats() {
  return { score: 0, tp: 0, tn: 0, fp: 0, fn: 0, impr: 0, invocations: 0 };
}

function emptyData() {
  return {
    models: {
      claude:      emptyModelStats(),
      gemini:      emptyModelStats(),
      opencode:    emptyModelStats(),
      copilot:     emptyModelStats(),
      codex:       emptyModelStats(),
      deepseek:    emptyModelStats(),
      minimax:     emptyModelStats(),
      'qwen-coder': emptyModelStats(),
      kimi:        emptyModelStats(),
      llama4:      emptyModelStats(),
    },
    slots: {},        // slot-keyed map; key = '<slot-name>:<model-id>'
    categories: {},
    rounds: [],
    availability: {}, // per-slot availability windows: { slotOrModel: { available_at_iso, ... } }
    delivery_stats: {
      total_rounds: 0,
      target_vote_count: 3,
      achieved_by_outcome: {},
    },
  };
}

function loadData(scoreboard) {
  const absPath = path.resolve(process.cwd(), scoreboard);
  if (!fs.existsSync(absPath)) {
    return emptyData();
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Normalize against the canonical shape. A valid-JSON but partial / wrong-shape
    // scoreboard ({}, a missing `models`/`rounds`, a non-array `rounds`, or a null round
    // entry) must DEGRADE to a usable structure — otherwise the record path crashes on
    // `data.models[model]` / `findIndex(r => r.task)` (exit 1, vote silently lost, file
    // left corrupt) and recompute throws. The old backward-compat block only restored 3
    // of 5 top-level fields and never sanitised individual rounds.
    const base = emptyData();
    // A plain object, not an array — `typeof [] === 'object'`, so an array-shaped field
    // (e.g. `"models": []`) must NOT pass as an object: the record path would then assign
    // `array.claude = {...}` (a non-index prop) and JSON.stringify drops it → stats
    // silently lost on write. Exclude arrays for every object-typed field, as for `rounds`.
    const notObj = (x) => !x || typeof x !== 'object' || Array.isArray(x);
    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    if (notObj(data.models))         data.models = base.models;
    if (notObj(data.slots))          data.slots = {};
    if (notObj(data.categories))     data.categories = {};
    if (notObj(data.availability))   data.availability = {};
    if (notObj(data.delivery_stats)) data.delivery_stats = base.delivery_stats;
    // rounds must be an array of objects — drop null/non-object entries so one corrupt
    // round can't poison every future findIndex(r => r.task) / recompute.
    data.rounds = Array.isArray(data.rounds) ? data.rounds.filter(r => r && typeof r === 'object') : [];
    return data;
  } catch (e) {
    process.stderr.write(`[update-scoreboard] WARNING: could not parse ${absPath}: ${e.message}\n`);
    return emptyData();
  }
}

// ---------------------------------------------------------------------------
// Cumulative stats recompute (from-scratch to avoid drift)
// ---------------------------------------------------------------------------

function recomputeStats(data, deltas) {
  deltas = deltas || DEFAULT_SCORE_DELTAS;
  // Reset all model stats
  for (const model of VALID_MODELS) {
    if (!data.models[model]) data.models[model] = emptyModelStats();
    const m = data.models[model];
    m.score = 0;
    m.tp    = 0;
    m.tn    = 0;
    m.fp    = 0;
    m.fn    = 0;
    m.impr  = 0;
    m.invocations = 0;
  }

  for (const round of data.rounds) {
    const votes = round.votes || {};
    for (const model of VALID_MODELS) {
      const vote = votes[model];
      if (!vote || vote === '' || vote === 'UNAVAIL') continue;

      const m = data.models[model];
      m.invocations += 1;

      const delta = deltas[vote];
      if (delta === undefined) continue; // unknown vote code — skip

      m.score += delta;

      if (vote === 'TP' || vote === 'TP+')  m.tp   += 1;
      if (vote === 'TN' || vote === 'TN+')  m.tn   += 1;
      if (vote === 'FP')                    m.fp   += 1;
      if (vote === 'FN')                    m.fn   += 1;
      if (vote === 'TP+' || vote === 'TN+') m.impr += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Slot-keyed stats helpers
// ---------------------------------------------------------------------------

function emptySlotStats(slot, modelId) {
  return { slot, model: modelId, score: 0, tp: 0, tn: 0, fp: 0, fn: 0, impr: 0, invocations: 0 };
}

function recomputeSlots(data, deltas) {
  deltas = deltas || DEFAULT_SCORE_DELTAS;
  // Reset all slot stats in data.slots
  for (const key of Object.keys(data.slots)) {
    const s = data.slots[key];
    s.score = 0; s.tp = 0; s.tn = 0; s.fp = 0; s.fn = 0; s.impr = 0; s.invocations = 0;
  }
  // Replay all rounds — look for votes keyed by composite slot:model-id keys
  for (const round of data.rounds) {
    const votes = round.votes || {};
    for (const [key, vote] of Object.entries(votes)) {
      if (!key.includes(':')) continue;  // slot keys contain ':'
      if (!vote || vote === '' || vote === 'UNAVAIL') continue;
      if (!data.slots[key]) continue;  // key not in slots map — skip
      const s = data.slots[key];
      s.invocations += 1;
      const delta = deltas[vote];
      if (delta === undefined) continue;
      s.score += delta;
      if (vote === 'TP' || vote === 'TP+')  s.tp   += 1;
      if (vote === 'TN' || vote === 'TN+')  s.tn   += 1;
      if (vote === 'FP')  s.fp += 1;
      if (vote === 'FN')  s.fn += 1;
      if (vote === 'TP+' || vote === 'TN+') s.impr += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Delivery stats computation
// ---------------------------------------------------------------------------

/**
 * Compute delivery statistics from rounds data.
 * Counts how many rounds achieved each vote count and calculates percentages.
 * Stores result in data.delivery_stats.
 */
function computeDeliveryStats(data) {
  try {
    if (!data.rounds || data.rounds.length === 0) {
      data.delivery_stats = {
        total_rounds: 0,
        target_vote_count: 3,
        achieved_by_outcome: {},
      };
      return data;
    }

    // Helper to count valid votes in a round
    function countValidVotes(votes) {
      let count = 0;
      for (const key of Object.keys(votes)) {
        const v = votes[key];
        if (v && v !== '' && v !== 'UNAVAIL' && v !== 'TIMEOUT') count++;
      }
      return count;
    }

    // Tally vote counts across all rounds
    const voteCountHistogram = {};
    for (const round of data.rounds) {
      const voteCount = countValidVotes(round.votes || {});
      const key = voteCount + '_votes';
      voteCountHistogram[key] = (voteCountHistogram[key] || 0) + 1;
    }

    // Compute percentages
    const totalRounds = data.rounds.length;
    const achievedByOutcome = {};
    for (const [key, count] of Object.entries(voteCountHistogram)) {
      const pct = parseFloat(((count / totalRounds) * 100).toFixed(1));
      achievedByOutcome[key] = { count, pct };
    }

    data.delivery_stats = {
      total_rounds: totalRounds,
      target_vote_count: 3,
      achieved_by_outcome: achievedByOutcome,
    };

    return data;
  } catch (e) {
    process.stderr.write(`[computeDeliveryStats] ERROR: ${e.message}\n`);
    return data;
  }
}

// ---------------------------------------------------------------------------
// Flakiness scoring
// ---------------------------------------------------------------------------

/**
 * Compute per-slot flakiness scores from recent verdicts.
 * Flakiness = failure rate in trailing 10-round window.
 * Stores result in data.slots[key].flakiness_score and recent_verdicts.
 */
function computeFlakiness(data, windowSize = 10) {
  try {
    if (!data.rounds || data.rounds.length === 0) {
      // No rounds yet — all slots have default score 0.0
      return data;
    }

    // Collect all unique slot names from all rounds
    const allSlots = new Set();
    for (const round of data.rounds) {
      const votes = round.votes || {};
      for (const key of Object.keys(votes)) {
        // Handle both model-keyed (e.g., 'claude') and slot-keyed (e.g., 'gemini-1:model-id')
        if (key.includes(':')) {
          // Slot-keyed: extract slot name (before ':')
          const slotName = key.split(':')[0];
          allSlots.add(slotName);
        } else {
          // Model-keyed: use model name as slot key
          allSlots.add(key);
        }
      }
    }

    // For each slot, compute flakiness from trailing window
    for (const slotName of allSlots) {
      // Collect all verdicts for this slot from data.rounds
      const verdictWindow = [];
      for (const round of data.rounds) {
        const votes = round.votes || {};
        // Look for any vote entry matching this slot
        let verdict = null;
        for (const [key, voteValue] of Object.entries(votes)) {
          const keySlotName = key.includes(':') ? key.split(':')[0] : key;
          if (keySlotName === slotName) {
            // Count as failure: UNAVAIL, TIMEOUT, empty string, or any other falsy value
            if (voteValue === 'UNAVAIL' || voteValue === 'TIMEOUT' || voteValue === '' || !voteValue) {
              verdict = 'FAILED';
            } else {
              // Success (any other value including verdict names)
              verdict = 'SUCCESS';
            }
            break;
          }
        }
        if (verdict) {
          verdictWindow.push({
            round_num: round.round || verdictWindow.length + 1,
            verdict,
          });
        }
      }

      // Use trailing window
      const window = verdictWindow.slice(-windowSize);
      if (window.length === 0) {
        // No verdicts for this slot — default to 0.0 (reliable)
        // Ensure slot entry exists
        for (const [key, slotEntry] of Object.entries(data.slots)) {
          const keySlotName = key.split(':')[0];
          if (keySlotName === slotName && !slotEntry.flakiness_score) {
            slotEntry.flakiness_score = 0.0;
            slotEntry.recent_verdicts = [];
          }
        }
        continue;
      }

      // Count failures in window
      const failures = window.filter(v => v.verdict === 'FAILED').length;
      const flakinessScore = failures / window.length;
      const score = parseFloat(flakinessScore.toFixed(2)); // Store as number

      // Store flakiness in all slot entries matching this slot name
      for (const [key, slotEntry] of Object.entries(data.slots)) {
        const keySlotName = key.split(':')[0];
        if (keySlotName === slotName) {
          slotEntry.flakiness_score = score;
          slotEntry.recent_verdicts = window;
        }
      }
    }

    return data;
  } catch (e) {
    process.stderr.write(`[computeFlakiness] ERROR: ${e.message}\n`);
    return data;
  }
}

// ---------------------------------------------------------------------------
// Today's date in MM-DD format
// ---------------------------------------------------------------------------

function todayMMDD() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Haiku auto-classification
// ---------------------------------------------------------------------------

/**
 * Attempt to classify a task description using claude-haiku-4-5-20251001.
 * Returns { category, subcategory, is_new } or null on any failure (fail-open).
 */
async function classifyWithHaiku(taskDescription, categories) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // No API key — skip silently (fail-open)

  try {
    // Build formatted taxonomy list for prompt
    const taxonomyLines = Object.entries(categories).map(([cat, subs]) => {
      const subsStr = subs.map(s => `    - ${s}`).join('\n');
      return `  ${cat}:\n${subsStr}`;
    }).join('\n');

    const prompt = `You are classifying a quorum debate topic into a category taxonomy.

Debate topic: ${taskDescription}

Taxonomy:
${taxonomyLines}

Return ONLY valid JSON (no markdown, no explanation):
{"category": "<parent category name>", "subcategory": "<subcategory name>", "is_new": false}

If the topic does not match any existing category or subcategory well, propose new names:
{"category": "<new parent name>", "subcategory": "<new subcategory name>", "is_new": true}

Choose the single best match. Return nothing except the JSON object.`;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = await new Promise((resolve, reject) => {
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
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const content = ((parsed.content || [])[0] || {}).text || '';
            resolve(content.trim());
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

    if (!text) return null;

    const result = JSON.parse(text);
    if (typeof result.category !== 'string' || typeof result.subcategory !== 'string') {
      return null;
    }
    return result;
  } catch (_) {
    return null; // any error — fail-open
  }
}

// ---------------------------------------------------------------------------
// init-team: capture team fingerprint (idempotent — skips if unchanged)
// ---------------------------------------------------------------------------

async function initTeam(argv) {
  const args = parseArgs(argv);
  const scoreboardPath = args.scoreboard || defaultScoreboardPath();
  const claudeModel = args['claude-model'] || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'unknown';

  // Parse agent identities from --team JSON
  let agents = {};
  if (args.team) {
    try {
      agents = JSON.parse(args.team);
    } catch (e) {
      process.stderr.write(`[init-team] WARNING: could not parse --team JSON: ${e.message}\n`);
    }
  }

  // Auto-detect MCPs and plugins from ~/.claude.json
  let mcps = [];
  let plugins = [];
  try {
    const claudeJsonPath = process.env.NF_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    mcps = Object.keys(claudeJson.mcpServers || {});
    plugins = claudeJson.plugins || [];
  } catch (e) {
    process.stderr.write(`[init-team] WARNING: could not read ~/.claude.json: ${e.message}\n`);
  }

  // Compute fingerprint from canonical team composition
  const canonical = JSON.stringify({
    claude_model: claudeModel,
    agents: Object.fromEntries(Object.entries(agents).sort()),
    mcps: [...mcps].sort(),
    plugins: [...plugins].sort(),
  });
  const fingerprint = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);

  const data = loadData(scoreboardPath);

  // Skip if fingerprint unchanged
  if (data.team && data.team.fingerprint === fingerprint) {
    process.stdout.write(`[init-team] fingerprint: ${fingerprint} | no change\n`);
    return;
  }

  const prevFingerprint = data.team ? data.team.fingerprint : null;

  data.team = {
    fingerprint,
    captured_at: new Date().toISOString(),
    claude_model: claudeModel,
    agents,
    mcps,
    plugins,
  };

  const absPath = path.resolve(process.cwd(), scoreboardPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath0 = absPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath0, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath0, absPath);

  const agentCount = Object.keys(agents).length;
  if (prevFingerprint) {
    process.stdout.write(`[init-team] fingerprint: ${fingerprint} (updated from ${prevFingerprint}) | ${agentCount} agents, ${mcps.length} MCPs, ${plugins.length} plugins\n`);
  } else {
    process.stdout.write(`[init-team] fingerprint: ${fingerprint} | ${agentCount} agents, ${mcps.length} MCPs, ${plugins.length} plugins\n`);
  }
}

// ---------------------------------------------------------------------------
// Availability tracking helpers
// ---------------------------------------------------------------------------

const MONTH_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a local date/time string like "Feb 24 8:37 PM" into a Date.
 * Returns null if unparseable.
 */
function parseLocalDateTime(str) {
  str = str.trim();
  // Matches: "Feb 24 8:37 PM", "February 24 20:37", "Feb 24 8:37:00 PM"
  const m = str.match(/^(\w{3,9})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;

  const monthKey = m[1].slice(0, 3).toLowerCase();
  const month    = MONTH_MAP[monthKey];
  if (month === undefined) return null;

  const day    = parseInt(m[2], 10);
  let   hour   = parseInt(m[3], 10);
  const minute = parseInt(m[4], 10);
  const ampm   = (m[6] || '').toUpperCase();

  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  const now = new Date();
  let d = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
  // If the computed time is already in the past, assume next year
  if (d < now) d = new Date(now.getFullYear() + 1, month, day, hour, minute, 0, 0);
  return d;
}

/**
 * Parse availability hint from a raw UNAVAIL message.
 * Supports:
 *   "usage limit until Feb 24 8:37 PM"
 *   "in 5 hours" / "restart in 5 hours"
 *   "in 30 minutes"
 * Returns { available_at: Date, reason: string } or null if no hint found.
 */
function parseAvailabilityHint(message) {
  // "until <Month Day HH:MM AM/PM>" — absolute local time
  const untilMatch = message.match(/until\s+([A-Za-z]{3,9}\s+\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
  if (untilMatch) {
    const parsed = parseLocalDateTime(untilMatch[1]);
    if (parsed) {
      const reason = /usage.?limit/i.test(message) ? 'usage limit'
                   : /quota/i.test(message)         ? 'quota exceeded'
                   : /rate.?limit/i.test(message)   ? 'rate limit'
                   : 'unavailable';
      return { available_at: parsed, reason };
    }
  }

  // "in N hours" — relative
  const hoursMatch = message.match(/in\s+(\d+(?:\.\d+)?)\s*hours?/i);
  if (hoursMatch) {
    const hours = parseFloat(hoursMatch[1]);
    const reason = /quota/i.test(message) ? 'quota exceeded'
                 : /rate.?limit/i.test(message) ? 'rate limit'
                 : 'unavailable';
    return { available_at: new Date(Date.now() + hours * 3_600_000), reason };
  }

  // "in N minutes" — relative
  const minsMatch = message.match(/in\s+(\d+)\s*minutes?/i);
  if (minsMatch) {
    const mins = parseInt(minsMatch[1], 10);
    return { available_at: new Date(Date.now() + mins * 60_000), reason: 'unavailable' };
  }

  // Default cooldown for recognized failure patterns without explicit time hints.
  // These error types indicate the slot should be skipped for a few minutes.
  const DEFAULT_COOLDOWN_MS = 5 * 60_000; // 5 minutes
  if (/TIMEOUT|STALL|RATE_LIMITED|429|Too Many Requests|exhausted|quota|rate.?limit/i.test(message)) {
    const reason = /RATE_LIMITED|429|Too Many Requests|exhausted|quota|rate.?limit/i.test(message) ? 'rate limit'
                 : /STALL/i.test(message) ? 'stall'
                 : 'timeout';
    return { available_at: new Date(Date.now() + DEFAULT_COOLDOWN_MS), reason };
  }

  return null;
}

/** Format remaining milliseconds as "Xh Ym", "Zm", or "now". */
function formatDuration(ms) {
  if (ms <= 0) return 'now';
  const totalMins = Math.ceil(ms / 60_000);
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins  = totalMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// set-availability subcommand
//
// Usage:
//   node update-scoreboard.cjs set-availability \
//     --slot codex-1 --message "usage limit until Feb 24 8:37 PM" [--scoreboard <path>]
//   node update-scoreboard.cjs set-availability \
//     --model codex  --message "restart in 5 hours"               [--scoreboard <path>]
//
// --slot or --model is the key in data.availability (both accepted; no functional difference).
// --message is the raw UNAVAIL output text from the agent.
// ---------------------------------------------------------------------------

async function setAvailability(argv) {
  const args           = parseArgs(argv);
  const scoreboardPath = args.scoreboard || defaultScoreboardPath();
  const key            = args.slot || args.model;
  const message        = args.message || '';

  if (!key) {
    process.stderr.write('[set-availability] --slot or --model is required\n');
    process.exit(1);
  }
  if (!message) {
    process.stderr.write('[set-availability] --message "<raw output text>" is required\n');
    process.exit(1);
  }

  const hint = parseAvailabilityHint(message);
  if (!hint) {
    process.stdout.write(`[set-availability] ${key}: no availability hint found in message — skipping\n`);
    return;
  }
  // Guard an Invalid Date — e.g. an absurd "retry in 99999999999 hours" overflows the
  // representable Date range. available_at.toISOString() would throw RangeError → exit 1,
  // and the cooldown is never recorded. Treat an unrepresentable window as "no cooldown".
  if (!(hint.available_at instanceof Date) || !Number.isFinite(hint.available_at.getTime())) {
    process.stderr.write(`[set-availability] ${key}: availability hint resolved to an invalid time — not recording a cooldown\n`);
    return;
  }

  const data = loadData(scoreboardPath);
  if (!data.availability) data.availability = {};

  const now          = new Date();
  const remaining_ms = Math.max(0, hint.available_at.getTime() - now.getTime());

  data.availability[key] = {
    available_at_iso:   hint.available_at.toISOString(),
    available_at_local: hint.available_at.toLocaleString(),
    reason:             hint.reason,
    set_at:             now.toISOString(),
  };

  const absPath = path.resolve(process.cwd(), scoreboardPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath1 = absPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath1, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath1, absPath);

  const eta = remaining_ms > 0 ? `available in ${formatDuration(remaining_ms)}` : 'available now';
  process.stdout.write(
    `[set-availability] ${key}: ${hint.reason} | ${eta} | local: ${hint.available_at.toLocaleString()}\n`
  );
}

// ---------------------------------------------------------------------------
// get-availability subcommand
//
// Usage:
//   node update-scoreboard.cjs get-availability [--scoreboard <path>]
//
// Outputs JSON: { "<slot-or-model>": { available_at_iso, available_at_local,
//                                      reason, set_at, is_available,
//                                      remaining_ms, remaining_display } }
//
// Use this to check dormant slots before invoking them in a quorum run.
// ---------------------------------------------------------------------------

async function getAvailability(argv) {
  const args           = parseArgs(argv);
  const scoreboardPath = args.scoreboard || defaultScoreboardPath();
  const data           = loadData(scoreboardPath);
  const now            = Date.now();

  const result = {};
  for (const [key, avail] of Object.entries(data.availability || {})) {
    const a  = (avail && typeof avail === 'object') ? avail : {};
    const ms = new Date(a.available_at_iso).getTime();
    const ok = Number.isFinite(ms);
    // FAIL OPEN on a corrupt entry. A null/non-object avail, or a missing/garbage
    // available_at_iso, would otherwise make is_available = (NaN <= now) = false → the
    // slot is stuck in cooldown FOREVER (silently excluded from the quorum) with NaN
    // remaining. An unparseable window means "available now".
    const is_available = !ok || ms <= now;
    const remaining_ms = ok ? Math.max(0, ms - now) : 0;
    result[key] = {
      available_at_iso:   a.available_at_iso,
      available_at_local: a.available_at_local,
      reason:             a.reason,
      set_at:             a.set_at,
      is_available,
      remaining_ms,
      remaining_display:  formatDuration(remaining_ms),
    };
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// merge-wave subcommand
//
// Usage:
//   node update-scoreboard.cjs merge-wave \
//     --dir .planning/scoreboard-tmp \
//     --task "quick-97" --round 1 \
//     [--scoreboard <path>]
//
// Reads all vote files matching vote-*-<task>-<round>-*.json in --dir,
// applies them in one atomic transaction to the scoreboard.
//
// Vote file schema (JSON):
// {
//   "slot":    "<slotName>",          // for --slot path
//   "model":   "<modelFamily>",       // for --model path (alternative)
//   "modelId": "<fullModelId>",       // required when slot is set
//   "result":  "TP|TN|FP|FN|TP+|TN+|UNAVAIL|",
//   "verdict": "APPROVE|REJECT|FLAG|CONSENSUS|DELIBERATE|GAPS_FOUND",
//   "taskDescription": "<optional>"
// }
// ---------------------------------------------------------------------------

async function mergeWave(argv) {
  const { deltas: activeDeltas } = loadScoreDeltas();
  const args           = parseArgs(argv);
  const scoreboardPath = args.scoreboard || defaultScoreboardPath();
  const dir            = args.dir        || '.planning/scoreboard-tmp';
  const task           = args.task;
  const round          = parseInt(args.round, 10);

  if (!task) {
    process.stderr.write('[merge-wave] --task is required\n');
    process.exit(1);
  }
  if (isNaN(round) || round < 1) {
    process.stderr.write('[merge-wave] --round must be a positive integer\n');
    process.exit(1);
  }

  const absDir = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(absDir)) {
    process.stdout.write(`[merge-wave] dir ${absDir} does not exist — no votes to merge\n`);
    return;
  }

  // Find matching vote files: vote-*-<task>-<round>-*.json
  const pattern = new RegExp(`^vote-.*-${round}-[^/]+\\.json$`);
  const files = fs.readdirSync(absDir).filter(f => {
    if (!pattern.test(f)) return false;
    // Also filter by task name in file
    return f.includes(`-${task}-`);
  });

  if (files.length === 0) {
    process.stdout.write(`[merge-wave] no vote files found for task=${task} round=${round} in ${absDir}\n`);
    return;
  }

  // Parse all vote files
  const votes = [];
  for (const file of files) {
    try {
      const filePath = path.join(absDir, file);
      const vote = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      votes.push({ file, vote });
    } catch (e) {
      process.stderr.write(`[merge-wave] WARNING: could not parse ${file}: ${e.message}\n`);
    }
  }

  if (votes.length === 0) {
    process.stdout.write(`[merge-wave] all vote files unparseable — nothing to merge\n`);
    return;
  }

  // Load scoreboard once
  const data = loadData(scoreboardPath);

  // Ensure all model keys exist
  for (const model of VALID_MODELS) {
    if (!data.models[model]) data.models[model] = emptyModelStats();
  }

  // Apply all votes to data in memory
  for (const { file, vote } of votes) {
    // Shape-guard: a wave file that is valid JSON but NOT a vote object (null, array,
    // string, number) must be SKIPPED, not abort the whole atomic merge — one such file
    // used to throw on `vote.result` and lose every valid sibling vote in the wave.
    if (!vote || typeof vote !== 'object' || Array.isArray(vote)) {
      process.stderr.write(`[merge-wave] WARNING: vote file ${file} is not a vote object — skipping\n`);
      continue;
    }
    // Normalise UNAVAILABLE → UNAVAIL (typo variant from early rounds)
    let result  = vote.result === 'UNAVAILABLE' ? 'UNAVAIL' : (vote.result || '');
    const verdict = vote.verdict || '';
    // Enforce the result vocabulary against the canonical VALID_RESULTS. (A local
    // `new Set([...])` was declared here but never used — the #268 pattern recurring:
    // a bogus code like "BOGUS" was persisted verbatim, inflating the per-slot
    // invocation denominator while scoring nothing.) '' is the legitimate Mode-A case,
    // handled just below.
    if (result !== '' && !VALID_RESULTS.includes(result)) {
      process.stderr.write(`[merge-wave] WARNING: invalid result "${result}" in ${file} — skipping\n`);
      continue;
    }

    // Mode A rounds intentionally have no binary result. Skip writing an empty
    // string — it would corrupt empirical rate calculations by appearing as an
    // "available but unclassified" vote. The availability signal for Mode A is
    // tracked separately via set-availability calls.
    if (result === '') {
      process.stderr.write(`[merge-wave] NOTE: ${file} has no result code (Mode A round) — availability recorded via verdict only\n`);
      // Still record the verdict/round for audit trail, but omit from votes map
      const taskRound = data.rounds.findIndex(r => r.task === task && r.round === round);
      if (taskRound === -1) {
        data.rounds.push({ date: todayMMDD(), task, round, votes: {}, verdict });
      } else if (!data.rounds[taskRound].verdict) {
        data.rounds[taskRound].verdict = verdict;
      }
      continue;
    }

    if (vote.slot && vote.modelId) {
      // Slot mode
      const compositeKey = `${vote.slot}:${vote.modelId}`;
      if (!data.slots[compositeKey]) {
        data.slots[compositeKey] = emptySlotStats(vote.slot, vote.modelId);
      }
      // Find or create round entry
      const existingIdx = data.rounds.findIndex(r => r.task === task && r.round === round);
      if (existingIdx !== -1) {
        data.rounds[existingIdx].votes = data.rounds[existingIdx].votes || {};
        data.rounds[existingIdx].votes[compositeKey] = result;
        data.rounds[existingIdx].verdict = verdict;
      } else {
        const newEntry = {
          date:    todayMMDD(),
          task,
          round,
          votes:   { [compositeKey]: result },
          verdict,
        };
        if (data.team && data.team.fingerprint) newEntry.team_fingerprint = data.team.fingerprint;
        data.rounds.push(newEntry);
      }
    } else if (vote.model) {
      // Model mode
      const model = vote.model;
      if (!VALID_MODELS.includes(model)) {
        process.stderr.write(`[merge-wave] WARNING: unknown model "${model}" in ${file} — skipping\n`);
        continue;
      }
      const existingIdx = data.rounds.findIndex(r => r.task === task && r.round === round);
      if (existingIdx !== -1) {
        data.rounds[existingIdx].votes = data.rounds[existingIdx].votes || {};
        data.rounds[existingIdx].votes[model] = result;
        data.rounds[existingIdx].verdict = verdict;
      } else {
        const newEntry = {
          date:    todayMMDD(),
          task,
          round,
          votes:   { [model]: result },
          verdict,
        };
        if (data.team && data.team.fingerprint) newEntry.team_fingerprint = data.team.fingerprint;
        data.rounds.push(newEntry);
      }
    } else {
      process.stderr.write(`[merge-wave] WARNING: vote file ${file} missing slot+modelId or model — skipping\n`);
    }
  }

  // Recompute stats from scratch
  recomputeStats(data, activeDeltas);
  recomputeSlots(data, activeDeltas);
  computeDeliveryStats(data);
  computeFlakiness(data);

  // Single atomic write
  const absPath = path.resolve(process.cwd(), scoreboardPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = absPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, absPath);

  process.stdout.write(`[merge-wave] merged ${votes.length} vote(s) for task=${task} round=${round} into ${scoreboardPath}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rawArgs = process.argv.slice(2);

  // Subcommand routing
  if (rawArgs[0] === 'init-team')        return initTeam(rawArgs.slice(1));
  if (rawArgs[0] === 'set-availability') return setAvailability(rawArgs.slice(1));
  if (rawArgs[0] === 'get-availability') return getAvailability(rawArgs.slice(1));
  if (rawArgs[0] === 'merge-wave')       return mergeWave(rawArgs.slice(1));

  const { deltas: activeDeltas, source: deltaSource } = loadScoreDeltas();
  const parsed  = parseArgs(rawArgs);
  const cfg     = validate(parsed);

  const data = loadData(cfg.scoreboard);

  // ---------------------------------------------------------------------------
  // Slot mode: --slot + --model-id path (SCBD-01, SCBD-02, SCBD-03)
  // ---------------------------------------------------------------------------
  if (cfg.slot) {
    const compositeKey = `${cfg.slot}:${cfg.modelId}`;

    // Ensure slot entry exists in data.slots
    if (!data.slots[compositeKey]) {
      data.slots[compositeKey] = emptySlotStats(cfg.slot, cfg.modelId);
    }

    // Append to rounds with vote keyed by compositeKey
    const roundEntry = {
      date:    todayMMDD(),
      task:    cfg.task,
      round:   cfg.round,
      votes:   { [compositeKey]: cfg.result },
      verdict: cfg.verdict,
    };
    if (data.team && data.team.fingerprint) {
      roundEntry.team_fingerprint = data.team.fingerprint;
    }
    data.rounds.push(roundEntry);

    // Recompute slot stats only (do NOT call recomputeStats — that is for --model path)
    recomputeSlots(data, activeDeltas);

    // Write back
    const absPath = path.resolve(process.cwd(), cfg.scoreboard);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmpPath2 = absPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpPath2, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath2, absPath);

    // Print confirmation
    process.stdout.write(`[update-scoreboard] slot ${cfg.slot} (${cfg.modelId}): ${cfg.result} | score=${data.slots[compositeKey].score}\n`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Model mode: --model path (existing behavior, unchanged)
  // ---------------------------------------------------------------------------

  // Ensure all model keys exist
  for (const model of VALID_MODELS) {
    if (!data.models[model]) data.models[model] = emptyModelStats();
  }

  // Resolve category/subcategory
  let resolvedCategory    = cfg.category;
  let resolvedSubcategory = cfg.subcategory;

  if (!resolvedCategory && !resolvedSubcategory && cfg.taskDescription) {
    // Auto-classify via Haiku
    const classification = await classifyWithHaiku(cfg.taskDescription, data.categories);
    if (classification) {
      resolvedCategory    = classification.category;
      resolvedSubcategory = classification.subcategory;

      if (classification.is_new) {
        // Add new category/subcategory dynamically
        if (!data.categories[resolvedCategory]) {
          data.categories[resolvedCategory] = [];
        }
        if (!data.categories[resolvedCategory].includes(resolvedSubcategory)) {
          data.categories[resolvedCategory].push(resolvedSubcategory);
        }
      } else {
        // Existing category — if subcategory is a variant not yet listed, append it
        if (data.categories[resolvedCategory] && !data.categories[resolvedCategory].includes(resolvedSubcategory)) {
          data.categories[resolvedCategory].push(resolvedSubcategory);
        }
      }
    }
  } else if (resolvedCategory && resolvedSubcategory) {
    // Explicit flags provided — no Haiku needed
    // (categories map is not modified for explicit flags)
  }

  // Find existing round entry matching task + round number
  const existingIdx = data.rounds.findIndex(
    r => r.task === cfg.task && r.round === cfg.round
  );

  if (existingIdx !== -1) {
    // Update existing entry: set/overwrite the model's vote, preserve verdict
    data.rounds[existingIdx].votes = data.rounds[existingIdx].votes || {};
    data.rounds[existingIdx].votes[cfg.model] = cfg.result;
    // Allow verdict update too
    data.rounds[existingIdx].verdict = cfg.verdict;
    // Set category if resolved
    if (resolvedCategory && resolvedSubcategory) {
      data.rounds[existingIdx].category    = resolvedCategory;
      data.rounds[existingIdx].subcategory = resolvedSubcategory;
    }
  } else {
    // Append new round entry
    const newEntry = {
      date:    todayMMDD(),
      task:    cfg.task,
      round:   cfg.round,
      votes:   { [cfg.model]: cfg.result },
      verdict: cfg.verdict,
    };
    if (resolvedCategory && resolvedSubcategory) {
      newEntry.category    = resolvedCategory;
      newEntry.subcategory = resolvedSubcategory;
    }
    if (data.team && data.team.fingerprint) {
      newEntry.team_fingerprint = data.team.fingerprint;
    }
    data.rounds.push(newEntry);
  }

  // Recompute all cumulative stats from scratch
  recomputeStats(data, activeDeltas);

  // Write back
  const absPath = path.resolve(process.cwd(), cfg.scoreboard);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath3 = absPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath3, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath3, absPath);

  // Print confirmation
  const delta    = activeDeltas[cfg.result] || 0;
  const sign     = delta >= 0 ? '+' : '';
  const newScore = data.models[cfg.model].score;
  const deltaStr = cfg.result === '' ? '(not scored)' : `${cfg.result} (${sign}${delta})`;
  let confirmation = `[update-scoreboard] ${cfg.model}: ${deltaStr} → score: ${newScore} | ${cfg.task} R${cfg.round} ${cfg.verdict}`;
  if (resolvedCategory && resolvedSubcategory) {
    confirmation += ` | category: ${resolvedCategory} > ${resolvedSubcategory}`;
  }
  process.stdout.write(confirmation + '\n');
}

// Guard pattern: only export when require()d by tests, not when run as a CLI script
if (typeof module !== 'undefined') {
  module.exports = { computeDeliveryStats, computeFlakiness, emptyData, loadScoreDeltas, DEFAULT_SCORE_DELTAS };
}

// Only run main() when invoked as a script, not when require()d by tests
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`[update-scoreboard] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}
