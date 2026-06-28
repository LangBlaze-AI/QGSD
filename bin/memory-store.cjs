#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = '.planning/memory';
const FILES = {
  decisions: 'decisions.jsonl',
  errors: 'errors.jsonl',
  quorum: 'quorum-decisions.jsonl',
  corrections: 'corrections.jsonl',
  skills: 'skills.jsonl',
  failures: 'failures.jsonl',
};

/**
 * Returns path to JSONL file for a given category.
 * Creates directory if missing.
 */
function getMemoryPath(cwd, category) {
  const dir = path.join(cwd, MEMORY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, FILES[category]);
}

/**
 * Appends a JSON line with ts field added.
 */
function appendEntry(cwd, category, entry) {
  const filePath = getMemoryPath(cwd, category);
  const enriched = { ...entry, ts: new Date().toISOString() };
  const line = JSON.stringify(enriched) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
  return enriched;
}

/**
 * Reads last N entries from a JSONL file.
 * Returns [] if file missing. Skips malformed lines.
 */
function readLastN(cwd, category, n = 5) {
  const filePath = getMemoryPath(cwd, category);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Searches entries by field value (case-insensitive substring).
 * Also matches on tags array. Returns newest-first, up to limit.
 */
function queryByField(cwd, category, field, keyword, limit = 5) {
  const filePath = getMemoryPath(cwd, category);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const kw = keyword.toLowerCase();
  const matches = [];
  for (let i = lines.length - 1; i >= 0 && matches.length < limit; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const fieldVal = (entry[field] || '').toLowerCase();
      const tagsVal = (entry.tags || []).join(' ').toLowerCase();
      if (fieldVal.includes(kw) || tagsVal.includes(kw)) {
        matches.push(entry);
      }
    } catch { /* skip malformed lines */ }
  }
  return matches;
}

/**
 * Checks if a similar entry exists in recent history (bidirectional substring).
 */
function isDuplicate(cwd, category, field, value, checkLast = 10) {
  const recent = readLastN(cwd, category, checkLast);
  const needle = value.toLowerCase();
  return recent.some(e => {
    const hay = (typeof e[field] === 'string' ? e[field] : '').toLowerCase();
    if (!hay) return false;
    return hay.includes(needle) || needle.includes(hay);
  });
}

/**
 * Counts non-empty lines in JSONL file. Returns 0 if file missing.
 */
function countEntries(cwd, category) {
  const filePath = getMemoryPath(cwd, category);
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return 0;
  return content.split('\n').filter(Boolean).length;
}

/**
 * Generates a session reminder string from memory stores.
 * Returns null if no entries exist. Hard cap at 800 characters.
 */
function generateSessionReminder(cwd) {
  const decisions = readLastN(cwd, 'decisions', 3);
  const errorCount = countEntries(cwd, 'errors');
  const quorumCount = countEntries(cwd, 'quorum');

  if (decisions.length === 0 && errorCount === 0 && quorumCount === 0) return null;

  const lines = ['SESSION MEMORY REMINDER:'];

  if (decisions.length > 0) {
    lines.push('');
    lines.push('Recent decisions:');
    for (const d of decisions) {
      const phase = d.phase ? `[${d.phase}]` : '';
      lines.push(`  - ${phase} ${d.summary} (${d.source || 'unknown'})`);
    }
  }

  if (errorCount > 0) {
    lines.push('');
    lines.push(`Error patterns: ${errorCount} entries (query: node bin/memory-store.cjs query-errors --symptom "<keyword>")`);
  }

  if (quorumCount > 0) {
    lines.push('');
    lines.push(`Quorum decisions: ${quorumCount} entries (query: node bin/memory-store.cjs query-quorum --last 5)`);
  }

  const result = lines.join('\n');
  return result.length > 800 ? result.slice(0, 797) + '...' : result;
}

/**
 * Formats memory injection for compaction context.
 * Returns null if no entries. Hard cap at 1200 characters.
 */
function formatMemoryInjection(cwd) {
  const decisions = readLastN(cwd, 'decisions', 3);
  const recentErrors = readLastN(cwd, 'errors', 2);

  if (decisions.length === 0 && recentErrors.length === 0) return null;

  const lines = ['## Memory Snapshot (auto-injected at compaction)', ''];

  if (decisions.length > 0) {
    lines.push('Last decisions:');
    for (const d of decisions) {
      const phase = d.phase ? `[${d.phase}]` : '';
      lines.push(`  - ${phase} ${d.summary}`);
    }
  }

  if (recentErrors.length > 0) {
    lines.push('');
    lines.push('Recent error fixes:');
    for (const e of recentErrors) {
      const symptom = (e.symptom || '').length > 60 ? e.symptom.slice(0, 57) + '...' : (e.symptom || '');
      const fix = (e.fix || '').length > 60 ? e.fix.slice(0, 57) + '...' : (e.fix || '');
      lines.push(`  - ${symptom} -> ${fix}`);
    }
  }

  lines.push('');
  lines.push('Query more: node bin/memory-store.cjs query-decisions --last 10');

  const result = lines.join('\n');
  return result.length > 1200 ? result.slice(0, 1197) + '...' : result;
}

/**
 * Prunes entries older than N days. Returns { removed, remaining }.
 */
function pruneOlderThan(cwd, category, days = 90) {
  const filePath = getMemoryPath(cwd, category);
  if (!fs.existsSync(filePath)) return { removed: 0, remaining: 0 };

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return { removed: 0, remaining: 0 };

  const lines = content.split('\n').filter(Boolean);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const kept = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.ts && new Date(entry.ts) < cutoff) {
        removed++;
      } else {
        kept.push(line);
      }
    } catch {
      // Keep malformed lines (don't silently discard data)
      kept.push(line);
    }
  }

  if (kept.length > 0) {
    fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf8');
  } else {
    fs.writeFileSync(filePath, '', 'utf8');
  }

  return { removed, remaining: kept.length };
}

/**
 * Computes current confidence for a failure entry with weekly decay.
 * Returns stored confidence minus 0.05 per week since last_confirmed, floor 0.1.
 */
function computeCurrentConfidence(entry) {
  if (!entry || !entry.confidence || !entry.last_confirmed) {
    return (entry && entry.confidence) || 0.7;
  }
  const lastMs = new Date(entry.last_confirmed).getTime();
  if (Number.isNaN(lastMs)) {
    return entry.confidence || 0.7;
  }
  const daysSinceConfirmed = (Date.now() - lastMs) / (86400 * 1000);
  const weekDecay = Math.floor(daysSinceConfirmed / 7) * 0.05;
  return Math.max(0.1, entry.confidence - weekDecay);
}

/**
 * Boosts confidence for a failure entry matching approach (case-insensitive substring).
 * Returns the updated entry or null if not found.
 */
function boostConfidence(cwd, approach) {
  const filePath = getMemoryPath(cwd, 'failures');
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return null;

  const lines = content.split('\n').filter(Boolean);
  const needle = approach.toLowerCase();
  let foundIdx = -1;
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      entries.push(entry);
      if (foundIdx === -1 && (entry.approach || '').toLowerCase().includes(needle)) {
        foundIdx = i;
      }
    } catch {
      entries.push(null); // keep line position
    }
  }

  if (foundIdx === -1) return null;

  const target = entries[foundIdx];
  target.confidence = Math.min(1.0, (target.confidence || 0.7) + 0.2);
  target.last_confirmed = new Date().toISOString();
  target.confirmation_count = (target.confirmation_count || 1) + 1;

  // Rewrite file
  const newLines = lines.map((line, i) => {
    if (i === foundIdx) return JSON.stringify(target);
    return line;
  });
  fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf8');

  return target;
}

/**
 * Query entries filtered by computed confidence >= minConfidence.
 * Sorted by confidence descending. Primarily for failures category.
 */
function queryWithConfidence(cwd, category, field, keyword, minConfidence = 0.3, limit = 5) {
  const filePath = getMemoryPath(cwd, category);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];

  const lines = content.split('\n').filter(Boolean);
  const kw = keyword ? keyword.toLowerCase() : '';
  const matches = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const currentConf = computeCurrentConfidence(entry);
      if (currentConf < minConfidence) continue;

      if (kw) {
        const fieldVal = (entry[field] || '').toLowerCase();
        const tagsVal = (entry.tags || []).join(' ').toLowerCase();
        if (!fieldVal.includes(kw) && !tagsVal.includes(kw)) continue;
      }

      matches.push({ ...entry, _currentConfidence: currentConf });
    } catch { /* skip malformed */ }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b._currentConfidence - a._currentConfidence);
  return matches.slice(0, limit);
}

// ─── CLI interface ──────────────────────────────────────────────────────────

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const command = args[0];
    const cwd = process.cwd();

    function getArg(name) {
      const idx = args.indexOf('--' + name);
      if (idx === -1 || idx + 1 >= args.length) return null;
      return args[idx + 1];
    }

    switch (command) {
      case 'append-decision': {
        const summary = getArg('summary');
        if (!summary) { process.stderr.write('Missing --summary\n'); process.exit(0); }
        if (isDuplicate(cwd, 'decisions', 'summary', summary)) {
          const existing = readLastN(cwd, 'decisions', 10).find(e =>
            e.summary && (e.summary.toLowerCase().includes(summary.toLowerCase()) ||
              summary.toLowerCase().includes(e.summary.toLowerCase()))
          );
          process.stdout.write(JSON.stringify({ skipped: true, reason: 'duplicate', existing }) + '\n');
          break;
        }
        const entry = {
          type: 'decision',
          summary,
          detail: getArg('detail') || '',
          rejected: (getArg('rejected') || '').split(',').filter(Boolean),
          tags: (getArg('tags') || '').split(',').filter(Boolean),
          source: getArg('source') || 'unknown',
          phase: getArg('phase') || '',
        };
        const result = appendEntry(cwd, 'decisions', entry);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }

      case 'append-error': {
        const symptom = getArg('symptom');
        if (!symptom) { process.stderr.write('Missing --symptom\n'); process.exit(0); }
        if (isDuplicate(cwd, 'errors', 'symptom', symptom)) {
          const existing = readLastN(cwd, 'errors', 10).find(e =>
            e.symptom && (e.symptom.toLowerCase().includes(symptom.toLowerCase()) ||
              symptom.toLowerCase().includes(e.symptom.toLowerCase()))
          );
          process.stdout.write(JSON.stringify({ skipped: true, reason: 'duplicate', existing }) + '\n');
          break;
        }
        const entry = {
          type: 'error_resolution',
          symptom,
          root_cause: getArg('root-cause') || '',
          fix: getArg('fix') || '',
          files: (getArg('files') || '').split(',').filter(Boolean),
          tags: (getArg('tags') || '').split(',').filter(Boolean),
          confidence: 'high',
        };
        const result = appendEntry(cwd, 'errors', entry);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }

      case 'append-quorum': {
        const question = getArg('question');
        if (!question) { process.stderr.write('Missing --question\n'); process.exit(0); }
        const entry = {
          type: 'quorum_decision',
          question,
          chosen: getArg('chosen') || '',
          rationale: getArg('rationale') || '',
          rejected_options: (getArg('rejected') || '').split(',').filter(Boolean),
          consensus: getArg('consensus') || '',
          rounds: parseInt(getArg('rounds') || '1', 10),
          debate_file: getArg('debate-file') || '',
        };
        const result = appendEntry(cwd, 'quorum', entry);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }

      case 'query-decisions': {
        const n = parseInt(getArg('last') || '5', 10);
        const results = readLastN(cwd, 'decisions', n);
        process.stdout.write(JSON.stringify(results) + '\n');
        break;
      }

      case 'query-errors': {
        const symptom = getArg('symptom');
        const limit = parseInt(getArg('limit') || '5', 10);
        if (symptom) {
          const results = queryByField(cwd, 'errors', 'symptom', symptom, limit);
          process.stdout.write(JSON.stringify(results) + '\n');
        } else {
          const results = readLastN(cwd, 'errors', limit);
          process.stdout.write(JSON.stringify(results) + '\n');
        }
        break;
      }

      case 'query-quorum': {
        const n = parseInt(getArg('last') || '5', 10);
        const results = readLastN(cwd, 'quorum', n);
        process.stdout.write(JSON.stringify(results) + '\n');
        break;
      }

      case 'session-reminder': {
        const reminder = generateSessionReminder(cwd);
        if (reminder) {
          process.stdout.write(JSON.stringify({ reminder }) + '\n');
        } else {
          process.stdout.write(JSON.stringify({ reminder: null }) + '\n');
        }
        break;
      }

      case 'prune': {
        const days = parseInt(getArg('days') || '90', 10);
        const results = {};
        for (const cat of Object.keys(FILES)) {
          results[cat] = pruneOlderThan(cwd, cat, days);
        }
        process.stdout.write(JSON.stringify(results) + '\n');
        break;
      }

      case 'append-correction': {
        const wrong = getArg('wrong');
        const correct = getArg('correct');
        if (!wrong || !correct) { process.stderr.write('Missing --wrong and/or --correct\n'); process.exit(0); }
        const entry = {
          type: 'correction',
          wrong_approach: wrong,
          correct_approach: correct,
          context: getArg('context') || '',
          tags: (getArg('tags') || '').split(',').filter(Boolean),
        };
        const result = appendEntry(cwd, 'corrections', entry);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }

      case 'append-skill': {
        const skill = getArg('skill');
        if (!skill) { process.stderr.write('Missing --skill\n'); process.exit(0); }
        const entry = {
          type: 'skill',
          skill,
          evidence_count: parseInt(getArg('evidence-count') || '0', 10),
          validated_by: (getArg('validated-by') || '').split(',').filter(Boolean),
          tags: (getArg('tags') || '').split(',').filter(Boolean),
          confidence: parseFloat(getArg('confidence') || '0.7'),
        };
        const result = appendEntry(cwd, 'skills', entry);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }

      case 'append-failure': {
        const approach = getArg('approach');
        const whyFailed = getArg('why-failed');
        if (!approach || !whyFailed) { process.stderr.write('Missing --approach and/or --why-failed\n'); process.exit(0); }
        if (isDuplicate(cwd, 'failures', 'approach', approach)) {
          const existing = readLastN(cwd, 'failures', 10).find(e =>
            e.approach && (e.approach.toLowerCase().includes(approach.toLowerCase()) ||
              approach.toLowerCase().includes(e.approach.toLowerCase()))
          );
          process.stdout.write(JSON.stringify({ skipped: true, reason: 'duplicate', existing }) + '\n');
          break;
        }
        const entry = {
          type: 'failure',
          approach,
          context: getArg('context') || '',
          why_failed: whyFailed,
          confidence: 0.7,
          last_confirmed: new Date().toISOString(),
          confirmation_count: 1,
          tags: (getArg('tags') || '').split(',').filter(Boolean),
        };
        const result = appendEntry(cwd, 'failures', entry);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }

      case 'query-corrections': {
        const n = parseInt(getArg('last') || '5', 10);
        const results = readLastN(cwd, 'corrections', n);
        process.stdout.write(JSON.stringify(results) + '\n');
        break;
      }

      case 'query-skills': {
        const tag = getArg('tag');
        const limit = parseInt(getArg('limit') || '5', 10);
        if (tag) {
          const results = queryByField(cwd, 'skills', 'skill', tag, limit);
          process.stdout.write(JSON.stringify(results) + '\n');
        } else {
          const results = readLastN(cwd, 'skills', limit);
          process.stdout.write(JSON.stringify(results) + '\n');
        }
        break;
      }

      case 'query-failures': {
        const tag = getArg('tag');
        const minConf = parseFloat(getArg('min-confidence') || '0.3');
        const limit = parseInt(getArg('limit') || '5', 10);
        const results = queryWithConfidence(cwd, 'failures', 'approach', tag || '', minConf, limit);
        process.stdout.write(JSON.stringify(results) + '\n');
        break;
      }

      case 'boost-failure': {
        const approach = getArg('approach');
        if (!approach) { process.stderr.write('Missing --approach\n'); process.exit(0); }
        const result = boostConfidence(cwd, approach);
        if (result) {
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          process.stdout.write(JSON.stringify({ found: false }) + '\n');
        }
        break;
      }

      case 'decay-failures': {
        const filePath = getMemoryPath(cwd, 'failures');
        if (!fs.existsSync(filePath)) {
          process.stdout.write(JSON.stringify({ updated: 0 }) + '\n');
          break;
        }
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) {
          process.stdout.write(JSON.stringify({ updated: 0 }) + '\n');
          break;
        }
        const lines = content.split('\n').filter(Boolean);
        let updated = 0;
        const newLines = lines.map(line => {
          try {
            const entry = JSON.parse(line);
            const current = computeCurrentConfidence(entry);
            if (Math.abs((entry.confidence || 0.7) - current) > 0.01) {
              entry.confidence = current;
              updated++;
              return JSON.stringify(entry);
            }
            return line;
          } catch { return line; }
        });
        if (updated > 0) {
          fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf8');
        }
        process.stdout.write(JSON.stringify({ updated }) + '\n');
        break;
      }

      case 'revalidate-errors': {
        // Quality indicators for filtering
        const QUALITY_INDICATORS = ['Error:', 'ENOENT', 'EACCES', 'EPERM', 'TypeError', 'ReferenceError', 'SyntaxError'];
        const STACK_TRACE_PATTERN = /at .+\(/;

        const filePath = getMemoryPath(cwd, 'errors');
        if (!fs.existsSync(filePath)) {
          process.stdout.write(JSON.stringify({ kept: 0, removed: 0 }) + '\n');
          break;
        }

        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) {
          process.stdout.write(JSON.stringify({ kept: 0, removed: 0 }) + '\n');
          break;
        }

        const lines = content.split('\n').filter(Boolean);
        const kept = [];
        let removed = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Filter criteria:
            // (a) symptom length <= 500
            const symptomLen = (entry.symptom || '').length;
            if (symptomLen > 500) {
              removed++;
              continue;
            }

            // (b) symptom contains at least one QUALITY_INDICATOR or stack trace pattern
            const symptom = entry.symptom || '';
            let hasIndicator = false;
            for (const indicator of QUALITY_INDICATORS) {
              if (symptom.includes(indicator)) {
                hasIndicator = true;
                break;
              }
            }
            if (!hasIndicator && !STACK_TRACE_PATTERN.test(symptom)) {
              removed++;
              continue;
            }

            // (c) fix is non-empty
            if (!entry.fix || typeof entry.fix !== 'string' || entry.fix.trim().length === 0) {
              removed++;
              continue;
            }

            // Passed all filters, keep it
            kept.push(line);
          } catch {
            // Malformed line: keep it (don't silently discard)
            kept.push(line);
          }
        }

        // Rewrite file with kept entries
        if (kept.length > 0) {
          fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf8');
        } else {
          fs.writeFileSync(filePath, '', 'utf8');
        }

        process.stdout.write(JSON.stringify({ kept: kept.length, removed }) + '\n');
        break;
      }

      default:
        process.stderr.write('Unknown command: ' + command + '\n');
        process.stderr.write('Usage: memory-store.cjs <append-decision|append-error|append-quorum|append-correction|append-skill|append-failure|query-decisions|query-errors|query-quorum|query-corrections|query-skills|query-failures|boost-failure|decay-failures|revalidate-errors|session-reminder|prune>\n');
        process.exit(0);
    }
  } catch (e) {
    process.stderr.write('[memory-store] Error: ' + e.message + '\n');
    process.exit(0); // Fail open
  }
}

module.exports = {
  getMemoryPath,
  appendEntry,
  readLastN,
  queryByField,
  isDuplicate,
  countEntries,
  generateSessionReminder,
  formatMemoryInjection,
  pruneOlderThan,
  computeCurrentConfidence,
  boostConfidence,
  queryWithConfidence,
  MEMORY_DIR,
  FILES,
};
