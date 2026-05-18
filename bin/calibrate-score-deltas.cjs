#!/usr/bin/env node
'use strict';

/**
 * calibrate-score-deltas.cjs
 *
 * Analyzes quorum scoreboard rounds to derive empirically calibrated score
 * deltas. Measures per-vote-type correlation with consensus outcomes and
 * produces scaled integer deltas that replace hand-tuned constants.
 *
 * Usage:
 *   node bin/calibrate-score-deltas.cjs [--scoreboard <path>] [--output <path>] [--min-rounds <n>]
 *
 * Output: .planning/quorum/calibrated-deltas.json
 */

const fs = require('fs');
const path = require('path');

// Current hardcoded defaults (from update-scoreboard.cjs)
const DEFAULT_SCORE_DELTAS = {
  TP: 1,
  TN: 5,
  FP: -3,
  FN: -1,
  'TP+': 3,
  'TN+': 7,
  UNAVAIL: 0,
  '': 0,
};

const POSITIVE_VERDICTS = new Set(['APPROVE', 'CONSENSUS']);
const NEGATIVE_VERDICTS = new Set(['BLOCK', 'GAPS_FOUND']);
const BASE_VOTE_TYPES = ['TP', 'TN', 'FP', 'FN'];
const IMPROVEMENT_BONUS = 2;
const MIN_ROUNDS_DEFAULT = 30;
const MIN_VOTES_DEFAULT = 5;
const SCALE_FACTOR = 5;
const CLAMP_MAX = 10;
const CLAMP_MIN = -10;

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

function defaultScoreboardPath() {
  try {
    return require('./planning-paths.cjs').resolveWithFallback(process.cwd(), 'quorum-scoreboard');
  } catch (_) {
    return '.planning/quorum/scoreboard.json';
  }
}

function defaultOutputPath() {
  try {
    return require('./planning-paths.cjs').resolve(process.cwd(), 'calibrated-deltas');
  } catch (_) {
    return '.planning/quorum/calibrated-deltas.json';
  }
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Classify a round's outcome as positive or negative based on verdict.
 * Returns null for unclassifiable verdicts (DELIBERATE, '—').
 */
function classifyRoundOutcome(round) {
  const v = round.verdict;
  if (!v) return null;
  if (POSITIVE_VERDICTS.has(v)) return 'positive';
  if (NEGATIVE_VERDICTS.has(v)) return 'negative';
  return null;
}

/**
 * Tally per-vote-type occurrence counts in positive vs negative rounds.
 * Only counts classified votes (skips '', UNAVAIL).
 * Only uses rounds where classifyRoundOutcome returns non-null.
 */
function tallyVoteTypeOutcomes(rounds) {
  const tallies = {};
  for (const type of BASE_VOTE_TYPES) {
    tallies[type] = { positive: 0, negative: 0, total: 0 };
  }

  for (const round of rounds) {
    const outcome = classifyRoundOutcome(round);
    if (!outcome) continue;

    const votes = round.votes || {};
    for (const [, vote] of Object.entries(votes)) {
      if (!vote || vote === '' || vote === 'UNAVAIL') continue;
      // Map TP+ → TP, TN+ → TN for base type tallying
      const baseType = vote.replace('+', '');
      if (tallies[baseType]) {
        tallies[baseType][outcome] += 1;
        tallies[baseType].total += 1;
      }
    }
  }

  return tallies;
}

/**
 * Compute signal value for a vote type.
 * Signal = P(positive_outcome | vote_type) - P(positive_outcome overall)
 * Returns null if insufficient data (total < minVotes).
 */
function computeSignal(tallies, overallPositiveRate, voteType, minVotes) {
  const t = tallies[voteType];
  if (!t || t.total < minVotes) return null;
  const pPositiveGivenType = t.positive / t.total;
  return pPositiveGivenType - overallPositiveRate;
}

/**
 * Derive calibrated deltas from rounds data.
 * Falls back to defaults if insufficient data.
 */
function deriveCalibratedDeltas(rounds, defaults, options) {
  const opts = {
    minRounds: (options && options.minRounds) || MIN_ROUNDS_DEFAULT,
    minVotes: (options && options.minVotes) || MIN_VOTES_DEFAULT,
    scaleFactor: (options && options.scaleFactor) || SCALE_FACTOR,
  };

  const classifiedRounds = rounds.filter(r => classifyRoundOutcome(r) !== null);

  if (classifiedRounds.length < opts.minRounds) {
    return {
      deltas: { ...defaults },
      metadata: {
        usedFallback: true,
        reason: `only ${classifiedRounds.length} classified rounds (need ${opts.minRounds})`,
        totalRounds: rounds.length,
        classifiedRounds: classifiedRounds.length,
        overallPositiveRate: null,
        scaleFactor: opts.scaleFactor,
        perType: {},
      },
    };
  }

  const tallies = tallyVoteTypeOutcomes(rounds);
  const totalPositive = classifiedRounds.filter(r => classifyRoundOutcome(r) === 'positive').length;
  const overallPositiveRate = totalPositive / classifiedRounds.length;

  const deltas = {};
  const perType = {};

  // Compute base deltas
  for (const type of BASE_VOTE_TYPES) {
    const signal = computeSignal(tallies, overallPositiveRate, type, opts.minVotes);
    if (signal === null) {
      deltas[type] = defaults[type];
      perType[type] = { signal: null, empiricalDelta: null, rounds: tallies[type] ? tallies[type].total : 0, usedDefault: true };
    } else {
      const raw = Math.round(signal * opts.scaleFactor);
      const clamped = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, raw));
      deltas[type] = clamped;
      perType[type] = { signal: parseFloat(signal.toFixed(4)), empiricalDelta: clamped, rounds: tallies[type].total, usedDefault: false };
    }
  }

  // Derived types: TP+ = TP + improvement bonus, TN+ = TN + improvement bonus
  deltas['TP+'] = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, deltas.TP + IMPROVEMENT_BONUS));
  deltas['TN+'] = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, deltas.TN + IMPROVEMENT_BONUS));
  perType['TP+'] = { signal: null, empiricalDelta: deltas['TP+'], rounds: 0, usedDefault: false, derived: true, note: `TP(${deltas.TP}) + ${IMPROVEMENT_BONUS}` };
  perType['TN+'] = { signal: null, empiricalDelta: deltas['TN+'], rounds: 0, usedDefault: false, derived: true, note: `TN(${deltas.TN}) + ${IMPROVEMENT_BONUS}` };

  // Constants
  deltas.UNAVAIL = 0;
  deltas[''] = 0;

  return {
    deltas,
    metadata: {
      usedFallback: false,
      totalRounds: rounds.length,
      classifiedRounds: classifiedRounds.length,
      overallPositiveRate: parseFloat(overallPositiveRate.toFixed(4)),
      scaleFactor: opts.scaleFactor,
      perType,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function loadScoreboard(scoreboardPath) {
  const absPath = path.resolve(process.cwd(), scoreboardPath);
  if (!fs.existsSync(absPath)) return null;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeOutput(outputPath, content) {
  const absPath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = absPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, absPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scoreboardPath = args.scoreboard || defaultScoreboardPath();
  const outputPath = args.output || defaultOutputPath();
  const minRounds = args['min-rounds'] ? parseInt(args['min-rounds'], 10) : MIN_ROUNDS_DEFAULT;

  const data = loadScoreboard(scoreboardPath);
  if (!data) {
    process.stderr.write(`[calibrate] no scoreboard found at ${scoreboardPath}\n`);
    process.exit(1);
  }

  const rounds = data.rounds || [];
  if (rounds.length === 0) {
    process.stderr.write('[calibrate] scoreboard has no rounds\n');
    process.exit(1);
  }

  const { deltas, metadata } = deriveCalibratedDeltas(rounds, DEFAULT_SCORE_DELTAS, { minRounds });

  const output = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_rounds: rounds.length,
    deltas,
    metadata,
  };

  writeOutput(outputPath, output);

  const source = metadata.usedFallback ? 'DEFAULT (insufficient data)' : 'CALIBRATED';
  process.stdout.write(
    `[calibrate] ${source} | ${metadata.classifiedRounds ?? rounds.length}/${rounds.length} rounds | output: ${outputPath}\n`
  );

  // Print delta summary
  const parts = BASE_VOTE_TYPES.map(t => `${t}=${deltas[t]}`);
  parts.push(`TP+=${deltas['TP+']}`, `TN+=${deltas['TN+']}`);
  process.stdout.write(`[calibrate] deltas: ${parts.join(' ')}\n`);
}

if (typeof module !== 'undefined') {
  module.exports = {
    _pure: {
      classifyRoundOutcome,
      tallyVoteTypeOutcomes,
      computeSignal,
      deriveCalibratedDeltas,
    },
    DEFAULT_SCORE_DELTAS,
  };
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`[calibrate] FATAL: ${err.message}\n`);
    process.exit(1);
  });
}
