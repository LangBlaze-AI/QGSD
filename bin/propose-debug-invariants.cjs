#!/usr/bin/env node
'use strict';
// bin/propose-debug-invariants.cjs
// LOOP-04 (v0.21-03): Mine debug session artifacts for TLA+ PROPERTY candidates.
// Usage:
//   node bin/propose-debug-invariants.cjs                  # Interactive: accept/reject each
//   node bin/propose-debug-invariants.cjs --non-interactive # CI: print all, exit 0

const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const NON_INTERACTIVE = process.argv.includes('--non-interactive');
const DEBUG_ARTIFACT_PATH = path.join(process.cwd(), '.planning', 'quick', 'quorum-debug-latest.md');
const ACCEPT_SCRIPT = path.join(__dirname, 'accept-debug-invariant.cjs');
const DEFAULT_SPEC  = path.join(process.cwd(), '.planning', 'formal', 'tla', 'NFQuorum.tla');

function sanitizeTlaName(str) {
  return str.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40).replace(/^_+|_+$/g, '') || 'Unknown';
}

function mineTransitions(lines) {
  const candidates = [];
  const seen = new Set();
  const re = /(\w+)\s*[-\u2192]>\s*(\w+)/g;
  for (let i = 0; i < lines.length; i++) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      const from = m[1], to = m[2];
      re.lastIndex -= to.length; // allow the shared token to start the next transition (chained A -> B -> C)
      const key = from + '_' + to;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = 'TransitionHint_' + from + '_to_' + to;
      const body = '[][phase = "' + from + '" => phase\' \\in {"' + from + '", "' + to + '"}]_vars';
      candidates.push({
        name, body,
        source: 'line ' + (i + 1) + ' "' + lines[i].trim().slice(0, 60) + '"',
        formatted: 'PROPERTY ' + name + ' == ' + body,
      });
    }
  }
  return candidates;
}

function mineRootCauses(lines) {
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/root_cause:\s*(.+)/i);
    if (!m) continue;
    const text = m[1].trim();
    const sanitized = sanitizeTlaName(text);
    const name = 'RootCauseHint_' + sanitized;
    const body = 'TRUE  \\* Review: ' + text.slice(0, 80);
    candidates.push({
      name, body,
      source: 'line ' + (i + 1) + ' "' + lines[i].trim().slice(0, 60) + '"',
      formatted: 'INVARIANT ' + name + ' == ' + body,
    });
  }
  return candidates;
}

function mineInvariantCandidates(lines) {
  const candidates = [];
  let n = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/[Ii]nvariant(?:\s+candidate)?:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    const name = 'InvariantCandidate_' + n++;
    const body = 'TRUE  \\* TODO: Formalize: ' + text.slice(0, 80);
    candidates.push({
      name, body,
      source: 'line ' + (i + 1) + ' "' + lines[i].trim().slice(0, 60) + '"',
      formatted: 'PROPERTY ' + name + ' == ' + body,
    });
  }
  return candidates;
}

if (!fs.existsSync(DEBUG_ARTIFACT_PATH)) {
  process.stdout.write('No debug artifact found at ' + path.relative(process.cwd(), DEBUG_ARTIFACT_PATH) + ' — run a debug session first.\n');
  process.exit(0);
}

let artifactText;
try {
  artifactText = fs.readFileSync(DEBUG_ARTIFACT_PATH, 'utf8');
} catch (e) {
  process.stdout.write('Warning: failed to read debug artifact: ' + e.message + '\n');
  process.exit(0);
}

const lines = artifactText.split('\n');

const candidates = [
  ...mineTransitions(lines),
  ...mineRootCauses(lines),
  ...mineInvariantCandidates(lines),
];

if (candidates.length === 0) {
  process.stdout.write('No invariant candidates detected in the debug artifact.\n');
  process.exit(0);
}

if (NON_INTERACTIVE) {
  process.stdout.write('=== propose-debug-invariants: ' + candidates.length + ' candidate(s) from quorum-debug-latest.md ===\n\n');
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write('[' + (i + 1) + '] ' + c.formatted + '\n');
    process.stdout.write('    Source: ' + c.source + '\n\n');
  }
  process.stdout.write('Run without --non-interactive to accept/reject each individually.\n');
  process.exit(0);
}

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let accepted = 0, rejected = 0, skipped = 0;
let idx = 0;

function askNext() {
  if (idx >= candidates.length) {
    rl.close();
    process.stdout.write('\nSummary: ' + accepted + ' accepted, ' + rejected + ' rejected, ' + skipped + ' skipped.\n');
    process.exit(0);
    return;
  }

  const c = candidates[idx];
  process.stdout.write('\n[' + (idx + 1) + '/' + candidates.length + '] ' + c.formatted + '\n');
  process.stdout.write('    Source: ' + c.source + '\n');
  rl.question('Accept [a], Reject [r], or Skip [s]? ', (answer) => {
    const choice = answer.trim().toLowerCase();
    if (choice === 'a') {
      const sessionId = 'debug-sess-' + Math.floor(Date.now() / 1000) + '-' + Math.random().toString(16).slice(2, 10);
      const acceptResult = spawnSync(process.execPath, [
        ACCEPT_SCRIPT, DEFAULT_SPEC,
        '--property-name', c.name,
        '--property-body', c.body,
        '--session-id', sessionId,
      ], { encoding: 'utf8', timeout: 15000 });

      if (acceptResult.status === 0 && !acceptResult.error) {
        process.stdout.write('Accepted: ' + c.name + ' -> written to spec.\n');
        accepted++;
      } else {
        process.stdout.write('Warning: failed to write invariant: ' + (acceptResult.stderr || String(acceptResult.error || '')) + '\n');
      }
    } else if (choice === 'r') {
      process.stdout.write('Rejected.\n');
      rejected++;
    } else {
      process.stdout.write('Skipped.\n');
      skipped++;
    }
    idx++;
    askNext();
  });
}

askNext();
