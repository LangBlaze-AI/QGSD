#!/usr/bin/env node
'use strict';

/**
 * audit-agent-payloads.cjs
 *
 * Scans skill .md files for `node bin/*.cjs --json` invocations and
 * measures their output size against the 128KB GUARD-01 threshold.
 *
 * Usage:
 *   node bin/audit-agent-payloads.cjs              # human-readable table
 *   node bin/audit-agent-payloads.cjs --json       # JSON output
 *   node bin/audit-agent-payloads.cjs --threshold-kb 256  # override threshold
 *
 * Exit code: Always 0 (warnings are advisory, not blocking)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const TAG = '[audit-agent-payloads]';
let ROOT = process.cwd();

// Parse --project-root
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--project-root=')) {
    ROOT = path.resolve(arg.slice('--project-root='.length));
  }
}

// Parse flags
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getArg = (f) => {
  const idx = args.indexOf(f);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};

const JSON_OUT = hasFlag('--json');
const THRESHOLD_KB = parseInt(getArg('--threshold-kb') ?? '128', 10);
const TIMEOUT_MS = 15000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

// Scripts whose `--json` is NOT a fixed-size agent-context payload, so the
// GUARD-01 size check doesn't apply. Reported as `skipped` with the reason
// rather than run to a misleading error/oversize-warning.
//   F4a — nf-solve.cjs is a full orchestrator: its `--json` output is captured
//         (solve.md) but run-dependent and slow, so the 15s probe always timed
//         out and reported `error`.
//   F4c — trace-corpus-stats.cjs is consumed for the evidence FILE it writes, not
//         its stdout. Its one caller (solve-remediate.md) redirects stdout to
//         /dev/null, so the ~256KB never reaches agent context. (Before that skill
//         was fixed it only redirected stderr — the 256KB stdout DID leak.)
const KNOWN_NON_PAYLOAD = {
  'nf-solve.cjs': 'orchestrator — `--json` output is run-dependent (drive via /nf:solve), not a fixed-size payload',
  'trace-corpus-stats.cjs': 'fire-and-forget — its only caller (solve-remediate) redirects stdout to /dev/null and uses the evidence file it writes, so its --json never reaches agent context',
};

// Helper functions
function log(msg) {
  if (!JSON_OUT) {
    process.stdout.write(msg + '\n');
  }
}

function padRight(str, width) {
  return str + ' '.repeat(Math.max(0, width - str.length));
}

function padLeft(str, width) {
  return ' '.repeat(Math.max(0, width - str.length)) + str;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Scan .md files for script invocations
function scanSkillFiles() {
  const scripts = new Set();
  const scriptSources = {};

  const searchDirs = [
    path.join(ROOT, 'commands', 'nf'),
    path.join(ROOT, 'core', 'workflows'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');

        // Pattern: node bin/*.cjs or node ~/.claude/nf-bin/*.cjs with --json
        const pattern = /node\s+(?:~\/\.claude\/nf-bin\/|(?:\$[A-Z_]+\/)?bin\/)([a-z0-9_-]+\.cjs).*--json/g;
        let match;

        while ((match = pattern.exec(content)) !== null) {
          const scriptName = match[1];
          scripts.add(scriptName);

          if (!scriptSources[scriptName]) {
            scriptSources[scriptName] = [];
          }
          if (!scriptSources[scriptName].includes(file)) {
            scriptSources[scriptName].push(file);
          }
        }
      } catch (err) {
        // Skip files we can't read
      }
    }
  }

  return { scripts: Array.from(scripts).sort(), scriptSources };
}

// Try to run a script with --json
function auditScript(scriptName) {
  const scriptPath = path.join(ROOT, 'bin', scriptName);

  if (!fs.existsSync(scriptPath)) {
    return {
      name: scriptName,
      size_bytes: 0,
      status: 'missing',
      reason: 'Script not found on disk',
    };
  }

  // Scripts whose --json isn't a fixed-size agent payload are not subject to the
  // GUARD-01 size check — report them accurately instead of running them.
  if (Object.prototype.hasOwnProperty.call(KNOWN_NON_PAYLOAD, scriptName)) {
    return {
      name: scriptName,
      size_bytes: 0,
      status: 'skipped',
      reason: KNOWN_NON_PAYLOAD[scriptName],
    };
  }

  // Try to run with just --json first
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const args = ['--json'];

      // On second attempt, add --project-root
      if (attempt === 1) {
        args.push('--project-root=' + ROOT);
      }

      const output = execFileSync('node', [scriptPath, ...args], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'], // Capture stdout only
      });

      const sizeBytes = Buffer.byteLength(output, 'utf8');
      const status = sizeBytes >= THRESHOLD_KB * 1024 ? 'warning' : 'ok';

      return {
        name: scriptName,
        size_bytes: sizeBytes,
        size_human: formatBytes(sizeBytes),
        status,
      };
    } catch (err) {
      const isTimeout = err.code === 'ETIMEDOUT';
      const isNonZero = err.status !== undefined && err.status !== 0;

      if (attempt === 0 && isNonZero && !isTimeout) {
        // Try second attempt with --project-root
        continue;
      }

      // Both attempts failed
      if (isTimeout) {
        return {
          name: scriptName,
          size_bytes: 0,
          status: 'error',
          reason: `Timeout after ${TIMEOUT_MS}ms`,
        };
      } else if (isNonZero) {
        return {
          name: scriptName,
          size_bytes: 0,
          status: 'skipped',
          reason: 'Exited with non-zero code (may require arguments)',
        };
      } else {
        return {
          name: scriptName,
          size_bytes: 0,
          status: 'error',
          reason: (err.message || String(err)).split('\n')[0].slice(0, 80),
        };
      }
    }
  }
}

// Main execution
function main() {
  try {
    const { scripts, scriptSources } = scanSkillFiles();

    if (scripts.length === 0) {
      log('No scripts found in skill .md files');
      process.exit(0);
    }

    // Audit all scripts
    const results = scripts.map(scriptName => {
      const result = auditScript(scriptName);
      result.source_files = scriptSources[scriptName] || [];
      return result;
    });

    // Calculate summary
    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      warning: results.filter(r => r.status === 'warning').length,
      error: results.filter(r => r.status === 'error').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      missing: results.filter(r => r.status === 'missing').length,
    };

    if (JSON_OUT) {
      // JSON output
      console.log(JSON.stringify({
        threshold_kb: THRESHOLD_KB,
        scripts: results,
        summary,
      }, null, 2));
    } else {
      // Human-readable table
      const colors = {
        ok: (s) => `\x1b[32m${s}\x1b[0m`,      // green
        warning: (s) => `\x1b[33m${s}\x1b[0m`, // yellow
        error: (s) => `\x1b[31m${s}\x1b[0m`,   // red
        skipped: (s) => `\x1b[2m${s}\x1b[0m`,  // dim
        missing: (s) => `\x1b[31m${s}\x1b[0m`, // red
      };

      log('');
      log('AGENT PAYLOAD SIZE AUDIT');
      log('Threshold: ' + THRESHOLD_KB + ' KB');
      log('');

      // Print table header
      log(
        padRight('Script', 30) +
        padLeft('Size', 12) +
        padLeft('Status', 12)
      );
      log('-'.repeat(54));

      // Print rows
      for (const r of results) {
        const statusStr = r.status.toUpperCase();
        const colorFn = colors[r.status] || ((s) => s);
        const sizeStr = r.size_human || '-';

        log(
          padRight(r.name, 30) +
          padLeft(sizeStr, 12) +
          padLeft(colorFn(statusStr), 12)
        );
      }

      log('');
      log('Summary: ' + summary.total + ' scripts audited, ' +
          summary.warning + ' warnings, ' +
          summary.error + ' errors');
      log('');
    }
  } catch (err) {
    if (!JSON_OUT) {
      console.error(TAG + ' Fatal error:', err.message);
    }
    process.exit(0); // Always exit 0 per GUARD-01
  }
}

if (require.main === module) {
  main();
}

module.exports = { auditScript, KNOWN_NON_PAYLOAD };
