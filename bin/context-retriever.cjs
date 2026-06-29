#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_BUDGET_CHARS = 32000;
const MAX_ROUNDS = 2;

const DOMAIN_CONFIG = {
  test: {
    files: ['.planning/formal/unit-test-coverage.json'],
    searchPatterns: [/\.(test|spec)\.(cjs|js|ts)$/],
    searchDirs: ['bin/', 'hooks/dist/'],
    maxFilesToScan: 20,
  },
  architecture: {
    files: [
      '.planning/STATE.md',
      '.planning/memory/decisions.jsonl',
    ],
    searchDirs: ['.planning/'],
    maxFilesToScan: 10,
  },
  formal: {
    files: [
      '.planning/formal/traceability-matrix.json',
      '.planning/formal/solve-state.json',
    ],
    searchPatterns: [/\.(tla|als|pm)$/],
    searchDirs: ['.planning/formal/tla/', '.planning/formal/alloy/', '.planning/formal/prism/'],
    maxFilesToScan: 15,
  },
  repowise: {
    files: [
      '.planning/repowise/hotspot-cache.json',
      '.planning/repowise/cochange-cache.json',
    ],
    searchDirs: ['.planning/repowise/'],
    maxFilesToScan: 5,
  },
};

const QUESTION_KEYWORDS = {
  test: ['test', 'coverage', 'verify', 'spec', 'assertion'],
  architecture: ['architecture', 'design', 'pattern', 'decision', 'convention'],
  formal: ['formal', 'invariant', 'spec', 'tla', 'alloy', 'prism', 'model'],
  repowise: ['hotspot', 'churn', 'cochange', 'skeleton', 'repowise', 'risk'],
};

const PATH_SEGMENTS = {
  test: ['test'],
  formal: ['formal', 'tla', 'alloy'],
  architecture: ['planning', 'state'],
  repowise: ['repowise'],
};

/**
 * Analyzes a question and artifact path to identify which domains need context retrieval.
 * Returns array of { domain, query } objects.
 */
function analyzeContextNeeds(question, artifactPath, existingContext) {
  const domainSet = new Set();
  const results = [];

  function addDomain(domain) {
    if (!domainSet.has(domain)) {
      domainSet.add(domain);
      results.push({ domain, query: question || '' });
    }
  }

  // Analyze question keywords
  if (typeof question === 'string' && question) {
    const q = question.toLowerCase();
    for (const [domain, keywords] of Object.entries(QUESTION_KEYWORDS)) {
      for (const kw of keywords) {
        if (q.includes(kw)) {
          addDomain(domain);
          break;
        }
      }
    }
  }

  // Analyze artifact path segments
  if (typeof artifactPath === 'string' && artifactPath) {
    const p = artifactPath.toLowerCase();
    for (const [domain, segments] of Object.entries(PATH_SEGMENTS)) {
      for (const seg of segments) {
        if (p.includes(seg)) {
          addDomain(domain);
          break;
        }
      }
    }
  }

  // Filter out domains already present in existingContext (for second round)
  if (typeof existingContext === 'string' && existingContext) {
    const ctx = existingContext.toLowerCase();
    return results.filter(r => {
      const marker = `--- ${r.domain} ---`;
      return !ctx.includes(marker);
    });
  }

  return results;
}

/**
 * Fetches context for the given needs within a character budget.
 * Returns concatenated string with domain section markers.
 */
function fetchContext(cwd, needs, charBudget) {
  if (!Array.isArray(needs) || needs.length === 0) return '';
  if (!charBudget || charBudget <= 0) charBudget = TOKEN_BUDGET_CHARS;

  let result = '';
  let remaining = charBudget;

  for (const need of needs) {
    if (!need || typeof need !== 'object') continue; // skip malformed needs (fail-open)
    const config = DOMAIN_CONFIG[need.domain];
    if (!config) continue; // skip unknown domains (fail-open)

    // Fast path: known files
    if (config.files) {
      for (const relPath of config.files) {
        if (remaining <= 0) break;
        try {
          const fullPath = path.join(cwd, relPath);
          const content = fs.readFileSync(fullPath, 'utf8');
          const header = `\n--- ${relPath} ---\n`;
          const available = remaining - header.length;
          if (available <= 0) break;
          const truncated = content.length > available ? content.slice(0, available) : content;
          result += header + truncated;
          remaining = charBudget - result.length;
        } catch {
          // fail-open: skip unreadable files
        }
      }
    }

    // Search path: scan directories for matching files
    if (remaining > 0 && config.searchDirs && config.searchPatterns) {
      let filesScanned = 0;
      for (const dir of config.searchDirs) {
        if (remaining <= 0 || filesScanned >= (config.maxFilesToScan || 20)) break;
        try {
          const fullDir = path.join(cwd, dir);
          const entries = fs.readdirSync(fullDir);
          for (const entry of entries) {
            if (remaining <= 0 || filesScanned >= (config.maxFilesToScan || 20)) break;
            const matches = config.searchPatterns.some(p => p.test(entry));
            if (!matches) continue;
            try {
              const filePath = path.join(fullDir, entry);
              const stat = fs.statSync(filePath);
              if (!stat.isFile()) continue;
              const content = fs.readFileSync(filePath, 'utf8');
              const relPath = path.join(dir, entry);
              const header = `\n--- ${relPath} ---\n`;
              const available = remaining - header.length;
              if (available <= 0) break;
              const truncated = content.length > available ? content.slice(0, available) : content;
              result += header + truncated;
              remaining = charBudget - result.length;
              filesScanned++;
            } catch {
              // fail-open: skip unreadable files
            }
          }
        } catch {
          // fail-open: skip unreadable directories
        }
      }
    }
  }

  return result;
}

// --- CLI interface ---
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const command = args[0];

    function getArg(name) {
      const idx = args.indexOf('--' + name);
      if (idx === -1 || idx + 1 >= args.length) return null;
      return args[idx + 1];
    }

    switch (command) {
      case 'analyze': {
        const question = getArg('question');
        if (!question) { process.stderr.write('Missing --question\n'); process.exit(0); }
        const artifact = getArg('artifact') || null;
        const needs = analyzeContextNeeds(question, artifact, '');
        process.stdout.write(JSON.stringify(needs) + '\n');
        break;
      }
      case 'fetch': {
        const cwd = getArg('cwd') || process.cwd();
        const domain = getArg('domain');
        if (!domain) { process.stderr.write('Missing --domain\n'); process.exit(0); }
        const budget = parseInt(getArg('budget') || String(TOKEN_BUDGET_CHARS), 10);
        const result = fetchContext(cwd, [{ domain, query: '' }], budget);
        process.stdout.write(result + '\n');
        break;
      }
      default:
        process.stderr.write('Usage: context-retriever.cjs <analyze|fetch>\n');
        process.exit(0);
    }
  } catch (e) {
    process.stderr.write('[context-retriever] Error: ' + e.message + '\n');
    process.exit(0); // Fail open
  }
}

module.exports = {
  analyzeContextNeeds,
  fetchContext,
  DOMAIN_CONFIG,
  TOKEN_BUDGET_CHARS,
  MAX_ROUNDS,
};
