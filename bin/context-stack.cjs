#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const STACK_FILE = 'context-stack.jsonl';
const MAX_ENTRIES_PER_PHASE = 10;
const INJECTION_CAP_CHARS = 2000;

const VALID_TYPES = ['architecture_decision', 'test_result', 'api_contract', 'constraint'];

/**
 * Returns path to .planning/memory/context-stack.jsonl.
 * Creates directory if missing.
 */
function getStackPath(cwd) {
  const dir = path.join(cwd, '.planning', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, STACK_FILE);
}

/**
 * Reads all JSONL entries from the stack file.
 * Returns [] if file missing. Skips malformed lines.
 */
function readAllEntries(cwd) {
  const filePath = getStackPath(cwd);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Appends a context entry to the stack.
 * Validates type, enforces per-phase cap, writes JSONL line.
 */
function append(cwd, { phase, type, content, tags }) {
  // Validate type -- fail-open with fallback
  if (!VALID_TYPES.includes(type)) {
    process.stderr.write(`[context-stack] Invalid type "${type}", falling back to "constraint"\n`);
    type = 'constraint';
  }

  // Check per-phase cap
  const entries = readAllEntries(cwd);
  const phaseCount = entries.filter(e => e.phase === phase).length;
  if (phaseCount >= MAX_ENTRIES_PER_PHASE) {
    return { skipped: true, reason: 'phase_cap_reached' };
  }

  const entry = {
    phase,
    type,
    content,
    tags: tags || [],
    ts: new Date().toISOString(),
  };

  const filePath = getStackPath(cwd);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/**
 * Queries entries from recent phases, excluding currentPhase.
 * Returns entries from the last maxPhases phases.
 */
function queryRecentPhases(cwd, currentPhase, maxPhases) {
  if (maxPhases === undefined) maxPhases = 3;
  if (!Number.isFinite(maxPhases) || maxPhases <= 0) return [];
  const entries = readAllEntries(cwd);
  if (entries.length === 0) return [];

  // Get unique phases in order of appearance (preserving recency)
  const phaseOrder = [];
  const seen = new Set();
  for (const e of entries) {
    if (e.phase && !seen.has(e.phase)) {
      seen.add(e.phase);
      phaseOrder.push(e.phase);
    }
  }

  // Filter out current phase, take last N
  const filtered = phaseOrder.filter(p => p !== currentPhase);
  const recentPhases = new Set(filtered.slice(-maxPhases));

  return entries.filter(e => recentPhases.has(e.phase));
}

/**
 * Queries entries by type, newest-first, up to limit.
 */
function queryByType(cwd, type, limit) {
  if (limit === undefined) limit = 10;
  const entries = readAllEntries(cwd);
  return entries.filter(e => e.type === type).reverse().slice(0, limit);
}

/**
 * Formats context stack entries for injection into additionalContext.
 * Returns formatted markdown string or null.
 */
function formatInjection(cwd, currentPhase) {
  const entries = queryRecentPhases(cwd, currentPhase);
  if (entries.length === 0) return null;

  const header = '## Context Stack (accumulated from prior phases)\n\n';
  let result = header;

  for (const e of entries) {
    const line = `- [${e.phase}] ${e.type}: ${e.content}\n`;
    if (result.length + line.length > INJECTION_CAP_CHARS) break;
    result += line;
  }

  return result;
}

/**
 * Prunes old entries, keeping only the most recent keepPhases phases.
 * Rewrites the file. Returns { removed, remaining }.
 */
function prune(cwd, keepPhases) {
  if (keepPhases === undefined || !Number.isFinite(keepPhases)) keepPhases = 5;
  const entries = readAllEntries(cwd);
  if (entries.length === 0) return { removed: 0, remaining: 0 };

  // Get unique phases in order of appearance
  const phaseOrder = [];
  const seen = new Set();
  for (const e of entries) {
    if (e.phase && !seen.has(e.phase)) {
      seen.add(e.phase);
      phaseOrder.push(e.phase);
    }
  }

  const keepSet = new Set(keepPhases <= 0 ? [] : phaseOrder.slice(-keepPhases));
  const kept = entries.filter(e => keepSet.has(e.phase));
  const removed = entries.length - kept.length;

  const filePath = getStackPath(cwd);
  if (kept.length > 0) {
    fs.writeFileSync(filePath, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  } else {
    fs.writeFileSync(filePath, '', 'utf8');
  }

  return { removed, remaining: kept.length };
}

// --- CLI interface ---
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
      case 'append': {
        const phase = getArg('phase');
        const type = getArg('type');
        const content = getArg('content');
        if (!phase || !type || !content) {
          process.stderr.write('Missing --phase, --type, or --content\n');
          process.exit(0);
        }
        const tags = getArg('tags') ? getArg('tags').split(',').filter(Boolean) : [];
        const result = append(cwd, { phase, type, content, tags });
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'query': {
        const currentPhase = getArg('current-phase');
        if (!currentPhase) { process.stderr.write('Missing --current-phase\n'); process.exit(0); }
        const maxPhases = parseInt(getArg('max-phases') || '3', 10);
        const result = queryRecentPhases(cwd, currentPhase, maxPhases);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'format': {
        const currentPhase = getArg('current-phase');
        if (!currentPhase) { process.stderr.write('Missing --current-phase\n'); process.exit(0); }
        const result = formatInjection(cwd, currentPhase);
        process.stdout.write((result || 'null') + '\n');
        break;
      }
      case 'prune': {
        const keepPhases = parseInt(getArg('keep-phases') || '5', 10);
        const result = prune(cwd, keepPhases);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      default:
        process.stderr.write('Usage: context-stack.cjs <append|query|format|prune>\n');
        process.exit(0);
    }
  } catch (e) {
    process.stderr.write('[context-stack] Error: ' + e.message + '\n');
    process.exit(0); // Fail open
  }
}

module.exports = {
  append,
  queryRecentPhases,
  queryByType,
  formatInjection,
  getStackPath,
  prune,
  STACK_FILE,
  MAX_ENTRIES_PER_PHASE,
  INJECTION_CAP_CHARS,
};
