#!/usr/bin/env node
// hooks/nf-circuit-breaker.js
// PreToolUse hook — oscillation detection, state persistence, and notification for circuit breaker.
//
// Reads JSON from stdin (Claude Code PreToolUse event payload), checks for oscillation
// in git history when Bash commands are executed, and persists breaker state across
// invocations. Non-blocking: all tool calls are allowed through; oscillation is reported
// as a priority warning via the hook output so Claude sees it without being hard-blocked.
//
// Config-driven defaults via loadConfig(gitRoot): oscillation_depth and commit_window
// State file: .claude/circuit-breaker-state.json (gitignored)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, validateHookInput } = require('./config-loader');
const { schema_version } = require('./conformance-schema.cjs');
const resolveBin = require('./nf-resolve-bin');

// Read-only command regex: git log/diff/diff-tree/status/show/blame, grep, cat, ls, head, tail, find
const READ_ONLY_REGEX = /^\s*(git\s+(log|diff|diff-tree|status|show|blame)|grep|cat\s|ls(\s|$)|head|tail|find)\s*/;

// Returns git root directory or null if not a git repo
function getGitRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.trim() || null;
}

// Reads existing state file, returns object or null
function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null; // Malformed or error
  }
}

// Returns true if command is read-only (skip detection on read-only commands)
function isReadOnly(command) {
  return READ_ONLY_REGEX.test(command);
}

// Gets last N commit hashes via git log
function getCommitHashes(gitRoot, window) {
  const result = spawnSync('git', ['log', `--format=%H`, `-${window}`], {
    cwd: gitRoot,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return [];
  return result.stdout.trim().split('\n').filter(h => h.length > 0);
}

// Gets file sets for each commit hash using diff-tree.
// --root ensures root commits (no parent) also report their files.
function getCommitFileSets(gitRoot, hashes) {
  const sets = [];
  for (const hash of hashes) {
    const result = spawnSync(
      'git',
      ['diff-tree', '--no-commit-id', '-r', '--name-only', '--root', hash],
      { cwd: gitRoot, encoding: 'utf8', timeout: 5000 }
    );
    if (result.status !== 0 || result.error) {
      sets.push([]);
    } else {
      const files = result.stdout.trim().split('\n').filter(f => f.length > 0);
      sets.push(files);
    }
  }
  return sets;
}

// Gets the unified diff between two commits for a specific set of files.
// Returns the raw diff string, or empty string on error (fail-open).
// olderHash is the earlier commit, newerHash is the later commit (forward in time).
function getCommitDiff(gitRoot, olderHash, newerHash, files) {
  const result = spawnSync(
    'git',
    ['diff', olderHash, newerHash, '--', ...files],
    { cwd: gitRoot, encoding: 'utf8', timeout: 5000 }
  );
  if (result.status !== 0 || result.error) return '';
  return result.stdout || '';
}

// Second-pass reversion check: given the hashes (newest-first) belonging to
// run-groups for an oscillating file set key, and the files in that set,
// determines whether the pattern is true oscillation or TDD/workflow progression.
//
// Algorithm: sum net change (additions - deletions) across all consecutive pairs,
// AND track whether at least one pair has negative net change (content removal).
//
// - Positive total net change → file grew overall → TDD progression (not oscillation).
// - Zero or negative total net change WITH at least one pair showing net deletions
//   → true oscillation (content was added then removed).
// - Zero or negative total net change with NO pair showing net deletions
//   (all pairs are zero-net substitutions) → NOT oscillation. This is monotonic
//   workflow progression (e.g., template → linter substitution → population).
//
// This correctly handles TDD patterns where a line like `module.exports` is modified
// (1 deletion, 1 addition per commit) alongside net-new lines — the net change remains
// positive because new functions are added each time.
//
// For true oscillation (same content toggled back and forth), at least one pair
// will show a net-negative change (lines removed that were added in a prior pair).
//
// hashes: all commit hashes (newest-first) in the oscillating run-groups
// files: file paths in the oscillating set
// gitRoot: git repository root
//
// Returns true if real oscillation (net change <= 0 AND at least one negative pair).
// Returns false if all pairs are zero-net substitutions (monotonic workflow progression).
// Returns true also if ALL pairs errored out (git unavailable → fall back to original behavior).
// pairStatsOut: optional array — if provided, populated with { additions, deletions, pairNet, hash }
//               for each consecutive pair (oldest-first), for use by rollback intent detection.
function hasReversionInHashes(gitRoot, hashes, files, pairStatsOut) {
  // hashes are newest-first; consecutive pairs: (hashes[i], hashes[i-1]) where
  // hashes[i] is older (higher index = earlier in time), hashes[i-1] is newer.
  // We diff older → newer: git diff <hashes[i]> <hashes[i-1]>
  let totalNetChange = 0;
  let hasNegativePair = false;
  let hasPositivePair = false;
  let negPairs = 0;
  let errorsOnly = true;

  for (let i = hashes.length - 1; i >= 1; i--) {
    const olderHash = hashes[i];
    const newerHash = hashes[i - 1];
    const diff = getCommitDiff(gitRoot, olderHash, newerHash, files);

    if (diff === '') {
      // git error — skip this pair (fail-open for individual pair)
      continue;
    }

    errorsOnly = false;

    // Parse diff: count additions/deletions within hunk bodies only. Skipping
    // any line starting with --- / +++ misclassifies CONTENT lines that begin
    // with "--"/"++" (SQL comments "-- x", markdown/YAML "---") as file headers.
    const lines = diff.split('\n');
    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue; // file headers (diff/index/---/+++) precede the first hunk
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }

    const pairNet = additions - deletions;
    totalNetChange += pairNet;
    if (pairNet < 0) { hasNegativePair = true; negPairs++; }
    if (pairNet > 0) hasPositivePair = true;

    // Collect pair stats for rollback intent detection
    if (Array.isArray(pairStatsOut)) {
      pairStatsOut.push({ additions, deletions, pairNet, hash: newerHash });
    }
  }

  // If all pairs errored out → fall back to original behavior (treat as oscillation)
  if (errorsOnly) return true;

  const reversion = hasContentReversion(gitRoot, hashes, files); // true | false | null (git error)
  const contentReverts = reversion === true;

  // SUSTAINED MONOTONIC SHRINK is a directional cleanup (e.g. dead-code removal
  // 6→4→2 lines: two-plus deletion-only pairs, no additions anywhere, and the content
  // never returns to a prior state), NOT a loop — do not trip the breaker. This is the
  // false-positive the old `totalNetChange <= 0 && hasNegativePair` proxy produced. A
  // SINGLE deletion pair or any size churn is still judged by the size signal below, so
  // short patterns keep their established behavior. Gate on `reversion === false`
  // (POSITIVELY confirmed no reversion), not `!contentReverts` — if fingerprinting was
  // unavailable (reversion === null, a transient git error) we must NOT assume "no
  // reversion" and silently exempt; fall through to the size heuristic instead.
  if (negPairs >= 2 && !hasPositivePair && reversion === false) return false;

  // Oscillation when EITHER:
  //  - the established size signal: non-positive net change with at least one removal
  //    (catches size-alternating churn 1→2→1→2 and short net-negative reversions), OR
  //  - a byte-level CONTENT REVERSION (A→B→A): catches EQUAL-LENGTH value toggles
  //    (FLAG="on"↔"off") whose pairs are all net-zero, so the size signal can't see them.
  return (totalNetChange <= 0 && hasNegativePair) || contentReverts;
}

// Content fingerprint of the file set at one commit: git's own (repo-relative path, blob
// SHA) pairs for `files`, sorted for determinism. An absent file simply doesn't appear in
// the ls-tree output (so add/remove of a file changes the fingerprint). One `git ls-tree`
// call per commit. Returns null on git error so the caller can fall back, not mis-decide.
function fileSetContentFingerprint(gitRoot, hash, files) {
  const r = spawnSync('git', ['ls-tree', hash, '--', ...files], {
    cwd: gitRoot, encoding: 'utf8', timeout: 5000,
  });
  if (r.error || r.status !== 0) return null;
  // Build the fingerprint from git's OWN output pairs (repo-relative path + blob SHA),
  // NOT by looking up the original `files` pathspecs — those may be absolute while
  // ls-tree emits repo-relative paths, so a lookup would never match and every commit
  // would fingerprint identically. An absent file simply doesn't appear (its state).
  const pairs = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\S+\s+\S+\s+(\S+)\t(.+)$/); // "<mode> blob <sha>\t<path>"
    if (m) pairs.push(m[2] + '=' + m[1]);
  }
  pairs.sort();
  return pairs.join('\0');
}

// True if the file set's content returns to a prior state across `hashes` (a real
// A→B→A reversion), false if every state is unique (monotonic shrink or forward
// progression — NOT oscillation), or null if fingerprints can't be computed (git error
// → caller falls back). Consecutive identical states (a commit that touched only OTHER
// files) are collapsed first so they don't read as a spurious repeat.
function hasContentReversion(gitRoot, hashes, files) {
  const fps = [];
  for (const hash of hashes) {
    const fp = fileSetContentFingerprint(gitRoot, hash, files);
    if (fp === null) return null;
    if (fps.length === 0 || fps[fps.length - 1] !== fp) fps.push(fp); // collapse adjacent dups
  }
  const seen = new Set();
  for (const fp of fps) {
    if (seen.has(fp)) return true; // a state recurs after leaving it → reversion
    seen.add(fp);
  }
  return false;
}

// Counts full oscillation cycles for a file set key.
// A cycle = one reappearance of the key after a gap (different file set in between).
// keyRunList.length run-groups = keyRunList.length - 1 cycles.
// Example: 3 run-groups of key A (separated by non-A groups) = 2 full cycles.
// Only 1 run-group = 0 cycles (no oscillation at all, just repeated edits).
function countOscillationCycles(keyRunList) {
  return Math.max(0, keyRunList.length - 1);
}

// Gets commit messages (subject lines) for the given hashes.
// Returns Map<hash, string> of commit subject lines.
function getCommitMessages(gitRoot, hashes) {
  const messages = new Map();
  if (!hashes || hashes.length === 0) return messages;

  // Fetch messages for specific hashes via git log
  for (const hash of hashes) {
    const result = spawnSync('git', ['log', '--format=%s', '-n', '1', hash], {
      cwd: gitRoot, encoding: 'utf8', timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      messages.set(hash, result.stdout.trim());
    }
  }
  return messages;
}

// Regex for commit message keywords signaling deliberate rollback intent.
const ROLLBACK_KEYWORDS = /\b(revert|rollback|remove|undo|back\s?out|cherry.?pick.*revert)\b/i;

// Checks if any of the net-negative commits signal deliberate rollback intent
// via commit message keywords.
// pairStats: array of { additions, deletions, pairNet, hash } from hasReversionInHashes
// messages: Map<hash, string> from getCommitMessages
// Returns true if a negative-net commit has rollback keywords in its message.
function hasRollbackIntent(messages, pairStats) {
  for (const stat of pairStats) {
    if (stat.pairNet < 0) {
      const msg = messages.get(stat.hash) || '';
      if (ROLLBACK_KEYWORDS.test(msg)) return true;
    }
  }
  return false;
}

// Detects whether the oscillating commits show a clean rollback pattern.
// A clean rollback = one commit adds content, a later commit removes the same content
// (inverse diff), without repeating the cycle.
//
// Algorithm: compare consecutive same-file-set commit pairs.
// If pair N shows +X/-Y and pair N+1 shows +Y/-X (approximately inverse),
// and there is exactly 1 such inverse pair, this is a deliberate one-shot rollback.
// 2+ inverse pairs = repeated add-remove-add-remove = true oscillation.
//
// Returns true if the pattern is a clean rollback (should NOT trigger breaker).
// Returns false if the pattern shows repeated oscillation (SHOULD trigger breaker).
function isCleanRollback(gitRoot, hashes, files) {
  // Collect per-pair diff stats
  const pairStats = [];
  for (let i = hashes.length - 1; i >= 1; i--) {
    const diff = getCommitDiff(gitRoot, hashes[i], hashes[i - 1], files);
    if (diff === '') continue;
    // Hunk-aware parse (see hasReversionInHashes): file headers precede the
    // first @@, so content lines beginning with "--"/"++" are counted, not skipped.
    const lines = diff.split('\n');
    let additions = 0, deletions = 0;
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
    pairStats.push({ additions, deletions });
  }

  if (pairStats.length < 2) return false; // Need at least 2 pairs to detect rollback

  // Check for inverse pair pattern
  let inversePairs = 0;
  const MIN_ROLLBACK_LINES = 10; // Minimum total changed lines to consider a pair as rollback-scale
  for (let i = 0; i < pairStats.length - 1; i++) {
    const a = pairStats[i];
    const b = pairStats[i + 1];
    // Tolerance: allow up to 5 lines difference or 20% of total changed lines
    const totalChanged = a.additions + a.deletions + b.additions + b.deletions;
    const tolerance = Math.max(5, Math.ceil(totalChanged * 0.2));
    // Rollback asymmetry: one pair must be mostly additions, the other mostly deletions.
    // This distinguishes a clean rollback (+30/-0 then +0/-30) from oscillation (+4/-2 then +2/-4).
    // For rollback, the ratio of additions to total change should be extreme for at least one pair.
    const aTotal = a.additions + a.deletions;
    const bTotal = b.additions + b.deletions;
    const aAddRatio = aTotal > 0 ? a.additions / aTotal : 0;
    const bAddRatio = bTotal > 0 ? b.additions / bTotal : 0;
    const isAsymmetric = (aAddRatio >= 0.8 || aAddRatio <= 0.2) && (bAddRatio >= 0.8 || bAddRatio <= 0.2);
    if (
      Math.abs(a.additions - b.deletions) <= tolerance &&
      Math.abs(a.deletions - b.additions) <= tolerance &&
      totalChanged >= MIN_ROLLBACK_LINES &&
      isAsymmetric
    ) {
      inversePairs++;
    }
  }

  // A clean rollback has exactly 1 inverse pair (one add-then-remove cycle).
  // More than 1 inverse pair means repeated add-remove-add-remove = true oscillation.
  return inversePairs === 1;
}

// Detects true oscillation: returns { detected: bool, fileSet: string[] }
//
// Algorithm: collapse consecutive identical file sets into run-groups first,
// then count how many times each file set's group appears in the collapsed
// sequence. This correctly handles patterns like A A A B B A A B B B A A
// (3 A-groups, 2 B-groups → oscillation at depth 3) while ignoring simple
// iterative refinement like A A A (1 A-group → not oscillation).
//
// Multi-pass filtering (in order):
// 1. Run-group depth check (>= depth run-groups)
// 2. Content reversion check (net change <= 0 AND deletions)
// 3. Cycle count gate (>= min_cycles full oscillation cycles)
// 4. Commit message intent (rollback keywords on net-negative commits)
// 5. Diff-level rollback (exactly 1 inverse pair = clean rollback)
//
// hashes: commit hashes array (newest-first, same order as fileSets)
// gitRoot: git repository root (used for diff-based reversion check)
// options: { minCycles, rollbackDetection } — both optional, default to 0/false
function detectOscillation(fileSets, depth, hashes, gitRoot, options) {
  // Step 1: collapse consecutive identical file sets into runs, tracking indices
  const runs = [];
  for (let i = 0; i < fileSets.length; i++) {
    const files = fileSets[i];
    const key = files.slice().sort().join('\0');
    if (runs.length === 0 || runs[runs.length - 1].key !== key) {
      runs.push({ key, files, indices: [i] });
    } else {
      runs[runs.length - 1].indices.push(i);
    }
  }

  // Step 2: count run-group occurrences per file set key, tracking which runs belong to each key
  const keyRuns = new Map(); // key → array of run objects
  for (const run of runs) {
    if (!keyRuns.has(run.key)) keyRuns.set(run.key, []);
    keyRuns.get(run.key).push(run);
  }

  // Step 3: any file set with >= depth run-groups is a candidate for oscillation
  for (const [key, keyRunList] of keyRuns) {
    if (keyRunList.length >= depth) {
      const files = key.split('\0').filter(f => f.length > 0);

      // An empty file-set key arises from merge commits: `git diff-tree` (no `-m`)
      // attributes no files to a merge, so N interleaved merges in a one-PR-per-commit
      // workflow produce N empty run-groups that exactly satisfy depth/min_cycles — a
      // phantom "(unknown)" oscillation with no real file set. The reversion second-pass
      // can't redeem it either (it diffs `files=[]` → the whole repo between merges).
      // Never treat the empty set as an oscillation candidate.
      if (files.length === 0) continue;

      // Second-pass reversion check (if hashes and gitRoot provided)
      if (hashes && gitRoot && hashes.length > 0) {
        // Collect all hashes from the oscillating run-groups (newest-first order preserved)
        const oscillatingHashes = [];
        for (const run of keyRunList) {
          for (const idx of run.indices) {
            if (idx < hashes.length) oscillatingHashes.push(hashes[idx]);
          }
        }
        // Sort by index position (newest-first as they appear in hashes array)
        // The indices are already ordered since we iterate runs in order

        // Collect pair stats for rollback intent detection
        const pairStats = [];
        const isRealOscillation = hasReversionInHashes(gitRoot, oscillatingHashes, files, pairStats);
        if (!isRealOscillation) {
          // All additive → TDD progression, not a real loop
          continue;
        }

        // Cycle count gate: require at least min_cycles full oscillation cycles.
        // min_cycles defaults to 0 for backward compat (config default is 2).
        const minCycles = (options && options.minCycles) || 0;
        if (minCycles > 0 && countOscillationCycles(keyRunList) < minCycles) {
          // Not enough cycles — single rollback or short pattern
          continue;
        }

        // Rollback detection: diff-level analysis + commit message corroboration
        // Only applies at the borderline (cycles == minCycles).
        // With cycles > minCycles, the pattern is sustained enough to be real oscillation
        // even if a commit message uses "revert" keywords.
        //
        // Two independent paths to suppression:
        // Path A: Clean inverse diff (asymmetric add→remove) — strong structural signal
        // Path B: BOTH intent keyword AND clean inverse diff — corroborated signal
        //         (keyword alone is insufficient — true oscillation often has "revert" commits)
        const cycles = countOscillationCycles(keyRunList);
        if (options && options.rollbackDetection && cycles === minCycles) {
          // Expensive check: diff-level inverse pair analysis (asymmetric add→remove)
          const cleanRollback = isCleanRollback(gitRoot, oscillatingHashes, files);

          if (cleanRollback) {
            // Path A: strong structural signal — clean one-shot rollback
            continue;
          }

          // Path B: keyword alone is NOT sufficient (true oscillation often says "revert")
          // Removed: hasRollbackIntent as a standalone gate.
          // Intent keywords are only useful for Haiku classification (see consultHaiku).
        }
      }

      return { detected: true, fileSet: files };
    }
  }
  return { detected: false, fileSet: [] };
}

// Consults Claude Haiku to verify whether detected oscillation is genuine
// (a real bug loop) or iterative refinement (the same files improved repeatedly).
// Returns 'GENUINE', 'REFINEMENT', or null if the API is unavailable.
async function consultHaiku(gitRoot, fileSet, fileSets, model) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const logResult = spawnSync('git', ['log', '--oneline', '-10'], {
    cwd: gitRoot, encoding: 'utf8', timeout: 5000,
  });
  const gitLog = logResult.stdout || '(unavailable)';

  // Collect short diffs for the oscillating commits
  const hashResult = spawnSync('git', ['log', '--format=%H', '-10'], {
    cwd: gitRoot, encoding: 'utf8', timeout: 5000,
  });
  const hashes = (hashResult.stdout || '').trim().split('\n').filter(Boolean);
  const diffs = [];
  for (const hash of hashes.slice(0, 8)) {
    const d = spawnSync('git', ['diff-tree', '-p', '--no-commit-id', '-r', hash], {
      cwd: gitRoot, encoding: 'utf8', timeout: 5000,
    });
    if (d.stdout) diffs.push(`--- ${hash.slice(0, 7)} ---\n${d.stdout.slice(0, 800)}`);
  }

  const prompt =
    `You are a circuit breaker analyzer for a coding agent. A potential oscillation pattern was detected.\n\n` +
    `Oscillating file set: ${fileSet.join(', ')}\n\n` +
    `Recent git log:\n${gitLog}\n\n` +
    `Recent diffs (truncated):\n${diffs.join('\n\n').slice(0, 3000)}\n\n` +
    `Question: Is this GENUINE oscillation (the same bug being introduced and fixed repeatedly, agent stuck in a loop), ` +
    `REFINEMENT (developer/agent iteratively improving the same files toward a clear goal, e.g. adjusting a banner message, tuning output), ` +
    `or DELIBERATE_ROLLBACK (a feature was intentionally added then cleanly removed in a deliberate one-shot revert, not a bug loop)?\n\n` +
    `Reply with exactly one word: GENUINE, REFINEMENT, or DELIBERATE_ROLLBACK`;

  const https = require('https');
  const body = JSON.stringify({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve) => {
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
      timeout: 12000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = ((parsed.content || [])[0] || {}).text || '';
          const verdict = text.trim().toUpperCase();
          if (verdict.startsWith('DELIBERATE_ROLLBACK')) resolve('DELIBERATE_ROLLBACK');
          else if (verdict.startsWith('REFINEMENT')) resolve('REFINEMENT');
          else resolve('GENUINE');
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Writes state file
function writeState(statePath, fileSet, snapshot) {
  try {
    const stateDir = path.dirname(statePath);
    fs.mkdirSync(stateDir, { recursive: true });
    const state = {
      active: true,
      file_set: fileSet,
      activated_at: new Date().toISOString(),
      commit_window_snapshot: snapshot
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[nf] WARNING: Could not write circuit breaker state: ${e.message}\n`);
    // Fail-open: do not block execution
  }
}

// Appends a false-negative entry to .claude/circuit-breaker-false-negatives.json
// for audit trail when Haiku classifies detected oscillation as REFINEMENT or DELIBERATE_ROLLBACK.
// Fail-open: any error is logged to stderr but does not block the tool call.
function appendFalseNegative(statePath, fileSet, verdict) {
  try {
    const fnLogPath = statePath.replace('circuit-breaker-state.json', 'circuit-breaker-false-negatives.json');
    let existing = [];
    if (fs.existsSync(fnLogPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(fnLogPath, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
    }
    existing.push({
      detected_at: new Date().toISOString(),
      file_set: fileSet,
      reviewer: 'haiku',
      verdict: verdict || 'REFINEMENT',
    });
    fs.writeFileSync(fnLogPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[nf] WARNING: Could not write false-negative log: ${e.message}\n`);
    // Fail-open: do not block execution
  }
}

// Returns path to oscillation log file for the given git root
function getOscillationLogPath(gitRoot) {
  return path.join(gitRoot, '.planning', 'oscillation-log.json');
}

// Reads oscillation log, returns {} on missing or parse error
function readOscillationLog(logPath) {
  if (!fs.existsSync(logPath)) return {};
  try { return JSON.parse(fs.readFileSync(logPath, 'utf8')); }
  catch { return {}; }
}

// Writes oscillation log, fails open with stderr warning
function writeOscillationLog(logPath, log) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[nf] WARNING: Could not write oscillation log: ${e.message}\n`);
  }
}

// ── Evidence persistence for cross-session oscillation signatures ────────────

// Evidence file path
function getEvidencePath(gitRoot) {
  return path.join(gitRoot, '.planning', 'formal', 'evidence', 'oscillation-signatures.json');
}

// Writes/updates an oscillation signature to the evidence file.
// Fail-open: any error is logged to stderr but never blocks tool calls.
function writeEvidenceSignature(gitRoot, fileSet, fileSets, fileSetHash, patternHash) {
  try {
    const evidencePath = getEvidencePath(gitRoot);
    const dir = path.dirname(evidencePath);
    fs.mkdirSync(dir, { recursive: true });

    let data = { schema_version: 1, signatures: [] };
    if (fs.existsSync(evidencePath)) {
      try {
        data = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        if (!data || !Array.isArray(data.signatures)) {
          data = { schema_version: 1, signatures: [] };
        }
      } catch {
        data = { schema_version: 1, signatures: [] };
      }
    }

    const now = new Date().toISOString();
    const existingIdx = data.signatures.findIndex(s => s.file_set_hash === fileSetHash);
    if (existingIdx >= 0) {
      // Update existing entry
      data.signatures[existingIdx].alternation_count += 1;
      data.signatures[existingIdx].time_window.last_seen = now;
      data.signatures[existingIdx].pattern_hash = patternHash;
    } else {
      // Push new entry
      data.signatures.push({
        id: `sig_${fileSetHash}`,
        file_set_hash: fileSetHash,
        pattern_hash: patternHash,
        files: fileSet.slice().sort(),
        alternation_count: 1,
        time_window: { first_seen: now, last_seen: now },
        resolved_at: null,
        resolved_by_commit: null,
        session_id: process.env.SESSION_ID || null,
      });
    }

    // Cap at 50 entries sorted by last_seen descending
    data.signatures.sort((a, b) => (b.time_window.last_seen || '').localeCompare(a.time_window.last_seen || ''));
    if (data.signatures.length > 50) {
      data.signatures = data.signatures.slice(0, 50);
    }

    fs.writeFileSync(evidencePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[nf] WARNING: Could not write evidence signature: ${e.message}\n`);
    // Fail-open: do not block execution
  }
}

// Checks for known unresolved oscillation signatures matching current file sets.
// Prunes entries older than 30 days. Returns matching signature or null.
// Fail-open: returns null on any error.
function checkPreemptiveEvidence(gitRoot, fileSets) {
  try {
    const evidencePath = getEvidencePath(gitRoot);
    if (!fs.existsSync(evidencePath)) return null;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    } catch {
      return null;
    }
    if (!data || !Array.isArray(data.signatures)) return null;

    // Prune entries older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const beforeLen = data.signatures.length;
    data.signatures = data.signatures.filter(s =>
      (s.time_window && s.time_window.last_seen) ? s.time_window.last_seen >= thirtyDaysAgo : true
    );
    // Write back if pruned
    if (data.signatures.length !== beforeLen) {
      try {
        fs.writeFileSync(evidencePath, JSON.stringify(data, null, 2), 'utf8');
      } catch { /* fail-open */ }
    }

    // Build hashes for current file sets
    const currentHashes = new Set();
    for (const fs2 of fileSets) {
      if (fs2.length > 0) {
        currentHashes.add(makeFileSetHash(fs2));
      }
    }

    // Check for unresolved signatures matching current file sets
    for (const sig of data.signatures) {
      if (sig.resolved_at === null && currentHashes.has(sig.file_set_hash)) {
        return sig;
      }
    }

    return null;
  } catch {
    return null; // Fail-open
  }
}

// Marks an evidence signature as resolved.
// Fail-open: any error is logged to stderr but never blocks tool calls.
function markEvidenceResolved(gitRoot, fileSetHash, commit) {
  try {
    const evidencePath = getEvidencePath(gitRoot);
    if (!fs.existsSync(evidencePath)) return;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    } catch {
      return;
    }
    if (!data || !Array.isArray(data.signatures)) return;

    const entry = data.signatures.find(s => s.file_set_hash === fileSetHash);
    if (entry) {
      entry.resolved_at = new Date().toISOString();
      entry.resolved_by_commit = commit || null;
      fs.writeFileSync(evidencePath, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (e) {
    process.stderr.write(`[nf] WARNING: Could not mark evidence resolved: ${e.message}\n`);
    // Fail-open
  }
}

// SHA-1 of sorted file list, 12 hex chars
function makeFileSetHash(files) {
  return crypto.createHash('sha1')
    .update(files.slice().sort().join('\0'))
    .digest('hex').slice(0, 12);
}

// SHA-1 of run-group sequence (same collapse as detectOscillation step 1), 12 hex chars
function makePatternHash(fileSets) {
  const runKeys = [];
  for (const files of fileSets) {
    const key = files.slice().sort().join('\0');
    if (runKeys.length === 0 || runKeys[runKeys.length - 1] !== key) {
      runKeys.push(key);
    }
  }
  return crypto.createHash('sha1')
    .update(runKeys.join('|'))
    .digest('hex').slice(0, 12);
}

// Appends a structured conformance event to .planning/conformance-events.jsonl.
// Uses appendFileSync (atomic for writes < POSIX PIPE_BUF = 4096 bytes).
// Always wrapped in try/catch — hooks are fail-open; never crashes on logging failure.
// NEVER writes to stdout — stdout is the Claude Code hook decision channel.
function appendConformanceEvent(event) {
  try {
    const pp = require(resolveBin('planning-paths.cjs'));
    const logPath = pp.resolve(process.cwd(), 'conformance-events');
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write('[nf] conformance log write failed: ' + err.message + '\n');
  }
}

// Builds the deny reason block for when the circuit breaker is active.
// Returns a message explaining the block and how to resolve it.
function buildBlockReason(state) {
  const fileList = (state.file_set || []).join(', ') || '(unknown)';
  const snapshot = state.commit_window_snapshot;
  const lines = [
    'CIRCUIT BREAKER ACTIVE',
    '',
    'Oscillating file set: ' + fileList,
    '',
  ];
  if (Array.isArray(snapshot) && snapshot.length > 0) {
    lines.push('Commit Graph (most recent first):');
    lines.push('| # | Files Changed |');
    lines.push('|---|---------------|');
    snapshot.forEach((files, index) => {
      const fileStr = Array.isArray(files) && files.length > 0 ? files.join(', ') : '(empty)';
      lines.push(`| ${index + 1} | ${fileStr} |`);
    });
    lines.push('');
  } else {
    lines.push('(commit graph unavailable)');
    lines.push('');
  }
  lines.push(
    'Invoke Oscillation Resolution Mode per R5 — see ~/.claude/nf/workflows/oscillation-resolution-mode.md for the full procedure.',
    '',
    'Read-only operations are still allowed (e.g. git log --oneline to review the commit history).',
    'You must manually commit a root-cause fix before write operations are unblocked.',
    '',
    "After committing the fix, run 'npx nforma --reset-breaker' to clear the circuit breaker state.",
    "If this was deliberate iterative work rather than a bug loop, run 'npx nforma --disable-breaker' to dismiss and continue; re-enable with 'npx nforma --enable-breaker' when done.",
  );
  return lines.join('\n');
}

// Builds the priority warning notice for the allow decision
// Returns a message Claude will see in the hook output (non-blocking notification)
function buildWarningNotice(state) {
  const fileList = (state.file_set || []).join(', ') || '(unknown)';
  const snapshot = state.commit_window_snapshot;
  const lines = [
    'OSCILLATION DETECTED — PRIORITY NOTICE',
    '',
    'Oscillating file set: ' + fileList,
    '',
    'Fix the oscillation in the listed files before continuing.',
    'Run git log to see the pattern. Do NOT make more commits to these files until the root cause is resolved.',
    '',
  ];

  if (Array.isArray(snapshot) && snapshot.length > 0) {
    lines.push('Commit Graph (most recent first):');
    lines.push('| # | Files Changed |');
    lines.push('|---|---------------|');
    snapshot.forEach((files, index) => {
      const fileStr = Array.isArray(files) && files.length > 0 ? files.join(', ') : '(empty)';
      lines.push(`| ${index + 1} | ${fileStr} |`);
    });
    lines.push('');
  }

  lines.push(
    'Invoke Oscillation Resolution Mode per R5 — see ~/.claude/nf/workflows/oscillation-resolution-mode.md for the full procedure.',
    '',
    'After committing the fix, run \'npx nforma --reset-breaker\' to clear the circuit breaker state.',
    'To temporarily disable the circuit breaker for deliberate iterative work, run \'npx nforma --disable-breaker\'.',
    'Re-enable with \'npx nforma --enable-breaker\' when done.'
  );

  return lines.join('\n');
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(raw);
      const eventType = input.hook_event_name || input.hookEventName || 'PreToolUse';
      const validation = validateHookInput(eventType, input);
      if (!validation.valid) {
        process.stderr.write('[nf] WARNING: nf-circuit-breaker: invalid input: ' + JSON.stringify(validation.errors) + '\n');
        process.exit(0); // Fail-open
      }
      const cwd = input.cwd || process.cwd();

      const hookEvent = eventType;
      const toolName = input.tool_name || input.toolName || '';

      // Get git root — shared by both handlers
      const gitRoot = getGitRoot(cwd);
      if (!gitRoot) {
        process.exit(0); // DETECT-05: not a git repo
      }

      const config = loadConfig(gitRoot);
      const logPath = getOscillationLogPath(gitRoot);

      // ── PostToolUse: Haiku convergence check ─────────────────────────────
      if (hookEvent === 'PostToolUse' && toolName === 'Bash') {
        const log = readOscillationLog(logPath);
        const activeKeys = Object.keys(log).filter(k => !log[k].resolvedAt);
        if (activeKeys.length === 0) process.exit(0);

        const toolOutput = (input.tool_response &&
          (input.tool_response.output || input.tool_response.stdout)) || '';
        const lastCommitResult = spawnSync('git', ['log', '--oneline', '-1'], {
          cwd: gitRoot, encoding: 'utf8', timeout: 5000,
        });
        const lastCommit = (lastCommitResult.stdout || '').trim();

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) process.exit(0);

        const activeEntry = log[activeKeys[0]];
        const haikuPrompt =
          `You are a circuit breaker monitor. An oscillation was detected on files: ${activeEntry.files.join(', ')}.\n\n` +
          `A Bash command just completed. Output (truncated):\n${toolOutput.slice(0, 2000)}\n\n` +
          `Last git commit: ${lastCommit}\n\n` +
          `Does this output indicate the oscillation has been resolved (e.g. tests passing, fix committed)?\n` +
          `Reply with exactly one word: YES or NO`;

        const requestBody = JSON.stringify({
          model: config.circuit_breaker.haiku_model,
          max_tokens: 10,
          messages: [{ role: 'user', content: haikuPrompt }],
        });

        const nodeScript = `
const https = require('https');
const body = process.env.HAIKU_BODY;
const apiKey = process.env.ANTHROPIC_API_KEY;
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
  timeout: 12000,
}, (res) => {
  let d = '';
  res.on('data', c => { d += c; });
  res.on('end', () => {
    try {
      const p = JSON.parse(d);
      process.stdout.write(((p.content||[])[0]||{}).text||'NO');
    } catch { process.stdout.write('NO'); }
  });
});
req.on('error', () => process.stdout.write('NO'));
req.on('timeout', () => { req.destroy(); process.stdout.write('NO'); });
req.write(body);
req.end();
`;

        try {
          const spawnResult = spawnSync('node', ['-e', nodeScript], {
            env: { ...process.env, HAIKU_BODY: requestBody },
            encoding: 'utf8',
            timeout: 15000,
          });
          const verdict = (spawnResult.stdout || '').trim().toUpperCase();

          if (verdict.startsWith('YES')) {
            const resolvedHashResult = spawnSync('git', ['log', '--format=%H', '-1'], {
              cwd: gitRoot, encoding: 'utf8', timeout: 5000,
            });
            const resolvedCommit = (resolvedHashResult.stdout || '').trim() || null;
            const now = new Date().toISOString();
            for (const k of activeKeys) {
              log[k].resolvedAt = now;
              log[k].resolvedByCommit = resolvedCommit;
              log[k].haikuRationale = `Haiku YES on Bash output; last commit: ${lastCommit}`;
            }
            writeOscillationLog(logPath, log);
            // Clear state file so PreToolUse stops warning
            const statePath = path.join(gitRoot, '.claude', 'circuit-breaker-state.json');
            try { if (fs.existsSync(statePath)) fs.rmSync(statePath); } catch {}
            // Mark evidence signature as resolved
            if (activeEntry && activeEntry.files) {
              markEvidenceResolved(gitRoot, makeFileSetHash(activeEntry.files), resolvedCommit);
            }
            process.stderr.write(`[nf] INFO: Oscillation resolved by Haiku — circuit breaker cleared.\n`);
          }
        } catch (e) {
          process.stderr.write(`[nf] WARNING: PostToolUse Haiku check failed: ${e.message}\n`);
        }
        process.exit(0);
      }

      // ── PreToolUse: oscillation detection + notification ─────────────────
      const command = (input.tool_input && input.tool_input.command) || '';

      // Check existing state
      const statePath = path.join(gitRoot, '.claude', 'circuit-breaker-state.json');
      const state = readState(statePath);

      // DISABLE-01: If circuit breaker is disabled, skip all detection and notification
      if (state && state.disabled) {
        process.exit(0);
      }

      // DETECT-04: Skip detection for read-only commands (BEFORE active state check)
      if (isReadOnly(command)) {
        process.exit(0);
      }

      if (state && state.active) {
        // Check if already resolved in log
        const fileSetHash = makeFileSetHash(state.file_set || []);
        const logKey = `${fileSetHash}:legacy`;
        const log = readOscillationLog(logPath);
        if (log[logKey] && log[logKey].resolvedAt) {
          process.exit(0); // Already resolved
        }
        // Breaker already active — emit deny decision
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: buildBlockReason(state),
          }
        }));
        process.exit(0);
      }

      const hashes = getCommitHashes(gitRoot, config.circuit_breaker.commit_window);
      const fileSets = getCommitFileSets(gitRoot, hashes);

      // Preemptive evidence check: warn about known unresolved signatures
      const preemptiveMatch = checkPreemptiveEvidence(gitRoot, fileSets);
      if (preemptiveMatch) {
        process.stderr.write(`[nf] WARNING: Known unresolved oscillation signature detected (${preemptiveMatch.id}, files: ${(preemptiveMatch.files || []).join(', ')}). Review .planning/formal/evidence/oscillation-signatures.json for details.\n`);
      }

      // Detect oscillation
      const result = detectOscillation(fileSets, config.circuit_breaker.oscillation_depth, hashes, gitRoot, {
        minCycles: config.circuit_breaker.min_cycles || 0,
        rollbackDetection: config.circuit_breaker.rollback_detection !== false,
      });
      if (!result.detected) {
        process.exit(0);
      }

      // HAIKU-01: Consult Haiku to verify before notifying (if enabled)
      if (config.circuit_breaker.haiku_reviewer) {
        const verdict = await consultHaiku(gitRoot, result.fileSet, fileSets, config.circuit_breaker.haiku_model);
        if (verdict === 'REFINEMENT' || verdict === 'DELIBERATE_ROLLBACK') {
          // Haiku confirmed this is iterative refinement or deliberate rollback, not a bug loop — do not notify.
          // Log false-negative for auditability (stderr + persistent file).
          process.stderr.write(`[nf] INFO: circuit breaker false-negative — Haiku classified oscillation as ${verdict} (files: ${result.fileSet.join(', ')}). Allowing tool call to proceed.\n`);
          appendFalseNegative(statePath, result.fileSet, verdict);
          process.exit(0);
        }
        // verdict === 'GENUINE' or null (API unavailable) → trust the algorithm and notify
      }

      // Log-based suppression: if this exact oscillation was already resolved, skip
      const fileSetHash = makeFileSetHash(result.fileSet);
      const patternHash = makePatternHash(fileSets);
      const logKey = `${fileSetHash}:${patternHash}`;
      const oscLog = readOscillationLog(logPath);
      if (oscLog[logKey] && oscLog[logKey].resolvedAt) {
        // Already resolved — suppress warning entirely
        process.exit(0);
      }
      // Upsert log entry
      oscLog[logKey] = {
        files: result.fileSet.slice().sort(),
        pattern: fileSets.map(s => s.slice().sort().join(',')).join(' | '),
        firstSeen: (oscLog[logKey] && oscLog[logKey].firstSeen) ? oscLog[logKey].firstSeen : new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        resolvedAt: null,
        resolvedByCommit: null,
        haikuRationale: null,
        manualResetAt: (oscLog[logKey] && oscLog[logKey].manualResetAt) ? oscLog[logKey].manualResetAt : null,
      };
      writeOscillationLog(logPath, oscLog);

      // Write state so nf-prompt.js picks it up on next user message
      writeState(statePath, result.fileSet, fileSets);

      // Persist oscillation signature for cross-session evidence
      writeEvidenceSignature(gitRoot, result.fileSet, fileSets, fileSetHash, patternHash);

      appendConformanceEvent({
        ts:              new Date().toISOString(),
        phase:           'IDLE',
        action:          'circuit_break',
        slots_available: 0,
        vote_result:     null,
        outcome:         'BLOCK',
        schema_version,
      });

      // State written — exit silently on first detection (warning emitted on next call via active state path)
      process.exit(0);
    } catch (e) {
      if (e instanceof SyntaxError) {
        process.stderr.write('[nf] WARNING: nf-circuit-breaker: malformed JSON on stdin: ' + e.message + '\n');
      }
      process.exit(0); // Fail-open on any error
    }
  });
}

if (require.main === module) main();

module.exports = {
  buildWarningNotice,
  buildBlockReason,
  writeEvidenceSignature,
  checkPreemptiveEvidence,
  markEvidenceResolved,
  makeFileSetHash,
  makePatternHash,
  getEvidencePath,
  hasReversionInHashes,
  detectOscillation,
  countOscillationCycles,
  getCommitMessages,
  hasRollbackIntent,
  isCleanRollback,
  ROLLBACK_KEYWORDS,
};

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark