#!/usr/bin/env node
'use strict';

/**
 * bin/security-sweep.cjs — Standalone security scanner for nForma.
 *
 * Scans git-tracked files for hardcoded secrets, debug artifacts, and API keys.
 * Produces structured findings with file:line references for VERIFICATION.md.
 *
 * Advisory only — exit code 0 always. Never blocks.
 *
 * Exports: SECRET_PATTERNS, scanFile, scanDirectory, formatReport
 * CLI: node bin/security-sweep.cjs [--json] [--cwd /path]
 */

const fs = require('fs');
const path = require('path');
// spawnSync is used (not exec) to avoid shell injection — arguments are passed as an array
const { spawnSync } = require('child_process');

// ─── Secret Patterns ────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', pattern: /AKIA[A-Z0-9]{16}/, severity: 'high' },
  { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/, severity: 'high' },
  { name: 'GitHub PAT', pattern: /github_pat_[A-Za-z0-9_]{22,}/, severity: 'high' },
  { name: 'Stripe Live Key', pattern: /[sr]k_live_[A-Za-z0-9]{20,}/, severity: 'high' },
  { name: 'OpenAI Key', pattern: /sk-[A-Za-z0-9]{32,}/, severity: 'high' },
  { name: 'Generic API Key Assignment', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}['"]/i, severity: 'medium' },
  { name: 'Generic Secret Assignment', pattern: /(?:secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, severity: 'medium' },
  { name: 'Debugger Statement', pattern: /^\s*debugger\s*;?\s*$/, severity: 'low' },
  { name: 'Sensitive Console.log', pattern: /console\.log\(.*(?:password|secret|token|key|api_key)/i, severity: 'low' },
];

// Words that indicate a line is a test fixture / not a real secret
const TEST_INDICATOR_WORDS = ['test', 'mock', 'fake', 'example', 'dummy', 'fixture', 'placeholder', 'todo'];

// File patterns to exclude from scanning
const EXCLUDE_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /security-sweep\.cjs$/,
  /\.md$/,
  /\.json$/,
  /\.jsonl$/,
  /node_modules\//,
  /\.planning\/\.quorum-cache\//,
  /package-lock\.json$/,
];

// ─── scanFile ────────────────────────────────────────────────────────────────

/**
 * Scan file content line-by-line against SECRET_PATTERNS.
 * @param {string} filePath - Relative or absolute file path (for reporting).
 * @param {string} content  - File content to scan.
 * @returns {Array<{file:string, line:number, column:number, pattern_name:string, severity:string, match:string}>}
 */
function scanFile(filePath, content) {
  if (!content || typeof content !== 'string') return [];

  // Skip binary content (null bytes in first 512 chars)
  if (content.slice(0, 512).includes('\0')) return [];

  const findings = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    // Skip lines containing test indicator words
    if (TEST_INDICATOR_WORDS.some(w => lineLower.includes(w))) continue;

    for (const pat of SECRET_PATTERNS) {
      const m = pat.pattern.exec(line);
      if (m) {
        findings.push({
          file: filePath,
          line: i + 1,
          column: m.index + 1,
          pattern_name: pat.name,
          severity: pat.severity,
          match: m[0].length > 40 ? m[0].slice(0, 37) + '...' : m[0],
        });
      }
    }
  }

  return findings;
}

// ─── scanDirectory ───────────────────────────────────────────────────────────

/**
 * Scan git-tracked files in a directory.
 * @param {string} cwd - Working directory to scan.
 * @param {Object} [options]
 * @param {string[]} [options.excludePatterns] - Additional glob patterns to exclude.
 * @param {number}   [options.maxFiles=500]    - Max files to scan.
 * @returns {{findings: Array, files_scanned: number, duration_ms: number}}
 */
function scanDirectory(cwd, options = {}) {
  options = options || {};
  const maxFiles = options.maxFiles || 500;
  const startTime = Date.now();

  // Get tracked files via git ls-files (spawnSync, not exec — no shell injection)
  let files = [];
  try {
    const result = spawnSync('git', ['ls-files'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      files = result.stdout.split('\n').filter(f => f.trim());
    }
  } catch (_) {
    return { findings: [], files_scanned: 0, duration_ms: Date.now() - startTime };
  }

  // Filter out excluded patterns
  files = files.filter(f => !EXCLUDE_PATTERNS.some(rx => rx.test(f)));

  // Apply additional exclude patterns from options
  if (options.excludePatterns && Array.isArray(options.excludePatterns)) {
    for (const pat of options.excludePatterns) {
      try {
        const rx = new RegExp(pat);
        files = files.filter(f => !rx.test(f));
      } catch (_) {}
    }
  }

  // Cap file count
  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles);
  }

  const allFindings = [];
  let scanned = 0;

  for (const relPath of files) {
    try {
      const absPath = path.join(cwd, relPath);
      const content = fs.readFileSync(absPath, 'utf8');
      // Skip binary files (null bytes in first 512 bytes)
      if (content.slice(0, 512).includes('\0')) continue;
      scanned++;
      const findings = scanFile(relPath, content);
      allFindings.push(...findings);
    } catch (_) {
      // Skip unreadable files silently
    }
  }

  return {
    findings: allFindings,
    files_scanned: scanned,
    duration_ms: Date.now() - startTime,
  };
}

// ─── formatReport ────────────────────────────────────────────────────────────

/**
 * Format scan results as a markdown section for VERIFICATION.md.
 * @param {{findings: Array, files_scanned: number, duration_ms: number}} scanResult
 * @returns {string}
 */
function formatReport(scanResult) {
  const { findings, files_scanned, duration_ms } = scanResult || {};
  const lines = [];

  lines.push('## Security Sweep');
  lines.push('');
  lines.push(`**Scanned:** ${files_scanned} files in ${duration_ms}ms`);

  if (!findings || findings.length === 0) {
    lines.push('**Findings:** 0');
    lines.push('');
    lines.push('No hardcoded secrets, debug artifacts, or API keys detected.');
    return lines.join('\n');
  }

  const high = findings.filter(f => f.severity === 'high').length;
  const medium = findings.filter(f => f.severity === 'medium').length;
  const low = findings.filter(f => f.severity === 'low').length;

  lines.push(`**Findings:** ${findings.length} (${high} high, ${medium} medium, ${low} low)`);
  lines.push('');
  lines.push('| Severity | File | Line | Pattern | Match |');
  lines.push('|----------|------|------|---------|-------|');

  for (const f of findings) {
    lines.push(`| ${f.severity} | ${f.file} | ${f.line} | ${f.pattern_name} | ${f.match} |`);
  }

  lines.push('');
  lines.push('_Advisory: Review findings and confirm whether they are genuine secrets or false positives._');

  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx >= 0 && args[cwdIdx + 1] ? args[cwdIdx + 1] : process.cwd();

  const result = scanDirectory(cwd);

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(result) + '\n');
  }

  // Log conformance event (best-effort)
  try {
    const planningPaths = require('./planning-paths.cjs');
    const conformancePath = planningPaths.resolveWithFallback(cwd, 'conformance-events');
    const event = {
      ts: new Date().toISOString(),
      action: 'security_sweep',
      files_scanned: result.files_scanned,
      findings_count: result.findings.length,
      duration_ms: result.duration_ms,
    };
    fs.appendFileSync(conformancePath, JSON.stringify(event) + '\n');
  } catch (_) {}

  process.exit(0);
}

module.exports = { SECRET_PATTERNS, scanFile, scanDirectory, formatReport };
