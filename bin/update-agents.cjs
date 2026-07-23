'use strict';

/**
 * update-agents.cjs — Detect, display, and update sub-coding agent CLIs.
 *
 * Exports:
 *   updateAgents()      — interactive update flow (display table + prompt)
 *   getUpdateStatuses() — parallel version detection, returns Map<name, {current, latest, status}>
 */

const path = require('path');
const { spawnSync } = require('child_process');
const inquirer = require('inquirer');
const { loadProviders } = require('./resolve-providers.cjs');

// ---------------------------------------------------------------------------
// CLI metadata map — keyed by binary basename
// ---------------------------------------------------------------------------

const CLI_META = {
  codex:    { installType: 'npm-global',   pkg: '@openai/codex' },
  gemini:   { installType: 'npm-global',   pkg: '@google/gemini-cli' },
  opencode: { installType: 'npm-global',   pkg: 'opencode' },
  copilot:  { installType: 'gh-extension', ext: 'github/gh-copilot' },
  ccr:      { installType: 'npm-global',   pkg: 'claude-code-router' },
  // Antigravity ships a self-installing binary `agy` (curl script), not an
  // npm/gh package — detectCurrent/detectLatest fall through to null for this
  // installType, so it shows as "unknown" rather than crashing the updater.
  antigravity: { installType: 'curl-script', bin: 'agy', installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  // Kimi Code self-updates via `kimi upgrade`; installType 'self-update' isn't
  // npm-global/gh-extension, so detectCurrent/detectLatest fall through to null
  // and it shows "unknown" rather than crashing the updater (same as antigravity).
  kimi:        { installType: 'self-update', bin: 'kimi', installCommand: 'kimi upgrade' },
};

// ---------------------------------------------------------------------------
// Build CLI list from providers.json
// ---------------------------------------------------------------------------

function buildCliList() {
  // Single source of truth (issue #197) — replaces require('./providers.json'),
  // which bound the repo's empty shipped source instead of the installed copy.
  const providers = loadProviders({ baseDir: __dirname }) || [];
  if (providers.length === 0) return [];

  // Deduplicate by binary basename
  const seen = new Set();
  const list = [];
  for (const p of providers) {
    if (!p.cli) continue;
    const binName = path.basename(p.cli);
    if (seen.has(binName)) continue;
    seen.add(binName);
    const meta = CLI_META[binName];
    if (!meta) continue; // skip unknown CLIs
    list.push({ name: binName, meta });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Semver comparison (no external package)
// ---------------------------------------------------------------------------

/**
 * Returns true if version a >= version b (strips leading 'v').
 */
function semverGte(a, b) {
  if (!a || !b) return false;
  const parse = (v) =>
    String(v)
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return true; // equal
}

// ---------------------------------------------------------------------------
// Derive status string
// ---------------------------------------------------------------------------

/**
 * Returns 'up-to-date' | 'update-available' | 'unknown'
 */
function deriveStatus(current, latest) {
  if (!current || !latest) return 'unknown';
  return semverGte(current, latest) ? 'up-to-date' : 'update-available';
}

// ---------------------------------------------------------------------------
// Detect current installed version
// ---------------------------------------------------------------------------

async function detectCurrent(meta) {
  try {
    if (meta.installType === 'npm-global') {
      const res = spawnSync('npm', ['list', '-g', meta.pkg, '--depth=0', '--json'], {
        encoding: 'utf8',
        timeout: 8000,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        const dep = parsed.dependencies && parsed.dependencies[meta.pkg];
        if (dep && dep.version) return dep.version;
      }
    } else if (meta.installType === 'gh-extension') {
      const res = spawnSync('gh', ['extension', 'list'], {
        encoding: 'utf8',
        timeout: 6000,
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.split('\n');
        for (const line of lines) {
          // Format: github/gh-copilot  v1.2.3  or similar tab-delimited
          if (line.includes('copilot')) {
            // Extract version token (starts with v or is a semver-like number)
            const match = line.match(/\b(v?\d+\.\d+[\.\d]*)\b/);
            if (match) return match[1].replace(/^v/, '');
          }
        }
      }
    }
  } catch (_) {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detect latest available version
// ---------------------------------------------------------------------------

async function detectLatest(meta) {
  try {
    if (meta.installType === 'npm-global') {
      const res = spawnSync('npm', ['view', meta.pkg, 'version'], {
        encoding: 'utf8',
        timeout: 8000,
      });
      if (res.status === 0 && res.stdout) {
        const v = res.stdout.trim();
        if (v) return v;
      }
    } else if (meta.installType === 'gh-extension') {
      const res = spawnSync(
        'gh',
        ['extension', 'upgrade', '--dry-run', 'copilot'],
        { encoding: 'utf8', stderr: 'pipe', timeout: 8000 }
      );
      const combined = (res.stdout || '') + (res.stderr || '');
      if (/already up.?to.?date/i.test(combined)) {
        // Return current version as latest (they're the same)
        return await detectCurrent(meta);
      }
      // Try to parse a version from the output
      const match = combined.match(/\b(v?\d+\.\d+[\.\d]*)\b/);
      if (match) return match[1].replace(/^v/, '');
      // Could not determine latest
      return null;
    }
  } catch (_) {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[90m';

function colorStatus(status) {
  if (status === 'update-available') return YELLOW + '\u2191 update available' + RESET;
  if (status === 'up-to-date')       return GREEN  + '\u2713 up to date'       + RESET;
  return DIM + '? unknown' + RESET;
}

// ---------------------------------------------------------------------------
// getUpdateStatuses() — parallel, exported
// ---------------------------------------------------------------------------

async function getUpdateStatuses() {
  try {
    const cliList = buildCliList();
    const results = await Promise.all(
      cliList.map(async ({ name, meta }) => {
        try {
          const current = await detectCurrent(meta);
          const latest  = await detectLatest(meta);
          const status  = deriveStatus(current, latest);
          return [name, { current, latest, status }];
        } catch (_) {
          return [name, { current: null, latest: null, status: 'unknown' }];
        }
      })
    );
    return new Map(results);
  } catch (_) {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Print version table
// ---------------------------------------------------------------------------

function printTable(rows) {
  const W = { cli: 10, installType: 13, current: 10, latest: 10 };

  const header =
    '  ' +
    'CLI'.padEnd(W.cli) +
    'Install'.padEnd(W.installType) +
    'Current'.padEnd(W.current) +
    'Latest'.padEnd(W.latest) +
    'Status';

  const sep =
    '  ' +
    '\u2500'.repeat(W.cli - 1) +
    ' ' +
    '\u2500'.repeat(W.installType - 1) +
    ' ' +
    '\u2500'.repeat(W.current - 1) +
    ' ' +
    '\u2500'.repeat(W.latest - 1) +
    ' ' +
    '\u2500'.repeat(18);

  console.log('\n' + header);
  console.log(sep);

  for (const row of rows) {
    const line =
      '  ' +
      row.name.padEnd(W.cli) +
      row.meta.installType.padEnd(W.installType) +
      (row.current || '—').padEnd(W.current) +
      (row.latest  || '—').padEnd(W.latest) +
      colorStatus(row.status);
    console.log(line);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Run update for one CLI
// ---------------------------------------------------------------------------

function runUpdate({ name, meta }) {
  try {
    let result;
    if (meta.installType === 'npm-global') {
      result = spawnSync('npm', ['install', '-g', `${meta.pkg}@latest`], {
        stdio: 'inherit',
        timeout: 60000,
      });
    } else if (meta.installType === 'gh-extension') {
      result = spawnSync('gh', ['extension', 'upgrade', 'copilot'], {
        stdio: 'inherit',
        timeout: 30000,
      });
    }
    if (result && result.status === 0) {
      console.log(`\n  Updated: ${name}`);
    } else {
      console.log(`\n  \x1b[31mError updating ${name} (exit ${result ? result.status : '?'})\x1b[0m`);
    }
  } catch (err) {
    console.log(`\n  \x1b[31mError updating ${name}: ${err.message}\x1b[0m`);
  }
}

// ---------------------------------------------------------------------------
// updateAgents() — interactive, exported
// ---------------------------------------------------------------------------

async function updateAgents() {
  const cliList = buildCliList();

  if (cliList.length === 0) {
    console.log('\n  No known agent CLIs found in providers.json.\n');
    return;
  }

  // Detect versions sequentially for display (consistent with user-visible flow)
  const rows = [];
  for (const { name, meta } of cliList) {
    let current = null;
    let latest  = null;
    let status  = 'unknown';
    try {
      current = await detectCurrent(meta);
      latest  = await detectLatest(meta);
      status  = deriveStatus(current, latest);
    } catch (_) {
      // keep defaults
    }
    rows.push({ name, meta, current, latest, status });
  }

  printTable(rows);

  const outdated = rows.filter((r) => r.status === 'update-available');

  if (outdated.length === 0) {
    console.log('  All agents are up to date.\n');
    return;
  }

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'Update options:',
      choices: [
        { name: 'Update all outdated', value: 'all' },
        { name: 'Select individual agents', value: 'select' },
        { name: 'Skip', value: 'skip' },
      ],
    },
  ]);

  if (action === 'skip') {
    console.log('\n  Skipped.\n');
    return;
  }

  let toUpdate = outdated;

  if (action === 'select') {
    const { chosen } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'chosen',
        message: 'Select agents to update:',
        choices: outdated.map((r) => ({
          name: `${r.name}  (${r.current || '?'} -> ${r.latest || '?'})`,
          value: r.name,
        })),
      },
    ]);
    toUpdate = outdated.filter((r) => chosen.includes(r.name));
  }

  if (toUpdate.length === 0) {
    console.log('\n  Nothing selected.\n');
    return;
  }

  for (const row of toUpdate) {
    runUpdate(row);
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { updateAgents, getUpdateStatuses };
