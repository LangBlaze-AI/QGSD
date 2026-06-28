#!/usr/bin/env node
'use strict';

const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const crypto     = require('crypto');
const { spawnSync, fork } = require('child_process');
const solveTui = require('./solve-tui.cjs');
const nfSolve  = require('./nf-solve.cjs');
const NF_VERSION = require('../package.json').version;
const { resolveCli } = require('./resolve-cli.cjs');

// ─── Global error handlers — prevent silent TUI crashes ─────────────────────
process.on('uncaughtException', (err) => {
  try { if (typeof screen !== 'undefined') screen.destroy(); } catch (_) {}
  process.stderr.write(`\n[nForma] Uncaught exception: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { if (typeof screen !== 'undefined') screen.destroy(); } catch (_) {}
  process.stderr.write(`\n[nForma] Unhandled rejection: ${reason}\n`);
  process.exit(1);
});

// ─── Non-blocking solve worker ──────────────────────────────────────────────
// Forks sweep functions into a child process so the blessed event loop stays
// responsive. Each call spawns a short-lived worker; results arrive via IPC.

const SOLVE_WORKER_PATH = path.join(__dirname, 'solve-worker.cjs');

/**
 * Run a single nf-solve sweep function in a forked child process.
 * @param {string} fnName - Name of the sweep function (e.g. 'sweepDtoC')
 * @returns {Promise<{residual, detail}>}
 */
function sweepAsync(fnName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const child = fork(SOLVE_WORKER_PATH, ['--project-root=' + getTargetPath()], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error(`Sweep "${fnName}" timed out after 5 minutes`));
    }, 300000);

    child.on('message', (msg) => {
      if (msg.cmd === 'ready') {
        child.send({ cmd: 'sweep', fnName, id: 1 });
      } else if (msg.id === 1) {
        clearTimeout(timeout);
        child.disconnect();
        if (msg.ok) settle(resolve, msg.result);
        else settle(reject, new Error(msg.error));
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); settle(reject, err); });
    child.on('exit', () => { clearTimeout(timeout); });
  });
}

/**
 * Run solveTui.loadSweepData() in a forked child process.
 * @returns {Promise<Object>}
 */
function loadSweepDataAsync() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const child = fork(SOLVE_WORKER_PATH, ['--project-root=' + getTargetPath()], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error('loadSweepData timed out after 5 minutes'));
    }, 300000);

    child.on('message', (msg) => {
      if (msg.cmd === 'ready') {
        child.send({ cmd: 'loadSweepData', id: 1 });
      } else if (msg.id === 1) {
        clearTimeout(timeout);
        child.disconnect();
        if (msg.ok) settle(resolve, msg.result);
        else settle(reject, new Error(msg.error));
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); settle(reject, err); });
    child.on('exit', () => { clearTimeout(timeout); });
  });
}

/**
 * Run classifyWithHaiku in a forked child process.
 * @param {Object} sweepData
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
function classifyAsync(sweepData, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const child = fork(SOLVE_WORKER_PATH, ['--project-root=' + getTargetPath()], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error('Classification timed out after 10 minutes'));
    }, 600000);

    child.on('message', (msg) => {
      if (msg.cmd === 'ready') {
        child.send({ cmd: 'classify', sweepData, opts, id: 1 });
      } else if (msg.id === 1) {
        clearTimeout(timeout);
        child.disconnect();
        if (msg.ok) settle(resolve, msg.result);
        else settle(reject, new Error(msg.error));
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); settle(reject, err); });
    child.on('exit', () => { clearTimeout(timeout); });
  });
}

/**
 * Run multiple sweep functions in a forked child, streaming results as they arrive.
 * @param {string[]} fnNames - Array of sweep function names
 * @param {Function} onResult - callback(fnName, result|null, error|null) per sweep
 * @returns {Promise<void>} Resolves when all sweeps complete
 */
function batchSweepAsync(fnNames, onResult) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const child = fork(SOLVE_WORKER_PATH, ['--project-root=' + getTargetPath()], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error('Batch sweep timed out after 10 minutes'));
    }, 600000);

    child.on('message', (msg) => {
      if (msg.cmd === 'ready') {
        child.send({ cmd: 'batchSweep', fnNames, id: 1 });
      } else if (msg.cmd === 'sweepResult') {
        if (msg.ok) onResult(msg.fnName, msg.result, null);
        else onResult(msg.fnName, null, msg.error);
      } else if (msg.cmd === 'batchDone') {
        clearTimeout(timeout);
        child.disconnect();
        settle(resolve);
      }
    });
    child.on('error', (err) => { clearTimeout(timeout); settle(reject, err); });
    child.on('exit', () => { clearTimeout(timeout); });
  });
}

// ─── Circuit breaker CLI (non-interactive, exits before TUI loads) ───────────
const cliArgs = process.argv.slice(2);

function getBreakerProjectRoot() {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
  });
  return (git.status === 0 && !git.error) ? git.stdout.trim() : process.cwd();
}

function getBreakerStateFile() {
  return path.join(getBreakerProjectRoot(), '.claude', 'circuit-breaker-state.json');
}

if (cliArgs.includes('--disable-breaker')) {
  const stateFile = getBreakerStateFile();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const existing = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : {};
  fs.writeFileSync(stateFile, JSON.stringify({ ...existing, disabled: true, active: false }, null, 2), 'utf8');
  console.log('  \u2298 Circuit breaker disabled. Detection and enforcement paused.');
  process.exit(0);
}

if (cliArgs.includes('--enable-breaker')) {
  const stateFile = getBreakerStateFile();
  if (fs.existsSync(stateFile)) {
    const existing = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...existing, disabled: false, active: false }, null, 2), 'utf8');
  }
  console.log('  \u2713 Circuit breaker enabled. Oscillation detection resumed.');
  process.exit(0);
}

if (cliArgs.includes('--reset-breaker')) {
  const stateFile = getBreakerStateFile();
  if (fs.existsSync(stateFile)) {
    fs.rmSync(stateFile);
    console.log('  \u2713 Circuit breaker state cleared. Claude can resume Bash execution.');
  } else {
    console.log('  No active circuit breaker state found.');
  }
  process.exit(0);
}

// ─── Target path (project root for TUI operations) ──────────────────────────
// Settable via --target <path> CLI arg, startup modal, or [C-t] shortcut.
// All project-data reads (config, requirements, scoreboard) use this instead
// of process.cwd(). Existing sessions keep their own cwd.
let targetPath = null; // set after TUI loads (or from CLI arg)
const _targetIdx = cliArgs.indexOf('--target');
if (_targetIdx !== -1 && cliArgs[_targetIdx + 1]) {
  const candidate = path.resolve(cliArgs[_targetIdx + 1]);
  if (fs.existsSync(candidate)) {
    targetPath = candidate;
  } else {
    process.stderr.write(`--target path does not exist: ${candidate}\n`);
    process.exit(1);
  }
}

/** Returns the current target path, falling back to process.cwd(). */
function getTargetPath() {
  return targetPath || process.cwd();
}

// ─── Screenshot CLI (non-interactive, exits before TUI loads) ────────────────
// Derives module data from the canonical MODULES array (defined below at line ~240)
// to guarantee screenshots always match the live TUI.
if (cliArgs.includes('--screenshot')) {
  // Lazy-load the MODULES array — defined later in file but we need it here.
  // We use a forward reference: the MODULES const is hoisted but not yet initialized
  // in this code path, so we read it from a function that returns the real data.
  const _getModules = () => [
    {
      name: 'Agents', key: 'f1',
      items: [
        { label: '  List Agents' },        { label: '  Add Agent' },
        { label: '  Clone Slot' },          { label: '  Edit Agent' },
        { label: '  Remove Agent' },        { label: '  Reorder Agents' },
        { label: '  Check Agent Health' },  { label: '  Login / Auth' },
        { label: ' ─────────────────' },    { label: '  Provider Keys' },
        { label: ' ─────────────────' },    { label: '  Batch Rotate Keys' },
        { label: ' ─────────────────' },    { label: '  Live Health' },
        { label: '  Scoreboard' },          { label: ' ─────────────────' },
        { label: '  Update Agents' },
      ],
    },
    {
      name: 'Reqs', key: 'f2',
      items: [
        { label: '  Browse Reqs' },   { label: '  Coverage' },
        { label: '  Traceability' },   { label: '  Aggregate' },
        { label: '  Coverage Gaps' },
        { label: '  Gate Scoring' },
      ],
    },
    {
      name: 'Config', key: 'f3',
      items: [
        { label: '  Settings' },       { label: '  Tune Timeouts' },
        { label: '  Set Update Policy' }, { label: ' ─────────────────' },
        { label: '  Export Roster' },  { label: '  Import Roster' },
        { label: ' ─────────────────' }, { label: '  Exit' },
      ],
    },
    {
      name: 'Sessions', key: 'f4',
      items: [{ label: '  New Session' }],
    },
  ];

  const ssIdx = cliArgs.indexOf('--screenshot');
  const moduleName = (cliArgs[ssIdx + 1] || '').toLowerCase();
  const SCREENSHOT_MODULES = _getModules();
  const moduleMap = {};
  SCREENSHOT_MODULES.forEach((m, i) => { moduleMap[m.name.toLowerCase()] = i; });

  if (!(moduleName in moduleMap)) {
    const names = SCREENSHOT_MODULES.map(m => m.name.toLowerCase()).join('|');
    process.stderr.write(`Usage: nForma --screenshot <${names}>\n`);
    process.exit(1);
  }

  const idx = moduleMap[moduleName];
  const mod = SCREENSHOT_MODULES[idx];

  // Build synthetic ANSI representation matching TUI layout
  const ESC = '\x1b';
  const TEAL = `${ESC}[36m`;
  const DIM = `${ESC}[90m`;
  const WHITE = `${ESC}[37m`;
  const BOLD = `${ESC}[1m`;
  const RESET = `${ESC}[0m`;
  const SALMON = `${ESC}[38;2;244;149;106m`;
  const CYAN_NF = `${ESC}[38;2;125;207;255m`;
  const SELBG = `${ESC}[48;2;30;58;58m`;

  const GREEN = `${ESC}[32m`;
  const YELLOW = `${ESC}[33m`;
  const RED = `${ESC}[31m`;
  const BLUE = `${ESC}[34m`;
  const MAGENTA = `${ESC}[35m`;

  // ─── Sample content for each module ─────────────────────────────────────────
  const CW = 85; // content column width
  const pad = (s, len) => { const plain = s.replace(/\x1b\[[0-9;]*m/g, ''); return s + ' '.repeat(Math.max(0, len - plain.length)); };

  const contentByModule = {
    agents: [
      `${WHITE}${BOLD} Agent Roster${RESET}`,
      ` ${DIM}${'─'.repeat(CW - 3)}${RESET}`,
      ``,
      `  ${DIM}Slot            Provider        Model                   Status${RESET}`,
      `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
      `  ${TEAL}codex-1${RESET}         OpenAI          ${WHITE}codex-mini-latest${RESET}       ${GREEN}● healthy${RESET}  ${DIM}142ms${RESET}`,
      `  ${TEAL}gemini-1${RESET}        Google          ${WHITE}gemini-2.5-pro${RESET}          ${GREEN}● healthy${RESET}  ${DIM}89ms${RESET}`,
      `  ${TEAL}copilot-1${RESET}       GitHub          ${WHITE}gpt-4.1${RESET}                 ${GREEN}● healthy${RESET}  ${DIM}203ms${RESET}`,
      `  ${TEAL}opencode-1${RESET}      OpenCode        ${WHITE}claude-sonnet-4-5${RESET}       ${GREEN}● healthy${RESET}  ${DIM}167ms${RESET}`,
      `  ${TEAL}claude-1${RESET}        AkashML         ${WHITE}DeepSeek-R1${RESET}             ${GREEN}● healthy${RESET}  ${DIM}312ms${RESET}`,
      `  ${TEAL}claude-2${RESET}        Together.xyz    ${WHITE}Qwen3-Coder${RESET}             ${YELLOW}● slow${RESET}    ${DIM}1.2s${RESET}`,
      `  ${TEAL}claude-3${RESET}        Fireworks       ${WHITE}kimi-k2${RESET}                 ${GREEN}● healthy${RESET}  ${DIM}198ms${RESET}`,
      ``,
      `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
      `  ${WHITE}7${RESET} ${DIM}agents configured${RESET}  ${GREEN}6${RESET} ${DIM}healthy${RESET}  ${YELLOW}1${RESET} ${DIM}slow${RESET}  ${RED}0${RESET} ${DIM}offline${RESET}`,
      ``,
      `  ${DIM}Quorum active:${RESET} ${TEAL}codex-1${RESET} ${TEAL}gemini-1${RESET} ${TEAL}copilot-1${RESET} ${TEAL}claude-1${RESET}`,
      `  ${DIM}Claude is always the 5th voting member.${RESET}`,
    ],
    reqs: (() => {
      try {
        const _rc = require('./requirements-core.cjs');
        const _pm = require('./principle-mapping.cjs');
        const { requirements: _reqs } = _rc.readRequirementsJson();
        const _grouped = _rc.groupByPrinciple(_reqs);
        const _total = _reqs.length;
        const _cats = new Set(_reqs.map(r => r.category || 'Uncategorized'));
        const _lines = [
          `${WHITE}${BOLD} Requirements${RESET}  ${DIM}${_total} total · 8 principles · ${_cats.size} categories${RESET}`,
          ` ${DIM}${'─'.repeat(CW - 3)}${RESET}`,
          ``,
          `  ${DIM}Principle                      Specs${RESET}`,
          `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
        ];
        for (const p of _pm.PRINCIPLES) {
          const g = _grouped[p];
          _lines.push(`  ${WHITE}${p.padEnd(30)}${RESET} ${TEAL}${String(g.count).padStart(4)}${RESET}`);
        }
        _lines.push(``);
        _lines.push(`  ${DIM}${'─'.repeat(CW - 5)}${RESET}`);
        _lines.push(`  ${GREEN}${_total}${RESET} ${DIM}total requirements across${RESET} ${TEAL}8${RESET} ${DIM}principles${RESET}`);
        return _lines;
      } catch (_) {
        return [`${WHITE}${BOLD} Requirements${RESET}  ${DIM}(data unavailable)${RESET}`];
      }
    })(),
    config: [
      `${WHITE}${BOLD} Configuration${RESET}`,
      ` ${DIM}${'─'.repeat(CW - 3)}${RESET}`,
      ``,
      `  ${DIM}Setting                     Value${RESET}`,
      `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
      `  ${WHITE}mode${RESET}                        ${TEAL}interactive${RESET}`,
      `  ${WHITE}depth${RESET}                       ${TEAL}standard${RESET}`,
      `  ${WHITE}model_profile${RESET}               ${TEAL}balanced${RESET}`,
      `  ${WHITE}workflow.research${RESET}           ${GREEN}true${RESET}`,
      `  ${WHITE}workflow.plan_check${RESET}         ${GREEN}true${RESET}`,
      `  ${WHITE}workflow.verifier${RESET}           ${GREEN}true${RESET}`,
      `  ${WHITE}workflow.auto_advance${RESET}       ${GREEN}true${RESET}`,
      `  ${WHITE}parallelization.enabled${RESET}     ${GREEN}true${RESET}`,
      `  ${WHITE}nyquist_validation${RESET}          ${GREEN}true${RESET}`,
      `  ${WHITE}git.branching_strategy${RESET}      ${TEAL}none${RESET}`,
      ``,
      `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
      `  ${DIM}Config path: .planning/config.json${RESET}`,
    ],
    sessions: [
      `${WHITE}${BOLD} Session History${RESET}`,
      ` ${DIM}${'─'.repeat(CW - 3)}${RESET}`,
      ``,
      `  ${DIM}Session                Started        Duration    Tokens${RESET}`,
      `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
      `  ${WHITE}quick-240${RESET}              ${DIM}09 Mar 10:42${RESET}   ${WHITE}12m${RESET}        ${DIM}48,200${RESET}`,
      `  ${WHITE}quick-239${RESET}              ${DIM}09 Mar 09:15${RESET}   ${WHITE}8m${RESET}         ${DIM}31,400${RESET}`,
      `  ${WHITE}quick-238${RESET}              ${DIM}08 Mar 22:30${RESET}   ${WHITE}15m${RESET}        ${DIM}52,800${RESET}`,
      `  ${WHITE}quick-237${RESET}              ${DIM}08 Mar 19:45${RESET}   ${WHITE}6m${RESET}         ${DIM}24,100${RESET}`,
      `  ${WHITE}quick-236${RESET}              ${DIM}08 Mar 16:20${RESET}   ${WHITE}22m${RESET}        ${DIM}89,600${RESET}`,
      `  ${WHITE}quick-235${RESET}              ${DIM}07 Mar 21:10${RESET}   ${WHITE}11m${RESET}        ${DIM}41,500${RESET}`,
      `  ${WHITE}quick-234${RESET}              ${DIM}07 Mar 18:55${RESET}   ${WHITE}9m${RESET}         ${DIM}35,200${RESET}`,
      `  ${WHITE}quick-233${RESET}              ${DIM}07 Mar 14:30${RESET}   ${WHITE}18m${RESET}        ${DIM}67,900${RESET}`,
      ``,
      `  ${DIM}${'─'.repeat(CW - 5)}${RESET}`,
      `  ${DIM}8 sessions · 101m total · 390,700 tokens${RESET}`,
    ],
  };

  const contentLines = contentByModule[moduleName] || [];

  // Header — left: logo + version, right: cwd
  const W = 118;
  const leftH  = `${SALMON}${BOLD}n${CYAN_NF}Forma${RESET} ${SALMON}AI${RESET} ${DIM}v${NF_VERSION}${RESET}`;
  const rightH = `${DIM}cwd:${RESET} ${TEAL}${getTargetPath()}${RESET}`;
  const ansiLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const gapH = ' '.repeat(Math.max(1, W - ansiLen(leftH) - ansiLen(rightH)));
  process.stdout.write(` ${'─'.repeat(W)} \n`);
  process.stdout.write(`  ${leftH}${gapH}${rightH}  \n`);
  process.stdout.write(` ${'─'.repeat(7)} ${'─'.repeat(24)} ${'─'.repeat(85)} \n`);

  // Activity bar icons + menu + content area
  const artByModule = [
    ['▄█▄', '█ █', '█▀█'],
    ['█▀█', '██▀', '█ █'],
    ['▄▀▀', '█  ', '▀▄▄'],
    ['▄▀▄', '█▀▀', '▀▄▄'],
  ];

  // Extract plain label text from items (strip blessed tags and leading spaces)
  const menuLabels = mod.items.map(it => {
    const raw = (it.label || '').replace(/\{[^}]*\}/g, '').trim();
    return raw;
  });
  const totalRows = Math.max(menuLabels.length + 2, contentLines.length, 20);

  for (let r = 0; r < totalRows; r++) {
    // Activity bar column (7 chars wide)
    let actCol = '       ';
    // Each module block takes 5 rows: blank, art[0], art[1], art[2], key label
    // Plus 1 separator row between modules
    for (let mi = 0; mi < 4; mi++) {
      const baseRow = mi * 6;
      const art = artByModule[mi];
      const isActive = mi === idx;
      const color = isActive ? TEAL : DIM;
      if (r === baseRow + 1) actCol = ` ${color}${art[0]}${RESET}   `;
      if (r === baseRow + 2) actCol = ` ${color}${art[1]}${RESET}   `;
      if (r === baseRow + 3) actCol = ` ${color}${art[2]}${RESET}   `;
      if (r === baseRow + 4) actCol = `  ${color}${SCREENSHOT_MODULES[mi].key.toUpperCase()}${RESET}  `;
      if (r === baseRow + 5 && mi < 3) actCol = ` ${DIM}─────${RESET} `;
    }

    // Menu column (24 chars wide)
    let menuCol = ' '.repeat(24);
    if (r < menuLabels.length) {
      const item = menuLabels[r];
      const isSep = item.startsWith('─');
      const isSelected = r === 0;
      if (isSep) {
        menuCol = ` ${DIM}${item}${RESET}`.padEnd(24);
      } else if (isSelected) {
        menuCol = `${SELBG}  ${WHITE}${item}${RESET}`.padEnd(24);
      } else {
        menuCol = `  ${DIM}${item}${RESET}`.padEnd(24);
      }
    }

    // Content column — rich sample data per module
    let contentCol = ' '.repeat(CW);
    if (r < contentLines.length && contentLines[r] !== undefined) {
      const line = contentLines[r] || '';
      contentCol = pad(line, CW);
    }

    process.stdout.write(` ${actCol} ${menuCol} ${contentCol} \n`);
  }

  // Status bar
  process.stdout.write(` ${'─'.repeat(7)} ${'─'.repeat(24)} ${'─'.repeat(85)} \n`);
  process.stdout.write(`  ${DIM}nForma TUI${RESET}${' '.repeat(107)} \n`);
  process.stdout.write(` ${'─'.repeat(118)} \n`);

  process.exit(0);
}

// ─── TUI (interactive mode — no CLI flags matched) ───────────────────────────
const blessed    = require('blessed');
// Pure JS terminal widget — replaces blessed-xterm (which required node-pty native addon).
// Uses @xterm/headless + child_process.spawn instead. Zero native dependencies.
const XTerm = require('./blessed-terminal.cjs');

// ─── Reuse logic layer from manage-agents-core.cjs ───────────────────────────
const core = require('./manage-agents-core.cjs');
const pure = core._pure;

const { readClaudeJson, writeClaudeJson, getGlobalMcpServers } = core;
const {
  buildDashboardLines, probeAllSlots,
  maskKey, deriveSecretAccount,
  readNfJson, writeNfJson,
  buildExportData, validateImportSchema, buildBackupPath,
  buildTimeoutChoices, applyTimeoutUpdate,
  buildPolicyChoices,
  validateTimeout, validateUpdatePolicy,
  runAutoUpdateCheck,
  probeAndPersistKey,
} = pure;

const { updateAgents, getUpdateStatuses } = require('./update-agents.cjs');
const reqCore = require('./requirements-core.cjs');
const principleMapping = require('./principle-mapping.cjs');

// ─── File paths ───────────────────────────────────────────────────────────────
const CLAUDE_JSON_PATH   = path.join(os.homedir(), '.claude.json');
const PROVIDERS_JSON     = path.join(__dirname, 'providers.json');
const PROVIDERS_JSON_TMP = PROVIDERS_JSON + '.tmp';
const SESSIONS_FILE      = path.join(os.homedir(), '.claude', 'nf', 'sessions.json');

// ─── Constants ────────────────────────────────────────────────────────────────
const PROVIDER_KEY_NAMES = [
  { key: 'AKASHML_API_KEY',   label: 'AkashML API Key'     },
  { key: 'TOGETHER_API_KEY',  label: 'Together.xyz API Key' },
  { key: 'FIREWORKS_API_KEY', label: 'Fireworks API Key'    },
];

const PROVIDER_PRESETS = [
  { label: 'AkashML       (api.akashml.com/v1)',            value: 'https://api.akashml.com/v1'            },
  { label: 'Together.xyz  (api.together.xyz/v1)',           value: 'https://api.together.xyz/v1'           },
  { label: 'Fireworks.ai  (api.fireworks.ai/inference/v1)', value: 'https://api.fireworks.ai/inference/v1' },
  { label: 'Custom URL…',                                   value: '__custom__'                            },
  { label: 'None (subprocess only)',                        value: ''                                      },
];

const MODULES = [
  {
    name: 'Agents',
    icon: '⚡',
    art: ['▄█▄', '█ █', '█▀█'],
    key: 'f1',
    items: [
      { label: '  List Agents',              action: 'list'          },
      { label: '  Add Agent',               action: 'add'           },
      { label: '  Clone Slot',              action: 'clone'         },
      { label: '  Edit Agent',              action: 'edit'          },
      { label: '  Remove Agent',            action: 'remove'        },
      { label: '  Reorder Agents',          action: 'reorder'       },
      { label: '  Check Agent Health',      action: 'health-single' },
      { label: '  Login / Auth',            action: 'login'         },
      { label: ' ─────────────────',        action: 'sep'           },
      { label: '  Provider Keys',           action: 'provider-keys' },
      { label: ' ─────────────────',        action: 'sep'           },
      { label: '  Batch Rotate Keys',       action: 'batch-rotate'  },
      { label: ' ─────────────────',        action: 'sep'           },
      { label: '  Live Health',             action: 'health'        },
      { label: '  Scoreboard',              action: 'scoreboard'    },
      { label: ' ─────────────────',        action: 'sep'           },
      { label: '  Update Agents',           action: 'update-agents' },
    ],
  },
  {
    name: 'Reqs',
    icon: '◆',
    art: ['█▀█', '██▀', '█ █'],
    key: 'f2',
    items: [
      { label: '  Browse Reqs',             action: 'req-browse'       },
      { label: '  Coverage',                action: 'req-coverage'     },
      { label: '  Traceability',            action: 'req-traceability' },
      { label: '  Aggregate',               action: 'req-aggregate'    },
      { label: '  Coverage Gaps',           action: 'req-gaps'         },
      { label: '  Gate Scoring',            action: 'req-gate-scoring' },
    ],
  },
  {
    name: 'Config',
    icon: '⚙',
    art: ['▄▀▀', '█  ', '▀▄▄'],
    key: 'f3',
    items: [
      { label: '  Settings',                action: 'settings'      },
      { label: '  Tune Timeouts',           action: 'tune-timeouts' },
      { label: '  Set Update Policy',       action: 'update-policy' },
      { label: ' ─────────────────',        action: 'sep'           },
      { label: '  Export Roster',           action: 'export'        },
      { label: '  Import Roster',           action: 'import'        },
      { label: ' ─────────────────',        action: 'sep'           },
      { label: '  Exit',                    action: 'exit'          },
    ],
  },
  {
    name: 'Sessions',
    icon: '\u25b6',
    art: ['\u2584\u2580\u2584', '\u2588\u2580\u2580', '\u2580\u2584\u2584'],
    key: 'f4',
    items: [
      { label: '  New Session',    action: 'session-new' },
    ],
  },
  {
    name: 'Solve',
    icon: '\uD83D\uDD0D',
    art: ['\u2584\u2580\u2580', ' \u2580\u2584', '\u2584\u2584\u2580'],
    key: 'f5',
    items: [
      { label: '  Browse Items',           action: 'solve-browse' },
      { label: ' \u2500\u2500 Forward \u2500\u2500\u2500\u2500\u2500\u2500', action: 'sep' },
      { label: '  R->F Req\u2192Formal',       action: 'solve-rtof' },
      { label: '  F->T Formal\u2192Test',      action: 'solve-ftot' },
      { label: '  C->F Code\u2192Formal',      action: 'solve-ctof' },
      { label: '  T->C Test\u2192Code',        action: 'solve-ttoc' },
      { label: '  F->C Formal\u2192Code',      action: 'solve-ftoc' },
      { label: '  R->D Req\u2192Docs',         action: 'solve-rtod' },
      { label: '  D->C Broken Claims',     action: 'solve-dtoc' },
      { label: '  P->F Prod\u2192Formal',      action: 'solve-ptof' },
      { label: ' \u2500\u2500 Reverse \u2500\u2500\u2500\u2500\u2500\u2500', action: 'sep' },
      { label: '  C->R Untraced Modules',  action: 'solve-ctor' },
      { label: '  T->R Orphan Tests',      action: 'solve-ttor' },
      { label: '  D->R Unbacked Claims',   action: 'solve-dtor' },
      { label: ' \u2500\u2500 Layer Align \u2500\u2500\u2500', action: 'sep' },
      { label: '  L1->L2 Wiring:Evidence',  action: 'solve-l1tol2' },
      { label: '  L2->L3 Wiring:Purpose',  action: 'solve-l2tol3' },
      { label: '  L3->TC Wiring:Coverage', action: 'solve-l3totc' },
      { label: ' \u2500\u2500 Evidence \u2500\u2500\u2500\u2500\u2500', action: 'sep' },
      { label: '  F->G Model Maturity',    action: 'solve-ftog' },
      { label: '  C->E Git Heatmap',       action: 'solve-ctoe' },
      { label: '  G->F History Drift',     action: 'solve-gtof' },
      { label: '  F->F Formal Lint',       action: 'solve-ftof' },
      { label: '  F->H Hazard FMEA',       action: 'solve-ftoh' },
      { label: ' \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', action: 'sep' },
      { label: '  Manage Suppressions',    action: 'solve-suppressions' },
      { label: '  Classify All (Haiku)',   action: 'solve-classify' },
    ],
  },
];

// Backward compat: flat array of all items across modules (tests + exports rely on this)
const MENU_ITEMS = MODULES.flatMap(m => m.items);

// ─── Event log ──────────────────────────────────────────────────────────────
const _logEntries = [];   // { ts, level, msg }
const LOG_MAX = 200;

function logEvent(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  _logEntries.push({ ts, level, msg });
  if (_logEntries.length > LOG_MAX) _logEntries.shift();
}

// ─── Session state & persistence ─────────────────────────────────────────────
const sessions = [];        // { id, name, cwd, claudeSessionId, term (BlessedTerminal widget), alive }
let activeSessionIdx = -1;  // -1 = no terminal shown
let sessionIdCounter = 0;

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (_) { return []; }
}

function savePersistedSessions() {
  const data = sessions.map(s => ({
    id: s.id, name: s.name, cwd: s.cwd, claudeSessionId: s.claudeSessionId,
  }));
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function removePersistedSession(claudeSessionId) {
  try {
    const persisted = loadPersistedSessions();
    const filtered = persisted.filter(s => s.claudeSessionId !== claudeSessionId);
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (_) {}
}

// ─── Module switching (activity bar) ──────────────────────────────────────────
let activeModuleIdx = 0;

function switchModule(idx) {
  // Dismiss any open modal (e.g. promptList) before switching
  dismissActiveModal();
  // Hide active terminal when leaving Sessions module
  if (activeModuleIdx === 3 && activeSessionIdx >= 0 && activeSessionIdx < sessions.length) {
    sessions[activeSessionIdx].term.hide();
    contentBox.show();
  }
  activeModuleIdx = idx;
  const mod = MODULES[idx];
  refreshStatusBar();

  // Update activity bar icons — 3-line pixel art per module
  const blocks = MODULES.map((m, i) => {
    const active = (i === idx);
    const C = active ? '{#7dcfff-fg}' : `{${S.dim}-fg}`;
    const E = '{/}';
    const fk = m.key.toUpperCase();
    const lines = [
      '',
      ...m.art.map(row => ` ${C}${row}${E}`),
      `  ${C}${fk}${E}`,
    ];
    if (i < MODULES.length - 1) lines.push(` {#333333-fg}─────{/}`);
    return lines.join('\n');
  });
  activityBar.setContent(blocks.join('\n'));

  // Swap menu items
  menuList.clearItems();
  menuList.setItems(mod.items.map(m => m.label));
  menuList.setLabel(` {${S.dim}-fg}${mod.name}{/} `);
  menuList.select(0);
  menuList.focus();
  // Force full redraw to clear any ghost artifacts from rapid content updates (e.g. solve streaming)
  screen.alloc();
  screen.render();

  // If switching TO Sessions with an active session, reconnect terminal
  if (idx === 3 && activeSessionIdx >= 0 && activeSessionIdx < sessions.length) {
    connectSession(activeSessionIdx);
    return;
  }

  // Sessions module: don't auto-dispatch (avoids unwanted "New Session" modal)
  if (idx === 3) {
    renderSessionsOverview();
    return;
  }

  // Auto-show first item's content (skip interactive actions that open modals)
  const interactive = new Set(['req-browse', 'req-traceability', 'req-aggregate']);
  const first = mod.items[0];
  if (first && first.action !== 'sep' && !interactive.has(first.action)) {
    const viewAction = first.action === 'settings' ? 'settings-view' : first.action;
    dispatch(viewAction);
  } else if (first && interactive.has(first.action)) {
    // Show static overview instead of opening a modal
    dispatch('req-coverage');
  }
}

// ─── Sessions overview (content panel when no active terminal) ───────────────
function renderSessionsOverview() {
  const persisted = loadPersistedSessions();
  const lines = [];
  lines.push('{bold}Sessions{/bold}');
  lines.push('─'.repeat(50));
  lines.push('');

  if (sessions.length > 0) {
    lines.push('{bold}Active Sessions{/bold}');
    for (const s of sessions) {
      const status = s.alive ? '{green-fg}● running{/}' : '{red-fg}● stopped{/}';
      lines.push(`  {#4a9090-fg}[${s.id}]{/} ${s.name}  ${status}  {#777777-fg}${s.cwd}{/}`);
    }
    lines.push('');
  }

  if (persisted.length > 0) {
    lines.push('{bold}Previous Sessions{/bold}');
    for (const p of persisted) {
      lines.push(`  {#777777-fg}[${p.id}]{/} ${p.name}  {#555555-fg}${p.cwd || ''}{/}`);
    }
    lines.push('');
  }

  if (sessions.length === 0 && persisted.length === 0) {
    lines.push('{#777777-fg}No sessions yet.{/}');
    lines.push('');
    lines.push('{#777777-fg}Select "New Session" to start a Claude session with nForma context.{/}');
    lines.push('{#777777-fg}Sessions persist across TUI restarts — resume where you left off.{/}');
  }

  lines.push('');
  lines.push('{#555555-fg}Tip: Select "New Session" from the menu, or press Enter on a previous session to resume.{/}');

  setContent('Sessions', lines.join('\n'));
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

function refreshSessionMenu() {
  const mod = MODULES[3]; // Sessions
  const items = [{ label: '  New Session', action: 'session-new' }];

  // Show persisted sessions that aren't currently loaded
  const loadedIds = new Set(sessions.map(s => s.claudeSessionId));
  const persisted = loadPersistedSessions().filter(p => !loadedIds.has(p.claudeSessionId));
  if (persisted.length > 0) {
    items.push({ label: ' \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', action: 'sep' });
    items.push({ label: ' {#888888-fg}Previous Sessions{/}', action: 'sep' });
    persisted.forEach(p => {
      items.push({
        label: `  {yellow-fg}\u21bb{/} [${p.id}] ${p.name}`,
        action: `session-resume-${p.claudeSessionId}`,
      });
    });
  }

  if (sessions.length > 0) {
    items.push({ label: ' \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', action: 'sep' });
    items.push({ label: ' {#888888-fg}Active Sessions{/}', action: 'sep' });
    sessions.forEach((s, i) => {
      const status = s.alive ? '{green-fg}\u25cf{/}' : '{red-fg}\u25cb{/}';
      const active = (i === activeSessionIdx) ? '{#4a9090-fg}\u25b8{/} ' : '  ';
      items.push({
        label: `${active}${status} [${s.id}] ${s.name}`,
        action: `session-connect-${i}`,
      });
    });
    items.push({ label: ' \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', action: 'sep' });
    items.push({ label: '  Kill Session', action: 'session-kill' });
  }

  mod.items = items;
  // If Sessions module is active, refresh the visible menu
  if (activeModuleIdx === 3) {
    menuList.clearItems();
    menuList.setItems(mod.items.map(m => m.label));
    screen.render();
  }
}

function createSession(name, cwd, resumeSessionId) {
  // Guard: fall back to getTargetPath() if provided cwd no longer exists (e.g., resumed session)
  let effectiveCwd = cwd || getTargetPath();
  if (!fs.existsSync(effectiveCwd)) {
    logEvent('warn', `Session cwd "${effectiveCwd}" no longer exists, falling back to ${getTargetPath()}`);
    effectiveCwd = getTargetPath();
  }
  const id = ++sessionIdCounter;
  const claudeSessionId = resumeSessionId || crypto.randomUUID();
  const args = resumeSessionId
    ? ['--resume', resumeSessionId]
    : ['--session-id', claudeSessionId];
  const term = new XTerm({
    screen,
    parent: screen,
    shell: 'claude',
    args,
    cwd: effectiveCwd,
    cursorType: 'block',
    scrollback: 1000,
    top: 4, left: 35, right: 0, bottom: 2,
    border: { type: 'line' },
    style: {
      bg: S.mid,
      border: { fg: S.bdr },
      focus: { border: { fg: '#4a9090' } },
    },
    label: ` {#4a9090-fg}${name}{/} `,
    tags: true,
    ignoreKeys: ['f1', 'f2', 'f3', 'f4', 'C-\\\\'],
  });
  term.hide();

  const session = { id, name, cwd: effectiveCwd, claudeSessionId, term, alive: true };
  sessions.push(session);
  savePersistedSessions();

  term.on('exit', () => {
    session.alive = false;
    refreshSessionMenu();
    if (activeSessionIdx === sessions.indexOf(session)) {
      toast(`Session "${name}" exited`);
    }
    screen.render();
  });

  refreshSessionMenu();
  connectSession(sessions.length - 1);
  return session;
}

function connectSession(idx) {
  if (idx < 0 || idx >= sessions.length) return;
  // Hide contentBox
  contentBox.hide();
  // Hide previous active terminal
  if (activeSessionIdx >= 0 && activeSessionIdx < sessions.length) {
    sessions[activeSessionIdx].term.hide();
  }
  // Show and focus new terminal
  activeSessionIdx = idx;
  sessions[idx].term.show();
  sessions[idx].term.focus();
  screen.render();
}

function disconnectSession() {
  if (activeSessionIdx >= 0 && activeSessionIdx < sessions.length) {
    sessions[activeSessionIdx].term.hide();
  }
  activeSessionIdx = -1;
  contentBox.show();
  menuList.focus();
  screen.render();
}

function killSession(idx) {
  if (idx < 0 || idx >= sessions.length) return;
  const session = sessions[idx];
  try { session.term.terminate(); } catch (_) {}
  screen.remove(session.term);
  removePersistedSession(session.claudeSessionId);
  sessions.splice(idx, 1);
  // Adjust activeSessionIdx
  if (activeSessionIdx === idx) {
    disconnectSession();
  } else if (activeSessionIdx > idx) {
    activeSessionIdx--;
  }
  refreshSessionMenu();
}

async function newSessionFlow() {
  const name = await promptInput({ title: 'New Session', prompt: 'Session name:' });
  if (!name) return;
  const cwd = await promptInput({ title: 'New Session', prompt: 'Working directory:', default: getTargetPath() });
  createSession(name, cwd || getTargetPath());
}

async function killSessionFlow() {
  const items = [];
  sessions.forEach((s, i) => {
    items.push({
      label: `[${s.id}] ${s.name} (${s.alive ? 'alive' : 'dead'})`,
      value: { type: 'active', idx: i },
    });
  });
  // Also offer to remove persisted (inactive) sessions
  const loadedIds = new Set(sessions.map(s => s.claudeSessionId));
  const persisted = loadPersistedSessions().filter(p => !loadedIds.has(p.claudeSessionId));
  persisted.forEach(p => {
    items.push({
      label: `[${p.id}] ${p.name} (saved)`,
      value: { type: 'persisted', claudeSessionId: p.claudeSessionId },
    });
  });
  if (items.length === 0) { toast('No sessions to kill'); return; }
  const choice = await promptList({ title: 'Kill Session', items });
  if (choice.value.type === 'active') {
    killSession(choice.value.idx);
  } else {
    removePersistedSession(choice.value.claudeSessionId);
    refreshSessionMenu();
    toast('Saved session removed');
  }
}

// ─── Providers.json helpers ───────────────────────────────────────────────────
function readProvidersJson() {
  if (!fs.existsSync(PROVIDERS_JSON)) return { providers: [] };
  return JSON.parse(fs.readFileSync(PROVIDERS_JSON, 'utf8'));
}
function writeProvidersJson(data) {
  fs.writeFileSync(PROVIDERS_JSON_TMP, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(PROVIDERS_JSON_TMP, PROVIDERS_JSON);
}

// ─── Update policy helper ────────────────────────────────────────────────────
function writeUpdatePolicy(slotName, policy) {
  const nfCfg = readNfJson();
  if (!nfCfg.agent_config) nfCfg.agent_config = {};
  if (!nfCfg.agent_config[slotName]) nfCfg.agent_config[slotName] = {};
  nfCfg.agent_config[slotName].update_policy = policy;
  writeNfJson(nfCfg);
}

// ─── Secrets loader (cached — keychain prompted once per process) ─────────────
let _secretsCache = undefined;
function loadSecrets() {
  if (_secretsCache !== undefined) return _secretsCache;
  const candidates = [
    path.join(os.homedir(), '.claude', 'nf-bin', 'secrets.cjs'),
    path.join(__dirname, 'secrets.cjs'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { _secretsCache = require(p); return _secretsCache; } } catch (_) {}
  }
  _secretsCache = null;
  return null;
}

// ─── Data helpers ─────────────────────────────────────────────────────────────
function pad(str, len) { return String(str || '').slice(0, len).padEnd(len); }

function deriveProviderName(url) {
  if (!url) return 'subprocess';
  if (url.includes('akashml.com'))  return 'AkashML';
  if (url.includes('together.xyz')) return 'Together.xyz';
  if (url.includes('fireworks.ai')) return 'Fireworks';
  if (url.includes('openai.com'))   return 'OpenAI';
  if (url.includes('google'))       return 'Google';
  try { return new URL(url).hostname.replace(/^api\./, ''); } catch (_) { return url.slice(0, 14); }
}

/**
 * detectModel(meta) — read the live model from the CLI's own config file.
 * Used for subscription-based CLI providers (codex, opencode) that store
 * the active model on disk rather than in an env var.
 * Returns null on any error so callers can fall back gracefully.
 */
function detectModel(meta) {
  if (!meta.model_detect) return null;
  try {
    const filePath = meta.model_detect.file.replace(/^~/, os.homedir());
    if (!fs.existsSync(filePath)) return null;
    const content  = fs.readFileSync(filePath, 'utf8');
    const m        = content.match(new RegExp(meta.model_detect.pattern, 'm'));
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function agentRows() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const secrets = loadSecrets();

  // Cross-reference providers.json for display_type and quorum_timeout_ms
  let providerMeta = {};
  try {
    const pdata = readProvidersJson();
    for (const p of (pdata.providers || [])) providerMeta[p.name] = p;
  } catch (_) {}

  let i = 1;
  return Object.entries(servers).filter(([name]) =>
    !name.startsWith('unified-')
  ).map(([name, cfg]) => {
    const env          = cfg.env || {};
    const baseUrl      = env.ANTHROPIC_BASE_URL || '';
    const provSlot     = env.PROVIDER_SLOT || name;
    const meta         = providerMeta[provSlot] || providerMeta[name] || {};
    // MCP-server providers expose model via env; CLI providers via model_detect file or static meta.model
    const model        = env.CLAUDE_DEFAULT_MODEL || env.ANTHROPIC_MODEL
                          || detectModel(meta) || meta.model || '—';
    // MCP providers set CLAUDE_MCP_TIMEOUT_MS; CLI providers declare quorum_timeout_ms in providers.json
    const timeout      = env.CLAUDE_MCP_TIMEOUT_MS
                          ? `${env.CLAUDE_MCP_TIMEOUT_MS}ms`
                          : meta.quorum_timeout_ms ? `${meta.quorum_timeout_ms}ms` : '—';
    const displayType  = meta.display_type || (cfg.command === 'node' ? 'claude-mcp-server' : cfg.command || '?');
    const providerName = deriveProviderName(baseUrl);
    const description  = meta.description || '';

    // Key status: check env + local index (no keychain prompt)
    const account   = 'ANTHROPIC_API_KEY_' + name.toUpperCase().replace(/-/g, '_');
    let   hasKey    = !!env.ANTHROPIC_API_KEY || (secrets ? secrets.hasKey(account) : false);

    // ccr-based slots store keys in their own preset manifests — check there too
    if (!hasKey && displayType === 'claude-code-router') {
      try {
        const mf = path.join(os.homedir(), '.claude-code-router', 'presets', name, 'manifest.json');
        if (fs.existsSync(mf)) {
          const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
          hasKey = (manifest.Providers || []).some(p => !!p.api_key);
        }
      } catch (_) {}
    }

    // OAuth rotation pool info — delegated to the auth driver (no inline CLI-specific logic).
    // extractAccountName() is called even with an empty pool so single-account providers
    // (e.g. gemini with oauth_creds.json but no pool directory yet) still show their identity.
    let poolInfo = null;
    if (meta.oauth_rotation?.enabled && meta.auth?.type) {
      try {
        const { loadDriver } = require('./auth-drivers/index.cjs');
        const driver     = loadDriver(meta.auth.type);
        const accounts   = driver.list(meta);
        const activeEntry = accounts.find(a => a.active);
        const activeName  = activeEntry?.name ?? driver.extractAccountName(meta);
        if (accounts.length || activeName) {
          poolInfo = { size: accounts.length, active: activeName };
        }
      } catch (_) {}
    }

    // Providers without oauth_rotation (e.g. opencode) may declare identity_detect
    // in providers.json — the simple driver reads it via extractAccountName().
    if (!poolInfo && meta.auth?.type && meta.identity_detect) {
      try {
        const { loadDriver } = require('./auth-drivers/index.cjs');
        const identity = loadDriver(meta.auth.type).extractAccountName(meta);
        if (identity) poolInfo = { size: 0, active: identity };
      } catch (_) {}
    }

    // Last failure from quorum-failures.json (best-effort read)
    let lastFailure = null;
    try {
      let failPath;
      try {
        const pp = require('./planning-paths.cjs');
        failPath = pp.resolveWithFallback(getTargetPath(), 'quorum-failures');
      } catch (_) {
        failPath = path.join(os.homedir(), '.claude', 'nf', 'quorum-failures.json');
      }
      if (fs.existsSync(failPath)) {
        const failures = JSON.parse(fs.readFileSync(failPath, 'utf8'));
        const entry = failures[provSlot] || failures[name];
        if (entry) lastFailure = { count: entry.count || 1, type: entry.error_type || 'UNKNOWN' };
      }
    } catch (_) {}

    return { n: String(i++), name, model, timeout, env, cfg,
             baseUrl, providerName, displayType, hasKey, description,
             poolInfo, lastFailure };
  });
}

// ─── Header info (version, profile, quorum n) ────────────────────────────────
function buildHeaderInfo() {
  let version = '?';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    version = pkg.version || '?';
  } catch (_) {}

  let profile = '—';
  try {
    const cfgPath = path.join(getTargetPath(), '.planning', 'config.json');
    if (fs.existsSync(cfgPath))
      profile = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).model_profile || '—';
  } catch (_) {}

  let quorumN = '—';
  let failMode = '—';
  try {
    const nfCfg   = readNfJson();
    const defN   = nfCfg.quorum?.maxSize;
    const byProf = nfCfg.quorum?.maxSizeByProfile || {};
    const effN   = byProf[profile] ?? defN;
    if (effN != null) quorumN = String(effN) + (byProf[profile] != null ? '*' : '');
    if (nfCfg.fail_mode) failMode = nfCfg.fail_mode;
  } catch (_) {}

  // Key agent tiers — from core/references/model-profiles.md
  const TIERS = {
    planner:    { quality: 'opus',   balanced: 'opus',   budget: 'sonnet' },
    executor:   { quality: 'opus',   balanced: 'sonnet', budget: 'sonnet' },
    researcher: { quality: 'opus',   balanced: 'sonnet', budget: 'haiku'  },
    verifier:   { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku'  },
  };
  const p = TIERS.planner[profile] ? profile : 'balanced';
  const models = {
    planner:    TIERS.planner[p],
    executor:   TIERS.executor[p],
    researcher: TIERS.researcher[p],
    verifier:   TIERS.verifier[p],
  };

  return { version, profile, quorumN, failMode, models };
}

// ─── Terminal background detection ───────────────────────────────────────────
// Detect light/dark via env vars only. OSC 11 probes leak escape sequences
// into blessed's input buffer, printing raw text like ^[]11;rgb:...^[\.
// Use NF_THEME=light|dark to override, or COLORFGBG (set by most terminals).

let _detectedLightMode = false;

if (process.env.NF_THEME === 'light') {
  _detectedLightMode = true;
} else if (process.env.NF_THEME === 'dark') {
  _detectedLightMode = false;
} else if (process.env.COLORFGBG) {
  const parts = process.env.COLORFGBG.split(';');
  const bg = parseInt(parts[parts.length - 1], 10);
  if (!isNaN(bg)) _detectedLightMode = bg >= 7;
}

// ─── Screen setup ─────────────────────────────────────────────────────────────
// NF_TEST_MODE: use PassThrough streams to avoid holding the TTY open.
// This initializes blessed's global screen state (required for widget creation)
// without claiming the real terminal or keeping the event loop alive.
const screen = process.env.NF_TEST_MODE
  ? (() => {
      const { PassThrough } = require('stream');
      return blessed.screen({
        dumb: true, terminal: 'dumb', smartCSR: false, fullUnicode: false,
        input: new PassThrough(), output: new PassThrough(),
      });
    })()
  : blessed.screen({ smartCSR: true, fullUnicode: true, title: 'nForma' });

// ─── Surface palette ─────────────────────────────────────────────────────────
// Auto-selected based on terminal background (OSC 11 probe).
// Override with NF_THEME=dark or NF_THEME=light env var.
const S = _detectedLightMode
  ? { base: '#f0f0f0', mid: '#e8e8e8', top: '#f5f5f5', bdr: '#e8e8e8', sel: '#d0e8e8',
      fg: '#333333', dim: '#888888', accent: '#0e7070', headerFg: '#222222' }
  : { base: '#1a1a1a', mid: '#1e1e1e', top: '#222222', bdr: '#1e1e1e', sel: '#1e3a3a',
      fg: '#aaaaaa', dim: '#777777', accent: '#4a9090', headerFg: '#cccccc' };

const header = blessed.box({
  top: 0, left: 0, width: '100%', height: 4,
  tags: true,
  border: { type: 'line' },
  style: { bg: S.top, border: { fg: S.bdr } },
});

function renderHeader() {
  const A = S.accent;

  const tp = getTargetPath();
  const home = os.homedir();
  const display = tp.startsWith(home) ? '~' + tp.slice(home.length) : tp;

  // Line 1: logo + version left, shortcuts right
  const line1 = ` {#f4956a-fg}{bold}n{/bold}{/}{#7dcfff-fg}{bold}Forma{/bold}{/} {#f4956a-fg}AI{/} {${S.dim}-fg}v${NF_VERSION}{/}{|}{${S.dim}-fg}[Tab]{/} {${S.dim}-fg}cycle{/}  {${S.dim}-fg}[q]{/} {${S.dim}-fg}quit{/} `;
  // Line 2: cwd centered
  const line2 = `{center}{${S.dim}-fg}cwd:{/} {${A}-fg}${display}{/} {${S.dim}-fg}[ctrl-t]{/}{/center}`;

  header.setContent(line1 + '\n' + line2);
  screen.render();
}

const activityBar = blessed.box({
  top: 4, left: 0, width: 9, bottom: 2,
  tags: true,
  border: { type: 'line' },
  style: { bg: S.base, fg: S.dim, border: { fg: S.bdr } },
});

const menuList = blessed.list({
  top: 4, left: 9, width: 26, bottom: 2,
  label: ` {${S.dim}-fg}Agents{/} `, tags: true,
  border: { type: 'line' },
  style: {
    bg: S.mid,
    border: { fg: S.bdr },
    selected: { bg: S.sel, fg: S.headerFg, bold: true },
    item: { fg: S.fg },
  },
  keys: true, vi: true, mouse: true, tags: true,
  items: MODULES[0].items.map(m => m.label),
});

const contentBox = blessed.box({
  top: 4, left: 35, right: 0, bottom: 2,
  label: ` {${S.dim}-fg}Content{/} `, tags: true,
  border: { type: 'line' },
  scrollable: true, alwaysScroll: true, mouse: true,
  scrollbar: { ch: ' ', style: { bg: _detectedLightMode ? '#bbbbbb' : '#666666' } },
  style: { bg: S.mid, fg: S.fg, border: { fg: S.bdr } },
});

const statusBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 3,
  tags: true,
  border: { type: 'line' },
  style: { fg: S.fg, bg: S.top, border: { fg: S.bdr } },
});

function refreshStatusBar(extra) {
  try {
    const { requirements } = reqCore.readRequirementsJson();
    const registry     = reqCore.readModelRegistry();
    const checkResults = reqCore.readCheckResults();
    const cov          = reqCore.computeCoverage(requirements, registry, checkResults);
    const complete     = cov.byStatus.Complete || 0;
    const pending      = cov.byStatus.Pending  || 0;
    const pct          = cov.total ? Math.round(complete / cov.total * 100) : 0;
    const fmPct        = cov.total ? Math.round(cov.withFormalModels / cov.total * 100) : 0;

    const D = '{#777777-fg}', V = '{#aaaaaa-fg}', A = '{#4a9090-fg}', G = '{green-fg}', Y = '{yellow-fg}', E = '{/}';
    let line = ` ${D}Reqs${E} ${A}${cov.total}${E}` +
               `  ${G}${complete}${E}${D}✓${E}` +
               `  ${Y}${pending}${E}${D}…${E}` +
               `  ${D}(${V}${pct}%${E}${D})${E}` +
               `   ${D}Formal${E} ${V}${fmPct}%${E}`;

    // Module-specific key hints
    const hints = {
      0: '{#555555-fg}[/] filter  [u] update{/}',
      1: '{#555555-fg}[/] filter  [↑↓] scroll{/}',
      2: '',
      3: '{#555555-fg}[C-\\] disconnect{/}',
      4: '',
    };
    const hint = hints[activeModuleIdx] || '';
    if (hint) line += `   ${hint}`;

    if (extra) line += `   ${extra}`;
    statusBar.setContent(line);
  } catch (_) {
    statusBar.setContent(extra ? ` ${extra}` : '');
  }
  screen.render();
}

// ─── Settings content (rendered in contentBox when Settings action selected) ──
function buildSettingsPaneContent() {
  const cfg     = readProjectConfig();
  const nfCfg    = readNfJson();
  const profile = cfg.model_profile || 'balanced';
  const ov      = cfg.model_overrides || {};
  const defN    = nfCfg.quorum?.maxSize ?? 3;
  const byProf  = nfCfg.quorum?.maxSizeByProfile || {};
  const effN    = byProf[profile] ?? defN;
  const nStr    = String(effN) + (byProf[profile] != null ? '*' : '');
  const failStr = nfCfg.fail_mode || '—';

  const D = '{#777777-fg}', V = '{#aaaaaa-fg}', A = '{#4a9090-fg}', Z = '{/}';
  const mTag = k => ov[k] ? `${A}${ov[k]}${Z}{#888888-fg}*${Z}` : `${V}${AGENT_TIERS[k]?.[profile] || '—'}${Z}`;

  const agents = ['nf-planner', 'nf-executor', 'nf-phase-researcher', 'nf-verifier', 'nf-codebase-mapper'];
  const labels = ['Planner', 'Executor', 'Researcher', 'Verifier', 'Mapper'];

  const lines = [
    `{bold}Project Settings{/bold}`,
    `${'─'.repeat(40)}`,
    ``,
    `  ${D}Profile    ${Z} {bold}${V}${profile}${Z}{/bold}`,
    `  ${D}Quorum n   ${Z} {bold}${V}${nStr}${Z}{/bold}`,
    `  ${D}Fail mode  ${Z} {bold}${V}${failStr}${Z}{/bold}`,
    ``,
    `{bold}Model Tiers{/bold}  {#888888-fg}(${profile} profile)${Z}`,
    `${'─'.repeat(40)}`,
    ``,
  ];

  for (let i = 0; i < agents.length; i++) {
    lines.push(`  ${D}${pad(labels[i], 12)}${Z} {bold}${mTag(agents[i])}{/bold}`);
  }

  lines.push('');
  lines.push(`{#888888-fg}  * = override active${Z}`);

  // Workflow settings section
  const wf = cfg.workflow || {};
  lines.push('');
  lines.push('{bold}Workflow{/bold}');
  lines.push(`${'─'.repeat(40)}`);
  lines.push('');
  lines.push(`  ${D}Research      ${Z} ${wf.research !== false ? '{green-fg}enabled{/}' : '{red-fg}disabled{/}'}`);
  lines.push(`  ${D}Plan check    ${Z} ${wf.plan_check !== false ? '{green-fg}enabled{/}' : '{red-fg}disabled{/}'}`);
  lines.push(`  ${D}Verifier      ${Z} ${wf.verifier !== false ? '{green-fg}enabled{/}' : '{red-fg}disabled{/}'}`);
  lines.push(`  ${D}Auto-advance  ${Z} ${wf.auto_advance ? '{green-fg}enabled{/}' : '{#777777-fg}disabled{/}'}`);

  return lines.join('\n');
}

function refreshSettingsPane() {
  // Settings now render in contentBox when Config module's Settings action is triggered
  // Only refresh if we're currently showing settings in the content area
  if (activeModuleIdx === 2 && _showingSettings) {
    setContent('Settings', buildSettingsPaneContent());
  }
}
let _showingSettings = false;

screen.append(header);
screen.append(activityBar);
screen.append(menuList);
screen.append(contentBox);
screen.append(statusBar);

// ─── Content helpers ─────────────────────────────────────────────────────────
function setContent(label, text) {
  const modName = MODULES[activeModuleIdx]?.name || '';
  const breadcrumb = label === modName || label.startsWith(modName + ' ') || label.startsWith(modName + ' —')
    ? label
    : `${modName} — ${label}`;
  contentBox.setLabel(` {${S.dim}-fg}${breadcrumb}{/} `);
  contentBox.setContent(text);
  contentBox.scrollTo(0);
  screen.alloc();
  screen.render();
}

// ─── Event log viewer ───────────────────────────────────────────────────────
function showEventLog() {
  if (!_logEntries.length) { setContent('Event Log', '{#777777-fg}No events logged.{/}'); return; }
  const levelColor = { warn: '{yellow-fg}', error: '{red-fg}', info: '{#4a9090-fg}' };
  const lines = _logEntries.map(e => {
    const c = levelColor[e.level] || '{#aaaaaa-fg}';
    return `{#555555-fg}${e.ts}{/}  ${c}${e.level.toUpperCase().padEnd(5)}{/}  ${e.msg}`;
  });
  setContent('Event Log', lines.join('\n'));
}

// ─── Promisified overlay helpers ─────────────────────────────────────────────
function promptInput(opts) {
  return new Promise((resolve, reject) => {
    const box = blessed.box({
      top: 'center', left: 'center', width: 64, height: 10,
      label: ` {#888888-fg}${opts.title}{/} `, tags: true,
      border: { type: 'line' },
      style: { bg: '#222222', border: { fg: '#444444' } },
      shadow: true,
    });
    blessed.text({ parent: box, top: 1, left: 2, content: opts.prompt || '', tags: true,
      style: { fg: '#aaaaaa', bg: '#222222' } });
    const input = blessed.textbox({
      parent: box, top: 3, left: 2, right: 2, height: 1,
      inputOnFocus: true, censor: !!opts.isPassword,
      style: { fg: '#cccccc', bg: '#2e2e2e' },
    });
    if (opts.default) input.setValue(opts.default);
    blessed.text({ parent: box, top: 6, left: 2,
      content: '{#777777-fg}[Enter]{/} confirm   [Esc] cancel', tags: true,
      style: { bg: '#222222' } });
    screen.append(box);
    input.focus();
    screen.render();
    input.once('submit', (val) => {
      screen.remove(box); menuList.focus(); screen.render();
      resolve(val.trim());
    });
    input.key(['escape'], () => {
      screen.remove(box); menuList.focus(); screen.render();
      reject(new Error('cancelled'));
    });
  });
}

let _activeModal = null;
function dismissActiveModal() {
  if (_activeModal) {
    const m = _activeModal;
    _activeModal = null;
    try { screen.remove(m.box); } catch (_) {}
    menuList.focus();
    screen.render();
    if (m.reject) m.reject(new Error('dismissed'));
  }
}

function promptList(opts) {
  return new Promise((resolve, reject) => {
    const height = Math.min((opts.items || []).length + 4, 20);
    const box = blessed.list({
      top: 'center', left: 'center', width: 52, height,
      label: ` {#888888-fg}${opts.title}{/} `, tags: true,
      border: { type: 'line' },
      style: {
        bg: '#222222',
        border: { fg: '#444444' },
        selected: { bg: '#1e3a3a', fg: '#cccccc', bold: true },
        item: { fg: '#888888' },
      },
      keys: true, vi: true, mouse: true,
      items: (opts.items || []).map(i => '  ' + i.label),
      shadow: true,
    });
    _activeModal = { box, reject };
    screen.append(box);
    box.focus();
    screen.render();
    const cleanup = () => { _activeModal = null; screen.remove(box); menuList.focus(); screen.render(); };
    box.on('select', (_, idx) => { cleanup(); resolve(opts.items[idx]); });
    box.key(['escape', 'q'], () => { cleanup(); reject(new Error('cancelled')); });
  });
}

function promptCheckbox(opts) {
  return new Promise((resolve, reject) => {
    const items = opts.items || [];
    const selected = new Set();
    const height = Math.min(items.length + 6, 24);

    function makeItemLine(item, i) {
      return `  ${selected.has(i) ? '{green-fg}[✓]{/}' : '[ ]'} ${item.label}`;
    }

    const box = blessed.list({
      top: 'center', left: 'center', width: 58, height,
      label: ` {#888888-fg}${opts.title}{/} `, tags: true,
      border: { type: 'line' },
      style: {
        bg: '#222222',
        border: { fg: '#444444' },
        selected: { bg: '#1e3a3a', fg: '#cccccc' },
        item: { fg: '#888888' },
      },
      keys: true, vi: true, mouse: true, tags: true,
      items: items.map((item, i) => makeItemLine(item, i)),
      shadow: true,
    });

    box.key(['space'], () => {
      const idx = box.selected;
      if (selected.has(idx)) selected.delete(idx); else selected.add(idx);
      box.setItems(items.map((item, i) => makeItemLine(item, i)));
      box.select(idx);
      screen.render();
    });

    box.key(['enter'], () => {
      screen.remove(box); menuList.focus(); screen.render();
      resolve(items.filter((_, i) => selected.has(i)).map(item => item.value));
    });

    box.key(['escape', 'q'], () => {
      screen.remove(box); menuList.focus(); screen.render();
      reject(new Error('cancelled'));
    });

    screen.append(box);
    box.focus();
    screen.render();
  });
}

// ─── External terminal launcher ───────────────────────────────────────────────
// Writes a temp shell script and opens it in a new Terminal.app window via osascript.
// Returns true if the terminal was opened successfully.
function spawnExternalTerminal(loginCmd) {
  const tmpScript = path.join(os.tmpdir(), 'nf-auth-' + Date.now() + '.sh');
  try {
    fs.writeFileSync(tmpScript, [
      '#!/bin/sh',
      loginCmd.map(a => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' '),
      'echo ""',
      'echo "✓ Sign-in complete. You may close this window."',
      'rm -f \'' + tmpScript + '\'',
    ].join('\n'), { mode: 0o755 });
    const r = spawnSync('osascript', ['-e',
      `tell application "Terminal"\n  do script "bash '${tmpScript}'"\n  activate\nend tell`
    ], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) { return false; }
}

// ─── Login launcher dialog (stays in TUI — opens Terminal for interactive OAuth) ─
// Opens a new terminal window running loginCmd, then either:
//   • auto-resolves when credentialFile mtime changes (file-based providers), or
//   • waits for manual [Enter] confirmation (keychain-based providers like gh).
// Resolves to 'changed' | 'manual' | throws on cancel.
function promptLoginExternal(title, loginCmd, credentialFile = null) {
  const beforeMtime = credentialFile && fs.existsSync(credentialFile)
    ? fs.statSync(credentialFile).mtimeMs : 0;

  const opened = spawnExternalTerminal(loginCmd);

  return new Promise((resolve, reject) => {
    const SPIN   = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx  = 0;
    const hint   = credentialFile
      ? '{gray-fg}Auto-completing when sign-in detected · [Enter] done · [Esc] cancel{/}'
      : '{gray-fg}[Enter] when sign-in is complete · [Esc] cancel{/}';
    const openedLine = opened
      ? '{green-fg}✓ Terminal window opened{/}'
      : '{yellow-fg}⚠ Could not open Terminal — run manually:{/}\n    ' + loginCmd.join(' ');

    const box = blessed.box({
      top: 'center', left: 'center', width: 70, height: 12,
      label: ` {#888888-fg}${title}{/} `, tags: true,
      border: { type: 'line' },
      style: { bg: '#222222', border: { fg: '#444444' } },
      shadow: true,
      keys: true, mouse: true,
    });

    function render() {
      box.setContent(
        `\n  ${openedLine}\n\n` +
        `  {#4a9090-fg}${SPIN[spinIdx % SPIN.length]}{/} Waiting for sign-in to complete…\n\n` +
        `  ${hint}`
      );
      screen.render();
    }

    screen.append(box);
    box.focus();
    render();

    let timer = null;

    function cleanup() {
      if (timer) clearInterval(timer);
      screen.remove(box); menuList.focus(); screen.render();
    }

    if (credentialFile) {
      timer = setInterval(() => {
        spinIdx++;
        try {
          const mtime = fs.existsSync(credentialFile) ? fs.statSync(credentialFile).mtimeMs : 0;
          if (mtime > beforeMtime) { cleanup(); resolve('changed'); return; }
        } catch (_) {}
        render();
      }, 500);
    } else {
      timer = setInterval(() => { spinIdx++; render(); }, 500);
    }

    box.key(['enter'], () => { cleanup(); resolve('manual'); });
    box.key(['escape', 'q'], () => { cleanup(); reject(new Error('cancelled')); });
  });
}

// ─── Toast notification ───────────────────────────────────────────────────────
function toast(msg, isError = false) {
  logEvent(isError ? 'error' : 'info', msg.replace(/\{[^}]*\}/g, ''));
  const box = blessed.message({
    top: 'center', left: 'center', width: 54, height: 5,
    border: { type: 'line' },
    style: { border: { fg: isError ? 'red' : 'green' } },
    shadow: true,
  });
  screen.append(box);
  box.display(`{${isError ? 'red' : 'green'}-fg}${msg}{/}`, 2, () => {
    screen.remove(box); menuList.focus(); screen.render();
  });
}

// ─── List Agents ─────────────────────────────────────────────────────────────
function renderList() {
  try {
    const rows = agentRows();
    const W    = { n: 3, name: 16, provider: 13, model: 38, key: 8, timeout: 9 };
    const hdr  = `{bold}{underline}${pad('#', W.n)}  ${pad('Slot', W.name)}  ${pad('Provider', W.provider)}  ${pad('Model', W.model)}  ${pad('Key', W.key)}  Timeout{/underline}{/bold}`;

    const lines = [hdr];
    rows.forEach((r, i) => {
      // Key badge — pad to 8 visual chars after tag close
      const isSubAuth = !r.baseUrl;
      const keyBadge = r.hasKey
        ? '{green-fg}● set{/}   '
        : isSubAuth
          ? '{#4a9090-fg}● sub{/}   '
          : '{red-fg}● unset{/} ';

      // Zebra stripe background
      const bg = i % 2 === 0 ? '' : '{#1e2228-bg}';
      const bgEnd = i % 2 === 0 ? '' : '{/}';

      // Line 1: main info
      lines.push(
        `${bg}${pad(r.n, W.n)}  {#4a9090-fg}${pad(r.name, W.name)}{/}  ` +
        `${pad(r.providerName, W.provider)}  ` +
        `${pad(r.model.slice(0, W.model), W.model)}  ` +
        `${keyBadge}` +
        `${r.timeout}${bgEnd}`
      );

      // Line 2: secondary details
      const details = [];
      if (r.displayType) details.push(r.displayType);
      if (r.baseUrl)     details.push(r.baseUrl);
      if (r.poolInfo) {
        const acct     = r.poolInfo.active ?? '?';
        const poolSize = r.poolInfo.size > 1 ? `  (${r.poolInfo.size} accts)` : '';
        details.push(`{cyan-fg}◉ ${acct}{/}${poolSize}`);
      }
      if (r.lastFailure) details.push('{red-fg}⚠ ' + r.lastFailure.count + 'x ' + r.lastFailure.type + '{/}');
      lines.push(`${bg}{gray-fg}     ${details.join('   ')}{/}${bgEnd}`);
      lines.push('');
    });

    setContent(`Agents (${rows.length})`, lines.join('\n'));
  } catch (err) {
    setContent('Agents', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Add Agent ────────────────────────────────────────────────────────────────
async function addAgentFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const existing = Object.keys(servers);

  const slotName = await promptInput({ title: 'Add Agent — Slot name', prompt: 'Slot name (e.g. claude-7):' });
  if (!slotName) { toast('Slot name is required', true); return; }
  if (/\s/.test(slotName)) { toast('No spaces allowed in slot name', true); return; }
  if (existing.includes(slotName)) { toast(`"${slotName}" already exists`, true); return; }

  const typeChoice = await promptList({ title: 'Add Agent — Type', items: [
    { label: 'API Agent     (claude-mcp-server — AkashML, Together, Fireworks…)', value: 'api' },
    { label: 'CLI Agent     (subprocess — codex, gemini, opencode, copilot…)',    value: 'cli' },
  ] });

  if (typeChoice.value === 'cli') {
    // CLI / subprocess agent — command + providers.json metadata
    const command  = await promptInput({ title: 'Add Agent — CLI command', prompt: 'CLI command (e.g. codex, gemini, gh):' });
    if (!command) { toast('Command is required', true); return; }
    const mainTool = await promptInput({ title: 'Add Agent — Main tool', prompt: 'Main tool name (e.g. github_copilot_chat):' });
    const model    = await promptInput({ title: 'Add Agent — Model', prompt: 'Model name (optional):' });
    const timeout  = await promptInput({ title: 'Add Agent — Timeout', prompt: 'quorum_timeout_ms:', default: '30000' });

    // Resolve CLI path (TUI-01: cross-platform path resolution)
    const resolvedCommand = resolveCli(command);

    // Validate the resolved path is executable (TUI-01: prevent broken entries)
    try {
      fs.accessSync(resolvedCommand, fs.constants.X_OK);
    } catch (err) {
      toast(`CLI not found or not executable: ${resolvedCommand}`, true);
      return;
    }

    // Route through unified-mcp-server.mjs (same format as bin/install.js)
    const unifiedMcpPath = path.join(__dirname, 'unified-mcp-server.mjs');
    if (!fs.existsSync(unifiedMcpPath)) {
      toast(`unified-mcp-server.mjs not found at ${unifiedMcpPath}`, true);
      return;
    }
    data.mcpServers = { ...servers, [slotName]: {
      type: 'stdio',
      command: 'node',
      args: [unifiedMcpPath],
      env: { PROVIDER_SLOT: slotName }
    } };
    writeClaudeJson(data);

    // Write providers.json metadata (include cli path for resolve-cli.cjs)
    const pdata = readProvidersJson();
    if (!pdata.providers) pdata.providers = [];
    const entry = { name: slotName, type: 'subprocess', display_type: `${command}-cli`, cli: resolvedCommand };
    if (mainTool) entry.mainTool = mainTool;
    if (model)    entry.model    = model;
    if (timeout)  entry.quorum_timeout_ms = parseInt(timeout, 10);
    pdata.providers.push(entry);
    writeProvidersJson(pdata);

    toast(`✓ Added CLI agent "${slotName}" at ${resolvedCommand}`);
    renderList();
    return;
  }

  // API / MCP server agent
  const preset  = await promptList({ title: 'Add Agent — Provider', items: PROVIDER_PRESETS });
  let baseUrl   = preset.value;
  if (baseUrl === '__custom__') {
    baseUrl = await promptInput({ title: 'Add Agent — Base URL', prompt: 'ANTHROPIC_BASE_URL:' });
  }

  const model   = await promptInput({ title: 'Add Agent — Model', prompt: 'CLAUDE_DEFAULT_MODEL:', default: 'claude-sonnet-4-6' });
  const apiKey  = await promptInput({ title: 'Add Agent — API Key', prompt: 'ANTHROPIC_API_KEY:', isPassword: true });
  const timeout = await promptInput({ title: 'Add Agent — Timeout', prompt: 'CLAUDE_MCP_TIMEOUT_MS:', default: '30000' });

  const env = {};
  if (baseUrl)  env.ANTHROPIC_BASE_URL   = baseUrl;
  if (model)    env.CLAUDE_DEFAULT_MODEL  = model;
  if (timeout)  env.CLAUDE_MCP_TIMEOUT_MS = timeout;
  env.PROVIDER_SLOT = slotName;

  const secrets = loadSecrets();
  if (apiKey && secrets) {
    await secrets.set('nforma', deriveSecretAccount(slotName), apiKey);
  } else if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }

  const unifiedMcpPathApi = path.join(__dirname, 'unified-mcp-server.mjs');
  data.mcpServers = { ...servers, [slotName]: { type: 'stdio', command: 'node', args: [unifiedMcpPathApi], env } };
  writeClaudeJson(data);
  toast(`✓ Added "${slotName}"`);
  renderList();
}

// ─── Clone Slot ───────────────────────────────────────────────────────────────
async function cloneSlotFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No agents to clone', true); return; }

  const source  = await promptList({ title: 'Clone Slot — Pick source',
    items: slots.map(s => ({ label: `${pad(s, 14)} ${(servers[s].env || {}).CLAUDE_DEFAULT_MODEL || '—'}`, value: s })) });
  const newName = await promptInput({ title: 'Clone Slot — New name', prompt: `New slot name (cloning ${source.value}):` });

  if (!newName || /\s/.test(newName)) { toast('Invalid slot name', true); return; }
  if (slots.includes(newName)) { toast(`"${newName}" already exists`, true); return; }

  const cloned = JSON.parse(JSON.stringify(servers[source.value]));
  if (cloned.env) cloned.env.PROVIDER_SLOT = newName;

  data.mcpServers = { ...servers, [newName]: cloned };
  writeClaudeJson(data);

  // Copy nf.json agent_config metadata from source to cloned slot
  try {
    const nfCfg = readNfJson();
    const sourceConfig = (nfCfg.agent_config || {})[source.value];
    if (sourceConfig) {
      if (!nfCfg.agent_config) nfCfg.agent_config = {};
      nfCfg.agent_config[newName] = JSON.parse(JSON.stringify(sourceConfig));
      // Clear key_status from clone (needs fresh probe)
      if (nfCfg.agent_config[newName].key_status) {
        delete nfCfg.agent_config[newName].key_status;
      }
      writeNfJson(nfCfg);
    }
  } catch (_) { /* nf.json might not exist yet -- non-fatal */ }

  toast(`✓ Cloned "${source.value}" → "${newName}"`);
  renderList();
}

// ─── Edit Agent ───────────────────────────────────────────────────────────────
async function editAgentFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No agents to edit', true); return; }

  // Pre-load providers.json for slot-picker labels (shows real model, not 'node')
  let provData = {};
  try {
    const pd = readProvidersJson();
    for (const p of (pd.providers || [])) provData[p.name] = p;
  } catch (_) {}

  while (true) {                                                // slot loop: ESC → main menu
    let target;
    try {
      target = await promptList({ title: 'Edit Agent — Pick slot',
        items: slots.map(s => {
          const env   = (servers[s].env || {});
          const model = (env.CLAUDE_DEFAULT_MODEL || provData[s]?.model || servers[s].command || '?').slice(0, 30);
          return { label: `${pad(s, 14)} ${model}`, value: s };
        }) });
    } catch (_) { return; }                                     // ESC → main menu

    const slotName = target.value;
    const cfg      = servers[slotName];
    const env      = cfg.env || {};

    // Always load providers.json meta — it's the source of truth for CLI agents
    let pMeta = {};
    try {
      const pd = readProvidersJson();
      pMeta = (pd.providers || []).find(p => p.name === slotName) || {};
    } catch (_) {}

    // CLI agents are declared as type:subprocess in providers.json.
    // cfg.command may be 'node' (unified-server) even for CLI slots.
    const isCli = pMeta.type === 'subprocess' || cfg.command !== 'node';

    while (true) {                                              // field loop: ESC → slot picker
      const fieldItems = isCli ? [
        { label: `CLI Path       ${pMeta.cli || cfg.command || '(not set)'}`, value: 'cliPath'   },
        { label: `Main Tool      ${pMeta.mainTool || '(not set)'}`,           value: 'mainTool'  },
        { label: `Model          ${pMeta.model || '(not set)'}`,              value: 'cliModel'  },
        { label: `Timeout        ${pMeta.quorum_timeout_ms || '(not set)'}`,  value: 'cliTimeout'},
      ] : [
        { label: `Model          ${env.CLAUDE_DEFAULT_MODEL || '(not set)'}`,  value: 'model'    },
        { label: `API Key        ${env.ANTHROPIC_API_KEY ? '(set)' : '(not set)'}`, value: 'apiKey'  },
        { label: `Base URL       ${env.ANTHROPIC_BASE_URL || '(not set)'}`,    value: 'baseUrl'  },
        { label: `Timeout        ${env.CLAUDE_MCP_TIMEOUT_MS || '(not set)'}`, value: 'timeout'  },
        { label: `Provider Slot  ${env.PROVIDER_SLOT || slotName}`,            value: 'provSlot' },
      ];

      let field;
      try {
        field = await promptList({ title: `Edit "${slotName}" — Field`, items: fieldItems });
      } catch (_) { break; }                                    // ESC → back to slot picker

      try {
        if (field.value === 'model') {
          const val = await promptInput({ title: `Edit "${slotName}" — Model`,
            prompt: 'CLAUDE_DEFAULT_MODEL:', default: env.CLAUDE_DEFAULT_MODEL || '' });
          if (val) env.CLAUDE_DEFAULT_MODEL = val; else delete env.CLAUDE_DEFAULT_MODEL;

        } else if (field.value === 'apiKey') {
          const val = await promptInput({ title: `Edit "${slotName}" — API Key`,
            prompt: 'ANTHROPIC_API_KEY (blank = remove):', isPassword: true });
          const secrets = loadSecrets();
          const account = deriveSecretAccount(slotName);
          if (val && secrets)      { await secrets.set('nforma', account, val); delete env.ANTHROPIC_API_KEY; }
          else if (val)             { env.ANTHROPIC_API_KEY = val; }
          else if (secrets)         { await secrets.delete('nforma', account); delete env.ANTHROPIC_API_KEY; }
          else                      { delete env.ANTHROPIC_API_KEY; }

        } else if (field.value === 'baseUrl') {
          let preset;
          try { preset = await promptList({ title: `Edit "${slotName}" — Base URL`, items: PROVIDER_PRESETS }); }
          catch (_) { continue; }                               // ESC at preset picker → re-show field picker
          let baseUrl = preset.value;
          if (baseUrl === '__custom__') {
            baseUrl = await promptInput({ title: `Edit "${slotName}" — Base URL`, prompt: 'ANTHROPIC_BASE_URL:' });
          }
          if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl; else delete env.ANTHROPIC_BASE_URL;

        } else if (field.value === 'timeout') {
          const val = await promptInput({ title: `Edit "${slotName}" — Timeout`,
            prompt: 'CLAUDE_MCP_TIMEOUT_MS:', default: env.CLAUDE_MCP_TIMEOUT_MS || '30000' });
          if (val) env.CLAUDE_MCP_TIMEOUT_MS = val; else delete env.CLAUDE_MCP_TIMEOUT_MS;

        } else if (field.value === 'provSlot') {
          const val = await promptInput({ title: `Edit "${slotName}" — Provider Slot`,
            prompt: 'PROVIDER_SLOT:', default: env.PROVIDER_SLOT || slotName });
          env.PROVIDER_SLOT = val || slotName;

        } else if (['cliPath', 'mainTool', 'cliModel', 'cliTimeout'].includes(field.value)) {
          const prompts = {
            cliPath:    { label: 'CLI path',           key: 'cli',               cur: pMeta.cli || cfg.command, transform: v => v },
            mainTool:   { label: 'Main tool',          key: 'mainTool',          cur: pMeta.mainTool,           transform: v => v },
            cliModel:   { label: 'Model',              key: 'model',             cur: pMeta.model,              transform: v => v },
            cliTimeout: { label: 'quorum_timeout_ms',  key: 'quorum_timeout_ms', cur: pMeta.quorum_timeout_ms,  transform: v => parseInt(v, 10) },
          };
          const { label, key, cur, transform } = prompts[field.value];
          const val = await promptInput({ title: `Edit "${slotName}" — ${label}`, prompt: `${label}:`, default: String(cur || '') });
          const pd  = readProvidersJson();
          let entry = (pd.providers || []).find(p => p.name === slotName);
          if (!entry) { entry = { name: slotName, type: 'subprocess' }; pd.providers = [...(pd.providers || []), entry]; }
          if (val) entry[key] = transform(val); else delete entry[key];
          writeProvidersJson(pd);
          toast(`✓ Saved "${slotName}"`);
          renderList();
          continue;                                             // re-show field picker after CLI save
        }
      } catch (_) { continue; }                                // ESC during value input → re-show field picker

      cfg.env = env;
      data.mcpServers[slotName] = cfg;
      writeClaudeJson(data);
      toast(`✓ Saved "${slotName}"`);
      renderList();
    }
  }
}

// ─── Remove Agent ─────────────────────────────────────────────────────────────
async function removeAgentFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No agents to remove', true); return; }

  const target = await promptList({ title: 'Remove Agent',
    items: slots.map(s => {
      const model = ((servers[s].env || {}).CLAUDE_DEFAULT_MODEL || servers[s].command || '?').slice(0, 30);
      return { label: `${pad(s, 14)} ${model}`, value: s };
    }) });

  const confirm = await promptList({ title: `Remove "${target.value}"?`,
    items: [
      { label: 'Cancel (keep it)',                   value: 'cancel'  },
      { label: `⚠  Yes, delete "${target.value}"`,  value: 'confirm' },
    ] });

  if (confirm.value !== 'confirm') { toast('Cancelled'); return; }

  data.mcpServers = Object.fromEntries(Object.entries(servers).filter(([k]) => k !== target.value));
  writeClaudeJson(data);
  toast(`✓ Removed "${target.value}"`);
  renderList();
}

// ─── Reorder Agents ───────────────────────────────────────────────────────────
async function reorderFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No agents to reorder', true); return; }

  const target = await promptList({ title: 'Reorder — Pick slot to move',
    items: slots.map((s, i) => ({ label: `${String(i + 1).padStart(2)}.  ${s}`, value: s })) });

  const slotName  = target.value;
  const currentIdx = slots.indexOf(slotName);
  const posStr    = await promptInput({ title: `Move "${slotName}"`,
    prompt: `Move to position (1–${slots.length}):`, default: String(currentIdx + 1) });
  const newPos    = parseInt(posStr, 10);

  if (isNaN(newPos) || newPos < 1 || newPos > slots.length) {
    toast(`Position must be 1–${slots.length}`, true); return;
  }

  const entries = Object.entries(servers);
  const [entry] = entries.splice(currentIdx, 1);
  entries.splice(newPos - 1, 0, entry);
  data.mcpServers = Object.fromEntries(entries);
  writeClaudeJson(data);
  toast(`✓ Moved "${slotName}" to position ${newPos}`);
  renderList();
}

// ─── Check Agent Health (single slot) ────────────────────────────────────────
async function checkHealthSingle() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No agents configured', true); return; }

  let pdata;
  try { pdata = readProvidersJson(); } catch { pdata = { providers: [] }; }
  const providerMap = new Map((pdata.providers || []).map(p => [p.name, p]));
  const target = await promptList({ title: 'Check Health — Pick slot',
    items: slots.map(s => {
      const env = (servers[s].env || {});
      const meta = providerMap.get(s);
      const model = env.CLAUDE_DEFAULT_MODEL || (meta && meta.model) || '—';
      return { label: pad(s, 14) + ' ' + model, value: s };
    }) });

  const slotName = target.value;
  const env      = (servers[slotName].env || {});
  setContent('Agent Health', `{gray-fg}Probing ${slotName}…{/}`);

  const secrets = loadSecrets();
  const lines   = [`{bold}${slotName}{/bold}`, '─'.repeat(50)];

  const hMap = await probeAllSlots(servers, [slotName], secrets);
  const p    = hMap[slotName] || {};
  const status = p.healthy
    ? `{green-fg}✓ UP (${p.latencyMs}ms){/}`
    : p.healthy === null
      ? `{gray-fg}— not probed{/}`
      : `{red-fg}✗ DOWN [${p.error || 'timeout'}]{/}`;
  lines.push(`  Status:  ${status}`);

  // Show provider info from providers.json or MCP env
  const providerMeta = providerMap.get(slotName);
  const displayProvider = env.ANTHROPIC_BASE_URL
    || (providerMeta && providerMeta.display_provider)
    || 'subprocess';
  const displayModel = env.CLAUDE_DEFAULT_MODEL
    || (providerMeta && providerMeta.model)
    || '—';
  lines.push(`  Provider: ${displayProvider}`);
  lines.push(`  Model:   ${displayModel}`);
  if (p.type === 'subprocess' && providerMeta && providerMeta.cli) {
    lines.push(`  CLI:     ${providerMeta.cli}`);
  }
  setContent('Agent Health', lines.join('\n'));
}

// ─── Auth flow (driver-orchestrated — no CLI-specific logic in the TUI) ───────

async function authFlow(slotName, meta) {
  const { loadDriver } = require('./auth-drivers/index.cjs');
  const authCfg  = meta.auth;
  const loginCmd = authCfg?.login ?? [meta.cli, 'auth', 'login'];

  let driver;
  try { driver = loadDriver(authCfg?.type); }
  catch (err) { toast(err.message, true); return; }

  const addLabel = '+ Add account' + (loginCmd.length ? ' (' + loginCmd.join(' ') + ')' : '');

  // Loop so: after add/switch the list refreshes in place; Esc exits back to slot picker.
  while (true) {
    let accounts;
    try { accounts = driver.list(meta); }
    catch (err) { toast('Could not list accounts: ' + err.message, true); return; }

    const items = accounts.map(a => ({
      label: pad(a.name, 36) + (a.active ? ' {green-fg}(active){/}' : ''), value: a.name, isActive: a.active,
    }));
    items.push({ label: addLabel, value: '__add__', isActive: false });

    let picked;
    try { picked = await promptList({ title: 'Auth — ' + slotName, items }); }
    catch (_) { return; } // Esc → caller (slot-picker loop) re-shows slot list

    // ── Add account ─────────────────────────────────────────────────────────
    if (picked.value === '__add__') {
      const credFile = driver.addCredentialFile(meta);

      // Pool providers (Gemini, Codex): if the credential file already exists,
      // the CLI opens in interactive mode instead of triggering fresh OAuth.
      // Back it up first so the CLI sees no active session.
      let backupCredFile = null;
      if (credFile && fs.existsSync(credFile) && typeof driver.add === 'function') {
        // Auto-save current account to pool before displacing it (best-effort).
        const curName = typeof driver.extractAccountName === 'function'
          ? driver.extractAccountName(meta) : null;
        if (curName) {
          const alreadyInPool = driver.list(meta).some(a => a.name === curName);
          if (!alreadyInPool) {
            try { await driver.add(meta, curName); } catch (_) {}
          }
        }
        // Move active creds aside so CLI triggers fresh OAuth.
        backupCredFile = credFile + '.auth-in-progress';
        try { fs.renameSync(credFile, backupCredFile); }
        catch (_) { backupCredFile = null; }
      }

      try { await promptLoginExternal('Add Account — ' + slotName, loginCmd, credFile); }
      catch (_) {
        // Cancelled — restore the backed-up credentials so the active account still works.
        if (backupCredFile && fs.existsSync(backupCredFile)) {
          try { fs.renameSync(backupCredFile, credFile); } catch (_) {}
        }
        continue; // Esc from spinner → back to account list
      }

      // Login succeeded — old creds are already in the pool; discard backup.
      if (backupCredFile && fs.existsSync(backupCredFile)) {
        try { fs.unlinkSync(backupCredFile); } catch (_) {}
      }

      // Drivers that manage accounts internally (gh-cli) need no capture step
      if (typeof driver.add === 'function' && credFile !== null) {
        let name = driver.extractAccountName(meta);
        if (!name) {
          try { name = await promptInput({ title: 'Add Account — ' + slotName, prompt: 'Account name / alias:' }); }
          catch (_) { continue; } // Esc from name prompt → back to account list
          if (!name) { toast('Name required', true); continue; }
        }
        try {
          await driver.add(meta, name);
          toast('Account "' + name + '" added to pool');
          renderList();
        } catch (err) {
          toast('Add failed: ' + err.message, true);
        }
      } else {
        toast('Signed in — account will appear on next refresh');
      }
      continue; // refresh account list
    }

    // ── Switch account ───────────────────────────────────────────────────────
    if (picked.isActive) { toast(picked.value + ' is already active'); continue; }

    try {
      driver.switch(meta, picked.value);
      toast('Switched ' + slotName + ' → ' + picked.value);
      renderList();
    } catch (err) {
      toast('Switch failed: ' + err.message, true);
    }
    continue; // refresh account list to show updated active state
  }
}

// ─── Login / Auth ─────────────────────────────────────────────────────────────
async function loginAgentFlow() {
  const { loadDriver } = require('./auth-drivers/index.cjs');

  // Loop so: Esc from account list re-shows slot picker; Esc from slot picker exits.
  while (true) {
    const pdata      = readProvidersJson();
    const metaByName = Object.fromEntries((pdata.providers || []).map(p => [p.name, p]));

    const rows  = agentRows();
    const items = rows.map(r => {
      const meta    = metaByName[r.name] || {};
      const authCfg = meta.auth;
      let driverAvailable = false;
      try { if (authCfg?.type) { loadDriver(authCfg.type); driverAvailable = true; } } catch (_) {}
      const hasPool = !!meta.oauth_rotation?.enabled;
      const label   = pad(r.name, 16) + ' ' +
        (authCfg ? authCfg.type : '{gray-fg}(no auth){/}') +
        (hasPool ? ' · pool' : '') +
        (!driverAvailable && authCfg ? ' {red-fg}(no driver){/}' : '');
      return { label, value: r.name, meta, driverAvailable };
    });

    let picked;
    try { picked = await promptList({ title: 'Login / Auth — Pick slot', items }); }
    catch (_) { return; } // Esc → back to main menu

    if (!picked.meta.auth) { toast('No auth configured for this slot', true); continue; }
    if (!picked.driverAvailable) { toast('No driver for type "' + picked.meta.auth.type + '"', true); continue; }

    await authFlow(picked.value, picked.meta);
    // authFlow returned (user pressed Esc from account list) → loop back to slot picker
  }
}

// ─── Provider Keys ────────────────────────────────────────────────────────────
async function renderProviderKeys() {
  const secrets = loadSecrets();
  if (!secrets) { setContent('Provider Keys', '{red-fg}secrets.cjs not found — nForma not installed.{/}'); return; }
  const lines = ['{bold}Provider Keys{/bold}', '─'.repeat(40)];
  for (const { key, label } of PROVIDER_KEY_NAMES) {
    const display = secrets.hasKey(key) ? '{green-fg}✓ set{/}' : '{gray-fg}(not set){/}';
    lines.push(`  ${pad(label, 22)} ${display}`);
  }
  lines.push('', '{gray-fg}Use Provider Keys → Set to update a key.{/}');
  setContent('Provider Keys', lines.join('\n'));
}

async function providerKeysFlow() {
  setContent('Provider Keys', '{gray-fg}Select an action…{/}');
  const secrets = loadSecrets();
  if (!secrets) { toast('secrets.cjs not found — nForma not installed', true); return; }

  while (true) {                                                // action loop: ESC → main menu
    let action;
    try {
      action = await promptList({ title: 'Provider Keys',
        items: [
          { label: 'View stored keys',   value: 'view'   },
          { label: 'Set / update a key', value: 'set'    },
          { label: 'Remove a key',       value: 'remove' },
        ] });
    } catch (_) { return; }                                     // ESC → main menu

    if (action.value === 'view') { await renderProviderKeys(); continue; }

    while (true) {                                              // key loop: ESC → action picker
      let picked;
      try {
        picked = await promptList({
          title: action.value === 'set' ? 'Set which key?' : 'Remove which key?',
          items: PROVIDER_KEY_NAMES.map(k => ({ label: k.label, value: k.key })),
        });
      } catch (_) { break; }                                    // ESC → back to action picker

      try {
        if (action.value === 'remove') {
          await secrets.delete('nforma', picked.value);
          toast(`Removed ${picked.label}`);
          await renderProviderKeys();
          continue;                                             // re-show key picker (remove more)
        }

        const val = await promptInput({ title: `Set ${picked.label}`, prompt: `Value for ${picked.value}:`, isPassword: true });
        if (!val) { toast('Empty value — key not stored', true); continue; }
        await secrets.set('nforma', picked.value, val);
        toast(`${picked.label} saved`);
        await renderProviderKeys();
      } catch (_) { continue; }                                // ESC during value input → re-show key picker
    }
  }
}

// ─── Post-Rotation Validation (CRED-01: fire-and-forget, non-blocking) ───────
/**
 * Fire-and-forget post-rotation validation.
 * Probes each rotated slot and persists key_status to nf.json.
 * Does NOT block the caller -- called with .catch(() => {}).
 * Uses sequential for...of (same pattern as rotation loop).
 * Reuses probeAndPersistKey from manage-agents-core.cjs (DRY -- do not duplicate probe/classify/write logic).
 */
async function validateRotatedKeys(rotatedSlots) {
  const data = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const secretsLib = loadSecrets();
  for (const slotName of rotatedSlots) {
    const cfg = servers[slotName] || {};
    const env = cfg.env || {};
    if (!env.ANTHROPIC_BASE_URL) continue;
    let apiKey = env.ANTHROPIC_API_KEY || '';
    // Read the key from secrets store if available
    if (secretsLib) {
      try {
        const account = deriveSecretAccount(slotName);
        const k = await secretsLib.get('nforma', account);
        if (k) apiKey = k;
      } catch (_) {}
    }
    await probeAndPersistKey(slotName, env.ANTHROPIC_BASE_URL, apiKey);
  }
}

// ─── Batch Rotate Keys ────────────────────────────────────────────────────────
async function batchRotateFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No agents configured', true); return; }

  const secrets = loadSecrets();
  setContent('Batch Rotate Keys', '{gray-fg}Select slots to rotate (one at a time, pick Done when finished)…{/}');

  const remaining = [...slots];
  const rotated   = [];

  while (remaining.length) {
    const items = [
      ...remaining.map(s => {
        const account = deriveSecretAccount(s);
        const hasKey  = (secrets && secrets.hasKey(account)) || !!(servers[s].env || {}).ANTHROPIC_API_KEY;
        return { label: `${pad(s, 14)} ${hasKey ? '[key set]' : '[no key]'}`, value: s };
      }),
      { label: '─── Done', value: '__done__' },
    ];

    let picked;
    try { picked = await promptList({ title: 'Batch Rotate — Pick slot', items }); }
    catch (_) { break; }                                        // ESC → exit loop, show summary
    if (picked.value === '__done__') break;

    let newKey;
    try {
      newKey = await promptInput({
        title: `Rotate key for "${picked.value}"`,
        prompt: `New API key for ${picked.value}:`,
        isPassword: true,
      });
    } catch (_) { continue; }                                   // ESC → skip slot, re-show picker
    if (!newKey) { toast('Empty value — skipped', true); continue; }

    const account = deriveSecretAccount(picked.value);
    if (secrets) {
      await secrets.set('nforma', account, newKey);
    } else {
      if (!servers[picked.value].env) servers[picked.value].env = {};
      servers[picked.value].env.ANTHROPIC_API_KEY = newKey;
    }

    rotated.push(picked.value);
    remaining.splice(remaining.indexOf(picked.value), 1);
  }

  if (rotated.length) {
    if (!secrets) writeClaudeJson(data);
    toast(`✓ ${rotated.length} slot(s) rotated`);
    // Fire-and-forget validation (CRED-01: does not block quorum dispatch)
    validateRotatedKeys(rotated).catch(() => {});
  } else {
    toast('No keys rotated');
  }
  renderList();
}

// ─── Live Health ──────────────────────────────────────────────────────────────
let healthInterval = null;
async function renderHealth() {
  setContent('Live Health', '{gray-fg}Probing slots…{/}');
  try {
    const data      = readClaudeJson();
    const servers   = getGlobalMcpServers(data);
    const slots     = Object.keys(servers);
    const healthMap = await probeAllSlots(servers, slots, loadSecrets());
    const lines     = buildDashboardLines(slots, servers, healthMap, Date.now());
    setContent('Live Health', lines.join('\n'));
  } catch (err) {
    setContent('Live Health', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Scoreboard ──────────────────────────────────────────────────────────────

/**
 * Build formatted scoreboard lines from parsed quorum-scoreboard.json data.
 * Pure function — returns blessed-tagged string[].
 * @param {object} data   Parsed quorum-scoreboard.json
 * @param {object} [opts]
 * @param {string} [opts.orchestrator='claude']  Model key of the orchestrator (excluded from voter ranking)
 */
function buildScoreboardLines(data, opts) {
  if (!data || !data.models) return ['{gray-fg}No scoreboard data found.{/}'];

  const orchestrator = (opts && opts.orchestrator) || 'claude';
  const roster = (opts && opts.roster) || null;   // Set<string> of current slot names, or null = show all

  // Build provider info lookup: slot name → { cli, model }
  const providerMap = new Map();
  if (opts && opts.providers) {
    for (const p of opts.providers) {
      if (!p || typeof p !== 'object') continue;
      const cli   = (p.cli || '').split('/').pop() || '\u2014';
      const model = (p.model || '').split('/').pop() || '\u2014';
      providerMap.set(p.name, { cli, model });
    }
  }

  // Guard for empty providers
  if (opts && opts.providers && opts.providers.length === 0) {
    const lines = [];
    lines.push('{bold}  Quorum Scoreboard{/bold}');
    lines.push('  {gray-fg}No agents configured in providers.json.{/}');
    lines.push('  {gray-fg}Run /nf:mcp-setup to add agents.{/}');
    lines.push('');
    return lines;
  }

  const W = { slot: 10, cli: 8, model: 16, score: 5, inv: 4, norm: 6, tp: 3, tn: 3, fp: 3, fn: 3, impr: 4 };
  const SEP_W = 85;
  const lines = [];

  lines.push('{bold}  Quorum Scoreboard{/bold}');
  lines.push('  ' + '\u2500'.repeat(SEP_W));
  lines.push('');

  // Header
  const hdr =
    '  ' +
    pad('Slot', W.slot) + '  ' +
    pad('CLI', W.cli) + '  ' +
    pad('Model', W.model) + '  ' +
    'Score'.padStart(W.score) + '  ' +
    'Inv'.padStart(W.inv) + '  ' +
    'Norm'.padStart(W.norm) + '  ' +
    'TP'.padStart(W.tp) + '  ' +
    'TN'.padStart(W.tn) + '  ' +
    'FP'.padStart(W.fp) + '  ' +
    'FN'.padStart(W.fn) + '  ' +
    'Impr'.padStart(W.impr);
  lines.push('{bold}' + hdr + '{/bold}');
  lines.push('  ' + '\u2500'.repeat(SEP_W));

  // Format a single row
  function fmtRow(e) {
    const normStr = e.norm.toFixed(2);
    const normColor = e.norm >= 1.2 ? 'green' : e.norm >= 1.0 ? '#4a9090' : e.norm >= 0 ? 'yellow' : 'red';
    return (
      '  ' +
      pad(e.name, W.slot) + '  ' +
      pad(e.cli, W.cli) + '  ' +
      pad(e.model, W.model) + '  ' +
      String(e.score).padStart(W.score) + '  ' +
      String(e.inv).padStart(W.inv) + '  ' +
      `{${normColor}-fg}${normStr.padStart(W.norm)}{/}` + '  ' +
      String(e.tp).padStart(W.tp) + '  ' +
      String(e.tn).padStart(W.tn) + '  ' +
      (e.fp > 0 ? `{red-fg}${String(e.fp).padStart(W.fp)}{/}` : String(e.fp).padStart(W.fp)) + '  ' +
      (e.fn > 0 ? `{yellow-fg}${String(e.fn).padStart(W.fn)}{/}` : String(e.fn).padStart(W.fn)) + '  ' +
      (e.impr > 0 ? `{green-fg}${String(e.impr).padStart(W.impr)}{/}` : String(e.impr).padStart(W.impr))
    );
  }

  function toEntry(name, cli, model, m) {
    const s = m || {};
    const inv = s.invocations || 0;
    return {
      name, cli, model,
      score: s.score || 0, inv,
      norm: inv > 0 ? (s.score || 0) / inv : 0,
      tp: s.tp || 0, tn: s.tn || 0, fp: s.fp || 0, fn: s.fn || 0,
      impr: s.impr || 0,
    };
  }

  // When providers are available, do exact composite-key lookups so scores
  // match the specific slot+model combination currently configured.
  // Without providers, fall back to slot-name aggregation (legacy mode).
  const entries = [];
  const dormant = [];

  if (opts && opts.providers) {
    const slots = data.slots || {};
    const ZERO = { score: 0, invocations: 0, tp: 0, tn: 0, fp: 0, fn: 0, impr: 0 };

    for (const p of opts.providers) {
      if (!p || typeof p !== 'object') continue;
      if (p.name === orchestrator) continue;
      const cli      = (p.cli || '').split('/').pop() || '\u2014';
      const modelKey = p.model || '';
      const shortMdl = modelKey.split('/').pop() || '\u2014';

      // Exact slot match for the current model
      const compositeKey = p.name + ':' + modelKey;
      const slotStats = slots[compositeKey] || ZERO;

      // For primary (-1) slots, add legacy model-family data.
      // Rounds used model-family keys (e.g. "copilot") before switching to
      // composite keys (e.g. "copilot-1:gpt-4.1"), so the two are non-overlapping.
      const familyName = p.name.replace(/-\d+$/, '');
      const modelStats = (p.name.endsWith('-1') && familyName !== orchestrator)
        ? (data.models[familyName] || ZERO)
        : ZERO;

      const merged = {
        score:       (slotStats.score || 0) + (modelStats.score || 0),
        invocations: (slotStats.invocations || 0) + (modelStats.invocations || 0),
        tp:   (slotStats.tp || 0)   + (modelStats.tp || 0),
        tn:   (slotStats.tn || 0)   + (modelStats.tn || 0),
        fp:   (slotStats.fp || 0)   + (modelStats.fp || 0),
        fn:   (slotStats.fn || 0)   + (modelStats.fn || 0),
        impr: (slotStats.impr || 0) + (modelStats.impr || 0),
      };

      const e = toEntry(p.name, cli, shortMdl, merged);
      if (e.inv > 0) { entries.push(e); } else { dormant.push(p.name); }
    }
  } else {
    // Legacy fallback: aggregate by slot name (no exact model matching)
    const agentMap = new Map();
    function mergeInto(name, stats) {
      const prev = agentMap.get(name) || { score: 0, invocations: 0, tp: 0, tn: 0, fp: 0, fn: 0, impr: 0 };
      prev.score       += stats.score       || 0;
      prev.invocations += stats.invocations || 0;
      prev.tp   += stats.tp   || 0;
      prev.tn   += stats.tn   || 0;
      prev.fp   += stats.fp   || 0;
      prev.fn   += stats.fn   || 0;
      prev.impr += stats.impr || 0;
      agentMap.set(name, prev);
    }
    for (const [name, m] of Object.entries(data.models)) {
      if (name === orchestrator) continue;
      if (roster && !roster.has(name)) continue;
      mergeInto(name, m);
    }
    if (data.slots) {
      for (const s of Object.values(data.slots)) {
        const slotName = s.slot || '?';
        if (roster && !roster.has(slotName)) continue;
        mergeInto(slotName, s);
      }
    }
    for (const [name, m] of agentMap) {
      const e = toEntry(name, '\u2014', '\u2014', m);
      if (e.inv > 0) { entries.push(e); } else { dormant.push(name); }
    }
  }

  entries.sort((a, b) => b.norm - a.norm || b.score - a.score);

  for (const e of entries) {
    lines.push(fmtRow(e));
  }

  if (dormant.length > 0) {
    lines.push('');
    lines.push(`  {gray-fg}Dormant: ${dormant.join(', ')}{/}`);
  }

  // Delivery stats
  if (data.delivery_stats && data.delivery_stats.total_rounds > 0) {
    const ds = data.delivery_stats;
    lines.push('');
    lines.push('  ' + '\u2500'.repeat(SEP_W));
    lines.push(`  Total rounds: {bold}${ds.total_rounds}{/bold}   Target votes: ${ds.target_vote_count || 3}`);

    const outcomes = Object.entries(ds.achieved_by_outcome || {})
      .sort(([a], [b]) => b.localeCompare(a)); // descending vote count
    for (const [key, val] of outcomes) {
      const label = key.replace('_', ' ');
      lines.push(`    ${label}: ${val.count} (${val.pct}%)`);
    }
  }

  lines.push('');
  lines.push('  {gray-fg}Norm = score \u00F7 invocations   |   [q/Esc] back{/}');

  return lines;
}

function renderScoreboard() {
  try {
    let sbPath;
    try {
      const pp = require('./planning-paths.cjs');
      sbPath = pp.resolveWithFallback(getTargetPath(), 'quorum-scoreboard');
    } catch (_) {
      sbPath = path.resolve(getTargetPath(), path.join('.planning', 'quorum-scoreboard.json'));
    }
    if (!fs.existsSync(sbPath)) {
      setContent('Scoreboard', '{gray-fg}No scoreboard found{/}');
      return;
    }
    const data  = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
    const pdata = readProvidersJson();
    const providersList = pdata.providers || [];
    const roster = new Set(providersList.map(p => p.name));
    const lines = buildScoreboardLines(data, { roster, providers: providersList });
    setContent('Scoreboard', lines.join('\n'));
  } catch (err) {
    setContent('Scoreboard', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Update Agents ────────────────────────────────────────────────────────────
async function updateAgentsFlow() {
  setContent('Update Agents', '{gray-fg}Checking update status…{/}');

  let statuses;
  try {
    statuses = await getUpdateStatuses();
  } catch (err) {
    setContent('Update Agents', `{red-fg}Error: ${err.message}{/}`);
    return;
  }

  // Build CLI metadata map for running updates
  const CLI_META = {
    codex:    { installType: 'npm-global',   pkg: '@openai/codex'      },
    gemini:   { installType: 'npm-global',   pkg: '@google/gemini-cli' },
    opencode: { installType: 'npm-global',   pkg: 'opencode'           },
    copilot:  { installType: 'gh-extension', ext: 'github/gh-copilot'  },
    ccr:      { installType: 'npm-global',   pkg: 'claude-code-router'  },
    antigravity: { installType: 'curl-script', bin: 'agy', installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
  };

  const lines = ['{bold}Update Status{/bold}', '─'.repeat(50)];
  const outdated = [];
  for (const [name, info] of statuses) {
    const badge = info.status === 'up-to-date'
      ? '{green-fg}✓ up to date{/}'
      : info.status === 'update-available'
        ? `{yellow-fg}↑ ${info.current || '?'} → ${info.latest || '?'}{/}`
        : '{gray-fg}— unknown{/}';
    lines.push(`  ${pad(name, 14)} ${badge}`);
    if (info.status === 'update-available' && CLI_META[name]) {
      outdated.push({ name, meta: CLI_META[name], latest: info.latest });
    }
  }
  if (!statuses.size) lines.push('  {gray-fg}No managed agents detected.{/}');

  if (outdated.length === 0) {
    lines.push('', '{green-fg}All agents are up to date.{/}');
    setContent('Update Agents', lines.join('\n'));
    return;
  }

  lines.push('');
  setContent('Update Agents', lines.join('\n'));

  // Choice loop: ESC at top level → main menu; ESC at checkbox → back to choice
  let toUpdate;
  while (true) {
    let choice;
    try {
      choice = await promptList({
        title: 'Apply Updates',
        items: [
          { label: `Update all (${outdated.length})`, value: 'all'    },
          { label: 'Select individual',               value: 'select'  },
          { label: 'Skip',                            value: 'skip'    },
        ],
      });
    } catch (_) { return; }                                     // ESC → main menu

    if (choice.value === 'skip') { toast('Skipped.'); return; }

    if (choice.value === 'all') { toUpdate = outdated; break; }

    // 'select' — checkbox; ESC → re-show choice list
    try {
      const picked = await promptCheckbox({
        title: 'Select agents to update',
        items: outdated.map(r => ({
          label: `${r.name}  (→ ${r.latest || '?'})`,
          value: r.name,
        })),
      });
      toUpdate = outdated.filter(r => picked.includes(r.name));
    } catch (_) { continue; }                                   // ESC → re-show choice list
    if (!toUpdate.length) { toast('Nothing selected.'); continue; }
    break;
  }

  // Run updates — capture output, display in contentBox
  const results = [];
  for (const { name, meta } of toUpdate) {
    setContent('Update Agents', `{gray-fg}Updating ${name}…{/}`);
    let cmd, args;
    if (meta.installType === 'npm-global') {
      cmd = 'npm'; args = ['install', '-g', `${meta.pkg}@latest`];
    } else {
      cmd = 'gh'; args = ['extension', 'upgrade', 'copilot'];
    }
    const res = spawnSync(cmd, args, {
      encoding: 'utf8', timeout: 60000,
    });
    const ok = res.status === 0;
    results.push(ok
      ? `{green-fg}✓ ${name} updated{/}`
      : `{red-fg}✗ ${name} failed (exit ${res.status}){/}\n  ${(res.stderr || '').slice(0, 200)}`
    );
  }

  // Refresh badge after updates
  try {
    const fresh = await getUpdateStatuses();
    const remaining = [...fresh.values()].filter(s => s.status === 'update-available').length;
    applyUpdateBadge(remaining);
  } catch (_) {}

  setContent('Update Agents', ['{bold}Update Results{/bold}', '─'.repeat(50), ...results].join('\n'));
}

// ─── Settings helpers ─────────────────────────────────────────────────────────
const AGENT_TIERS = {
  'nf-planner':          { quality: 'opus',   balanced: 'opus',   budget: 'sonnet' },
  'nf-executor':         { quality: 'opus',   balanced: 'sonnet', budget: 'sonnet' },
  'nf-phase-researcher': { quality: 'opus',   balanced: 'sonnet', budget: 'haiku'  },
  'nf-verifier':         { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku'  },
  'nf-codebase-mapper':  { quality: 'sonnet', balanced: 'haiku',  budget: 'haiku'  },
};
const AGENT_LABELS = {
  'nf-planner':          'Planner',
  'nf-executor':         'Executor',
  'nf-phase-researcher': 'Researcher',
  'nf-verifier':         'Verifier',
  'nf-codebase-mapper':  'Mapper',
};

function readProjectConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(getTargetPath(), '.planning', 'config.json'), 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  }
  catch (_) { return {}; }
}
function writeProjectConfig(cfg) {
  const p = path.join(getTargetPath(), '.planning', 'config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function settingsFlow() {
  while (true) {
    const cfg     = readProjectConfig();
    const nfCfg    = readNfJson();
    const profile = cfg.model_profile || 'balanced';
    const defN    = nfCfg.quorum?.maxSize ?? 3;
    const byProf  = nfCfg.quorum?.maxSizeByProfile || {};
    const effN    = byProf[profile] ?? defN;
    const nStr    = String(effN) + (byProf[profile] != null ? '*' : '');
    const ovCount = Object.keys(cfg.model_overrides || {}).length;

    let picked;
    try {
      picked = await promptList({ title: 'Settings', items: [
        { label: `  Profile          ${profile}`,              value: 'profile'   },
        { label: `  Quorum n         ${nStr}  →`,              value: 'n'         },
        { label: `  Fail mode        ${nfCfg.fail_mode || '—'}`,value: 'fail'      },
        { label: `  Model overrides  ${ovCount ? `${ovCount} active` : 'none'}  →`, value: 'overrides' },
      ]});
    } catch (_) { return; }

    if (picked.value === 'profile') {
      let choice;
      try {
        choice = await promptList({ title: 'Settings — Profile', items: [
          { label: 'quality   Opus for all decision-making',            value: 'quality'  },
          { label: 'balanced  Opus planner · Sonnet workers (default)', value: 'balanced' },
          { label: 'budget    Sonnet workers · Haiku checkers',         value: 'budget'   },
        ]});
      } catch (_) { continue; }
      const c = readProjectConfig();
      c.model_profile = choice.value;
      writeProjectConfig(c);
      refreshSettingsPane();
      toast(`✓ Profile → ${choice.value}`);

    } else if (picked.value === 'n') {
      await quorumNFlow();
      refreshSettingsPane();

    } else if (picked.value === 'fail') {
      let choice;
      try {
        choice = await promptList({ title: 'Settings — Fail Mode', items: [
          { label: 'lenient  Continue with partial quorum (default)', value: 'lenient' },
          { label: 'strict   Block if any required slot fails',       value: 'strict'  },
        ]});
      } catch (_) { continue; }
      const qg = readNfJson();
      qg.fail_mode = choice.value;
      writeNfJson(qg);
      refreshSettingsPane();
      toast(`✓ Fail mode → ${choice.value}`);

    } else if (picked.value === 'overrides') {
      await modelOverridesFlow();
      refreshSettingsPane();
    }
  }
}

async function modelOverridesFlow() {
  while (true) {
    const cfg      = readProjectConfig();
    const profile  = cfg.model_profile || 'balanced';
    const overrides = cfg.model_overrides || {};
    const items = Object.keys(AGENT_TIERS).map(key => {
      const def = AGENT_TIERS[key][profile];
      const ov  = overrides[key];
      const tag = ov
        ? `{#4a9090-fg}${ov}{/}  {#3d3d3d-fg}(override){/}`
        : `${def}  {#3d3d3d-fg}(${profile} default){/}`;
      return { label: `  ${pad(AGENT_LABELS[key], 14)} ${tag}`, value: key };
    });

    let picked;
    try { picked = await promptList({ title: 'Model Overrides', items }); }
    catch (_) { return; }

    const cfg2    = readProjectConfig();
    const prof2   = cfg2.model_profile || 'balanced';
    const defTier = AGENT_TIERS[picked.value][prof2];
    let choice;
    try {
      choice = await promptList({ title: `Override — ${AGENT_LABELS[picked.value]}`, items: [
        { label: `opus    ${defTier === 'opus'   ? '← profile default' : ''}`, value: 'opus'      },
        { label: `sonnet  ${defTier === 'sonnet' ? '← profile default' : ''}`, value: 'sonnet'    },
        { label: `haiku   ${defTier === 'haiku'  ? '← profile default' : ''}`, value: 'haiku'     },
        { label: `reset   use profile default (${defTier})`,                   value: '__reset__' },
      ]});
    } catch (_) { continue; }

    const c = readProjectConfig();
    if (!c.model_overrides) c.model_overrides = {};
    if (choice.value === '__reset__') {
      delete c.model_overrides[picked.value];
      if (!Object.keys(c.model_overrides).length) delete c.model_overrides;
    } else {
      c.model_overrides[picked.value] = choice.value;
    }
    writeProjectConfig(c);
    refreshSettingsPane();
    const msg = choice.value === '__reset__'
      ? `${AGENT_LABELS[picked.value]} reset to profile default (${defTier})`
      : `${AGENT_LABELS[picked.value]} → ${choice.value}`;
    toast(`✓ ${msg}`);
  }
}

async function quorumNFlow() {
  while (true) {
    const nfCfg   = readNfJson();
    const defN   = nfCfg.quorum?.maxSize ?? 3;
    const byProf = nfCfg.quorum?.maxSizeByProfile || {};
    const fmt    = p => byProf[p] != null ? String(byProf[p]) : `${defN} (default)`;

    let picked;
    try {
      picked = await promptList({ title: 'Quorum n', items: [
        { label: `  Default   n=${defN}  (used when no per-profile override)`, value: 'default'  },
        { label: `  Quality   n=${fmt('quality')}`,                             value: 'quality'  },
        { label: `  Balanced  n=${fmt('balanced')}`,                            value: 'balanced' },
        { label: `  Budget    n=${fmt('budget')}`,                              value: 'budget'   },
      ]});
    } catch (_) { return; }

    const current = picked.value === 'default' ? defN : (byProf[picked.value] ?? defN);
    let val;
    try {
      val = await promptInput({
        title:   `Quorum n — ${picked.value}`,
        prompt:  `n  (0 = remove per-profile override, blank = keep current):`,
        default: String(current),
      });
    } catch (_) { continue; }

    if (!val || val.trim() === '' || val.trim() === String(current)) continue;
    const n = parseInt(val.trim(), 10);
    if (isNaN(n) || n < 0) { toast('Invalid — enter a positive number or 0 to remove', true); continue; }

    if (!nfCfg.quorum) nfCfg.quorum = {};
    if (picked.value === 'default') {
      nfCfg.quorum.maxSize = n;
    } else {
      if (!nfCfg.quorum.maxSizeByProfile) nfCfg.quorum.maxSizeByProfile = {};
      if (n === 0) {
        delete nfCfg.quorum.maxSizeByProfile[picked.value];
        if (!Object.keys(nfCfg.quorum.maxSizeByProfile).length) delete nfCfg.quorum.maxSizeByProfile;
      } else {
        nfCfg.quorum.maxSizeByProfile[picked.value] = n;
      }
    }
    writeNfJson(nfCfg);
    renderHeader();
    refreshSettingsPane();
    toast(`✓ Quorum n (${picked.value}) → ${n === 0 ? 'reset to default' : n}`);
  }
}

// ─── Tune Timeouts ────────────────────────────────────────────────────────────
async function tuneTimeoutsFlow() {
  const data     = readClaudeJson();
  const servers  = getGlobalMcpServers(data);
  const slots    = Object.keys(servers);
  if (!slots.length) { toast('No slots configured', true); return; }

  let providersData;
  try { providersData = readProvidersJson(); } catch { providersData = { providers: [] }; }

  const rows    = buildTimeoutChoices(slots, servers, providersData);
  let changed   = false;

  for (const { slotName, providerSlot, currentMs } of rows) {
    let val;
    try {
      val = await promptInput({
        title:   `Tune Timeout — ${slotName}`,
        prompt:  `Current: ${currentMs != null ? currentMs + ' ms' : '—'}   New timeout (ms, blank = keep):`,
        default: currentMs != null ? String(currentMs) : '',
      });
    } catch (_) { continue; }                                   // ESC → skip slot, move to next
    const trimmed = (val || '').trim();
    if (trimmed) {
      const result = validateTimeout(trimmed);
      if (!result.valid) {
        toast(result.error, true);
        continue;
      }
      if (result.ms !== null && result.ms !== currentMs) {
        const updated = applyTimeoutUpdate(providersData, providerSlot, result.ms);
        Object.assign(providersData, updated);
        changed = true;
      }
    }
  }

  if (changed) {
    writeProvidersJson(providersData);
    toast('Timeouts saved — restart Claude Code to apply');
  } else {
    toast('No changes made');
  }
}

// ─── Set Update Policy ────────────────────────────────────────────────────────
async function updatePolicyFlow() {
  const data    = readClaudeJson();
  const servers = getGlobalMcpServers(data);
  const slots   = Object.keys(servers);
  if (!slots.length) { toast('No slots configured', true); return; }

  const nfCfg        = readNfJson();
  const agentConfig = nfCfg.agent_config || {};

  const target = await promptList({ title: 'Update Policy — Pick slot',
    items: slots.map(s => ({
      label: `${pad(s, 14)} policy: ${(agentConfig[s] || {}).update_policy || '—'}`,
      value: s,
    })) });

  const currentPolicy = (agentConfig[target.value] || {}).update_policy || null;
  const policy = await promptList({ title: `Update Policy — ${target.value}`,
    items: buildPolicyChoices(currentPolicy).map(c => ({ label: c.name, value: c.value })) });

  writeUpdatePolicy(target.value, policy.value);
  toast(`✓ ${target.value}: update_policy = ${policy.value}`);
}

// ─── Export Roster ────────────────────────────────────────────────────────────
async function exportFlow() {
  const filePath = await promptInput({ title: 'Export Roster',
    prompt: 'Export file path (e.g. ~/Desktop/roster-backup.json):' });
  if (!filePath) { toast('Path is required', true); return; }

  const resolved = filePath.replace(/^~/, os.homedir());
  const rawData  = readClaudeJson();
  const exported = buildExportData(rawData);
  fs.writeFileSync(resolved, JSON.stringify(exported, null, 2), 'utf8');
  setContent('Export Roster', `{green-fg}✓ Exported to:{/}\n  ${resolved}\n\n{gray-fg}All API key values have been replaced with __redacted__{/}`);
}

// ─── Import Roster ────────────────────────────────────────────────────────────
async function importFlow() {
  const filePath = await promptInput({ title: 'Import Roster', prompt: 'Import file path:' });
  if (!filePath) { toast('Path is required', true); return; }

  const resolved = filePath.replace(/^~/, os.homedir());
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    toast(`Error reading file: ${err.message}`, true); return;
  }

  const errors = validateImportSchema(parsed);
  if (errors.length) {
    setContent('Import Roster', `{red-fg}Validation failed:{/}\n` + errors.map(e => `  - ${e}`).join('\n'));
    return;
  }

  const ts         = new Date().toISOString().replace(/:/g, '-');
  const backupPath = buildBackupPath(CLAUDE_JSON_PATH, ts);
  try { fs.copyFileSync(CLAUDE_JSON_PATH, backupPath); } catch (err) {
    toast(`Backup failed — import aborted: ${err.message}`, true); return;
  }

  // Re-prompt __redacted__ keys
  const secrets = loadSecrets();
  for (const [slotName, cfg] of Object.entries(parsed.mcpServers || {})) {
    if (!cfg.env) continue;
    for (const [envKey, envVal] of Object.entries(cfg.env)) {
      if (envVal === '__redacted__') {
        let val;
        try {
          val = await promptInput({ title: `Import — ${slotName}`,
            prompt: `API key for ${slotName} / ${envKey} (blank = skip):`, isPassword: true });
        } catch (_) { delete cfg.env[envKey]; continue; }       // ESC → skip key, move to next
        if (val) {
          if (secrets) { await secrets.set('nforma', deriveSecretAccount(slotName), val); delete cfg.env[envKey]; }
          else          { cfg.env[envKey] = val; }
        } else {
          delete cfg.env[envKey];
        }
      }
    }
  }

  writeClaudeJson(parsed);
  const slotCount = Object.keys(parsed.mcpServers || {}).length;
  setContent('Import Roster', `{green-fg}✓ Import complete: ${slotCount} server(s) applied.{/}\n  Backup at: ${backupPath}`);
  renderList();
}

// ─── Action dispatcher ────────────────────────────────────────────────────────
async function dispatch(action) {
  if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }
  if (action === 'sep')  return;
  if (action === 'exit') { screen.destroy(); process.exit(0); }

  try {
    if      (action === 'list')          renderList();
    else if (action === 'add')           await addAgentFlow();
    else if (action === 'clone')         await cloneSlotFlow();
    else if (action === 'edit')          await editAgentFlow();
    else if (action === 'remove')        await removeAgentFlow();
    else if (action === 'reorder')       await reorderFlow();
    else if (action === 'health-single') await checkHealthSingle();
    else if (action === 'login')         await loginAgentFlow();
    else if (action === 'provider-keys') await providerKeysFlow();
    else if (action === 'batch-rotate')  await batchRotateFlow();
    else if (action === 'health') {
      await renderHealth();
      healthInterval = setInterval(renderHealth, 10_000);
    }
    else if (action === 'scoreboard')     renderScoreboard();
    else if (action === 'update-agents') await updateAgentsFlow();
    else if (action === 'settings-view') {
      _showingSettings = true;
      setContent('Settings', buildSettingsPaneContent());
    }
    else if (action === 'settings') {
      _showingSettings = true;
      setContent('Settings', buildSettingsPaneContent());
      await settingsFlow();
      _showingSettings = false;
    }
    else if (action === 'tune-timeouts') await tuneTimeoutsFlow();
    else if (action === 'update-policy') await updatePolicyFlow();
    else if (action === 'export')        await exportFlow();
    else if (action === 'import')        await importFlow();
    else if (action === 'req-browse')       await reqBrowseFlow();
    else if (action === 'req-coverage')     renderReqCoverage();
    else if (action === 'req-traceability') await reqTraceabilityFlow();
    else if (action === 'req-aggregate')    await reqAggregateFlow();
    else if (action === 'req-gaps')         reqCoverageGapsFlow();
    else if (action === 'req-gate-scoring') gateScoreFlow();
    else if (action === 'session-new')  await newSessionFlow();
    else if (action === 'session-kill') await killSessionFlow();
    else if (action.startsWith('session-resume-')) {
      const csid = action.replace('session-resume-', '');
      const persisted = loadPersistedSessions().find(p => p.claudeSessionId === csid);
      if (persisted) {
        createSession(persisted.name, persisted.cwd, persisted.claudeSessionId);
      }
    }
    else if (action.startsWith('session-connect-')) {
      connectSession(parseInt(action.replace('session-connect-', ''), 10));
    }
    else if (action === 'solve-browse')       await solveBrowseFlow();
    else if (action === 'solve-dtoc')         await solveCategoryFlow('dtoc');
    else if (action === 'solve-ctor')         await solveCategoryFlow('ctor');
    else if (action === 'solve-ttor')         await solveCategoryFlow('ttor');
    else if (action === 'solve-dtor')         await solveCategoryFlow('dtor');
    else if (action === 'solve-rtof')         await solveResidualView('R\u2192F Req\u2192Formal', 'sweepRtoF');
    else if (action === 'solve-ftot')         await solveResidualView('F\u2192T Formal\u2192Test', 'sweepFtoT');
    else if (action === 'solve-ctof')         await solveResidualView('C\u2192F Code\u2192Formal', 'sweepCtoF');
    else if (action === 'solve-ttoc')         await solveResidualView('T\u2192C Test\u2192Code', 'sweepTtoC');
    else if (action === 'solve-ftoc')         await solveResidualView('F\u2192C Formal\u2192Code', 'sweepFtoC');
    else if (action === 'solve-rtod')         await solveResidualView('R\u2192D Req\u2192Docs', 'sweepRtoD');
    else if (action === 'solve-ptof')         await solveResidualView('P\u2192F Prod\u2192Formal', 'sweepPtoF');
    else if (action === 'solve-l1tol2')       await solveResidualView('L1\u2192L2 Wiring:Evidence', 'sweepL1toL2');
    else if (action === 'solve-l2tol3')       await solveResidualView('L2\u2192L3 Wiring:Purpose', 'sweepL2toL3');
    else if (action === 'solve-l3totc')       await solveResidualView('L3\u2192TC Wiring:Coverage', 'sweepL3toTC');
    else if (action === 'solve-ftog')         await solveResidualView('F\u2192G Model Maturity', 'sweepPerModelGates');
    else if (action === 'solve-ctoe')         await solveResidualView('C\u2192E Git Heatmap', 'sweepGitHeatmap');
    else if (action === 'solve-gtof')         await solveResidualView('G\u2192F History Drift', 'sweepGitHistoryEvidence');
    else if (action === 'solve-ftof')         await solveResidualView('F\u2192F Formal Lint', 'sweepFormalLint');
    else if (action === 'solve-ftoh')         await solveResidualView('F\u2192H Hazard FMEA', 'sweepHazardModel');
    else if (action === 'solve-suppressions') solveSuppressionsFlow();
    else if (action === 'solve-classify')     await solveClassifyFlow();
  } catch (err) {
    if (err.message !== 'cancelled') toast(err.message, true);
    menuList.focus();
  }
}

// ─── Requirements: Coverage ──────────────────────────────────────────────────
function renderReqCoverage() {
  try {
    const { envelope, requirements } = reqCore.readRequirementsJson();
    const registry     = reqCore.readModelRegistry();
    const checkResults = reqCore.readCheckResults();
    const cov = reqCore.computeCoverage(requirements, registry, checkResults);

    const lines = [];
    lines.push('{bold}Requirements Coverage{/bold}');
    lines.push('─'.repeat(60));
    lines.push('');

    // Totals
    const completePct = cov.total ? ((cov.byStatus.Complete || 0) / cov.total * 100).toFixed(1) : '0.0';
    const pendingPct  = cov.total ? ((cov.byStatus.Pending  || 0) / cov.total * 100).toFixed(1) : '0.0';
    lines.push(`  Total:    ${cov.total}`);
    lines.push(`  {green-fg}Complete:{/} ${cov.byStatus.Complete || 0} (${completePct}%)`);
    lines.push(`  {yellow-fg}Pending:{/}  ${cov.byStatus.Pending || 0} (${pendingPct}%)`);
    for (const [status, count] of Object.entries(cov.byStatus).sort()) {
      if (status !== 'Complete' && status !== 'Pending') {
        lines.push(`  ${status}: ${count}`);
      }
    }
    lines.push('');

    // Category group breakdown with "Includes" column
    lines.push('{bold}By Category{/bold}');
    const cats = Object.entries(cov.byCategory).sort((a, b) => b[1].total - a[1].total);

    // Build "Includes" column: collect category_raw values per group
    const groupRaws = {};
    for (const r of requirements) {
      const grp = r.category || 'Uncategorized';
      const raw = r.category_raw || grp;
      if (groupRaws[grp] === undefined) groupRaws[grp] = new Set();
      if (raw !== grp) groupRaws[grp].add(raw);
    }

    const catW = Math.max(...cats.map(([c]) => c.length), 12);
    lines.push(`  ${pad('Group', catW)}  Reqs  Complete  Includes`);
    lines.push('  ' + '─'.repeat(catW + 50));
    for (const [cat, info] of cats) {
      const pct = info.total ? (info.complete / info.total * 100).toFixed(0) : '0';
      const raws = groupRaws[cat];
      const includes = raws && raws.size > 0 ? [...raws].sort().slice(0, 5).join(', ') + (raws.size > 5 ? '...' : '') : '';
      lines.push(`  ${pad(cat, catW)}  ${pad(String(info.total), 4)}  ${pad(info.complete + ' (' + pct + '%)', 8)}  {#666666-fg}${includes}{/}`);
    }
    lines.push('');

    // Formal model coverage
    const fmPct = cov.total ? (cov.withFormalModels / cov.total * 100).toFixed(1) : '0.0';
    lines.push('{bold}Formal Verification{/bold}');
    lines.push(`  Models:     ${cov.totalModels} formal models registered`);
    lines.push(`  Coverage:   ${cov.withFormalModels}/${cov.total} requirements have formal models (${fmPct}%)`);
    lines.push('');

    // Check results
    const crPct = cov.total ? (cov.withCheckResults / cov.total * 100).toFixed(1) : '0.0';
    lines.push('{bold}Check Results{/bold}');
    lines.push(`  Linked:     ${cov.withCheckResults}/${cov.total} requirements have check results (${crPct}%)`);
    for (const [res, count] of Object.entries(cov.checksByResult).sort()) {
      const color = res === 'pass' ? 'green' : res === 'fail' ? 'red' : 'yellow';
      lines.push(`  {${color}-fg}${pad(res, 14)}{/} ${count}`);
    }
    lines.push('');

    // Envelope
    if (envelope) {
      lines.push('{bold}Envelope{/bold}');
      if (envelope.aggregated_at) lines.push(`  Aggregated: ${envelope.aggregated_at}`);
      if (envelope.frozen_at)     lines.push(`  Frozen:     ${envelope.frozen_at}`);
      if (envelope.content_hash)  lines.push(`  Hash:       ${envelope.content_hash.slice(0, 20)}…`);
    }

    setContent('Coverage', lines.join('\n'));
  } catch (err) {
    setContent('Coverage', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Requirements: Browse ────────────────────────────────────────────────────
async function reqBrowseFlow() {
  const { requirements } = reqCore.readRequirementsJson();
  if (!requirements.length) { setContent('Browse Reqs', 'No requirements found.'); return; }

  const grouped = reqCore.groupByPrinciple(requirements);

  // Show principle picker in a loop; ESC from picker returns to menu
  while (true) {
    const items = principleMapping.PRINCIPLES.map(p => ({
      label: `${p} (${grouped[p].count} specs)`,
      value: p,
    }));

    let selected;
    try {
      selected = await promptList({ title: 'Browse by Principle', items });
    } catch (_) {
      // ESC pressed — return to menu
      return;
    }

    // Show specifications for the selected principle
    const principle = selected.value;
    const reqs = grouped[principle].requirements;
    renderReqList(reqs, { principle });
    // Wait for user to press ESC to go back to principle picker
    await new Promise(resolve => {
      contentBox.key(['escape'], function handler() {
        contentBox.unkey(['escape'], handler);
        resolve();
      });
    });
  }
}

function renderReqList(reqs, filters) {
  const lines = [];
  const filterDesc = [];
  if (filters.principle) filterDesc.push(filters.principle);
  if (filters.category) filterDesc.push(`category=${filters.category}`);
  if (filters.status)   filterDesc.push(`status=${filters.status}`);
  if (filters.search)   filterDesc.push(`search="${filters.search}"`);
  const subtitle = filterDesc.length ? ` (${filterDesc.join(', ')})` : '';

  // Dynamic text width: fill remaining space in contentBox
  const innerW = (screen.width || 120) - 35 - 2; // contentBox: left=35, borders=2

  lines.push(`{bold}Requirements (${reqs.length})${subtitle}{/bold}`);
  lines.push('─'.repeat(Math.max(70, innerW)));
  const fixed  = 2 + 12 + 2 + 3 + 2 + 16 + 2;
  const W = { id: 12, status: 3, cat: 16, text: Math.max(20, innerW - fixed - 1) };
  lines.push(`{bold}{underline}  ${pad('ID', W.id)}  ${pad('St', W.status)}  ${pad('Category', W.cat)}  Text{/underline}{/bold}`);

  reqs.forEach((r, i) => {
    // Status icon with color
    const icon = r.status === 'Complete' ? '{green-fg}✓{/}'
      : r.status === 'Blocked' ? '{red-fg}✗{/}'
      : r.status === 'In Progress' ? '{#4a9090-fg}◐{/}'
      : '{yellow-fg}○{/}';

    // Truncate text with ellipsis
    const rawText = r.text || '';
    const truncText = rawText.length > W.text ? rawText.slice(0, W.text - 1) + '…' : rawText;

    // Zebra stripe
    const bg = i % 2 === 0 ? '' : '{#1e2228-bg}';
    const bgEnd = i % 2 === 0 ? '' : '{/}';

    lines.push(
      `${bg}  {#4a9090-fg}${pad(r.id, W.id)}{/}  ${icon}${' '.repeat(W.status - 1)}  ${pad(r.category || 'Uncategorized', W.cat)}  ${pad(truncText, W.text)}${bgEnd}`
    );
  });

  setContent(`Browse Reqs (${reqs.length})`, lines.join('\n'));
}

// ─── Requirements: Traceability ──────────────────────────────────────────────
async function reqTraceabilityFlow() {
  const { requirements } = reqCore.readRequirementsJson();
  if (!requirements.length) { setContent('Traceability', 'No requirements found.'); return; }

  const items = requirements.map(r => ({
    label: `${pad(r.id, 12)} ${r.status === 'Complete' ? '✓' : '○'} ${(r.text || '').slice(0, 40)}`,
    value: r.id,
  }));

  const choice = await promptList({ title: 'Traceability — Pick Requirement', items });
  const reqId  = choice.value;

  const registry     = reqCore.readModelRegistry();
  const checkResults = reqCore.readCheckResults();
  const trace = reqCore.buildTraceability(reqId, requirements, registry, checkResults);

  if (!trace) { setContent('Traceability', `{red-fg}Requirement ${reqId} not found{/}`); return; }

  const lines = [];
  const r = trace.requirement;

  lines.push(`{bold}${r.id}{/bold}  ${r.status === 'Complete' ? '{green-fg}Complete{/}' : '{yellow-fg}' + (r.status || 'Unknown') + '{/}'}`);
  lines.push('─'.repeat(60));
  lines.push('');
  if (r.category) lines.push(`  Category:   ${r.category}`);
  if (r.phase)    lines.push(`  Phase:      ${r.phase}`);
  lines.push('');
  lines.push(`  {bold}Text:{/bold}`);
  lines.push(`  ${r.text || '—'}`);
  if (r.background) {
    lines.push('');
    lines.push(`  {bold}Background:{/bold}`);
    lines.push(`  {gray-fg}${r.background}{/}`);
  }
  if (r.provenance) {
    lines.push('');
    lines.push(`  {bold}Source:{/bold}`);
    if (r.provenance.source_file) lines.push(`  File:      ${r.provenance.source_file}`);
    if (r.provenance.milestone)   lines.push(`  Milestone: ${r.provenance.milestone}`);
  }

  // Formal Models
  lines.push('');
  lines.push(`{bold}Formal Models (${trace.formalModels.length}){/bold}`);
  if (trace.formalModels.length) {
    for (const fm of trace.formalModels) {
      lines.push(`  {cyan-fg}${fm.path}{/}`);
      if (fm.description) lines.push(`    ${fm.description}`);
      if (fm.version != null) lines.push(`    {gray-fg}v${fm.version}{/}`);
    }
  } else {
    lines.push('  {gray-fg}No formal models linked{/}');
  }

  // Check Results
  lines.push('');
  lines.push(`{bold}Check Results (${trace.checkResults.length}){/bold}`);
  if (trace.checkResults.length) {
    for (const cr of trace.checkResults) {
      const color = cr.result === 'pass' ? 'green' : cr.result === 'fail' ? 'red' : cr.result === 'error' ? 'magenta' : 'yellow';
      const runtime = cr.runtime_ms != null ? ` (${cr.runtime_ms}ms)` : '';
      lines.push(`  {${color}-fg}${pad(cr.result, 14)}{/} ${cr.check_id || '—'}${runtime}`);
      if (cr.summary) lines.push(`    {gray-fg}${cr.summary}{/}`);
    }
  } else {
    lines.push('  {gray-fg}No check results{/}');
  }

  // Unmapped check_ids
  if (trace.unmappedCheckIds.length) {
    lines.push('');
    lines.push(`{bold}Awaiting Results (${trace.unmappedCheckIds.length}){/bold}`);
    for (const cid of trace.unmappedCheckIds) {
      lines.push(`  {gray-fg}${cid}{/}`);
    }
  }

  setContent(`Trace: ${reqId}`, lines.join('\n'));
}

// ─── Requirements: Aggregate ─────────────────────────────────────────────────
async function reqAggregateFlow() {
  try {
    // TUI = human present = authorized to unfreeze
    const reqPath = path.join(getTargetPath(), '.planning', 'formal', 'requirements.json');
    if (fs.existsSync(reqPath)) {
      const envelope = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
      if (envelope.frozen_at !== null && envelope.frozen_at !== undefined) {
        envelope.frozen_at = null;
        fs.writeFileSync(reqPath, JSON.stringify(envelope, null, 2) + '\n');
        toast('Envelope unfrozen (TUI authorized)');
      }
    }
    const { aggregateRequirements } = require('./aggregate-requirements.cjs');
    const result = aggregateRequirements();
    const count  = result && result.count != null ? result.count : '?';
    const output = result && result.outputPath ? result.outputPath : '.planning/formal/requirements.json';
    toast(`Aggregated ${count} requirements → ${output}`);
  } catch (err) {
    setContent('Aggregate', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Requirements: Coverage Gaps -------------------------------------------------
function reqCoverageGapsFlow() {
  try {
    const { detectCoverageGaps } = require('./detect-coverage-gaps.cjs');
    const lines = [];
    lines.push('{bold}TLC Coverage Gap Analysis{/bold}');
    lines.push('─'.repeat(60));
    lines.push('');

    // Run for all known specs
    const specs = ['NFQuorum', 'NFStopHook', 'NFCircuitBreaker'];
    let totalGaps = 0;

    for (const specName of specs) {
      const result = detectCoverageGaps({ specName });
      lines.push(`{bold}${specName}{/bold}`);

      if (result.status === 'full-coverage') {
        lines.push('  {green-fg}Full coverage{/} — all TLC-reachable states observed in traces');
      } else if (result.status === 'gaps-found') {
        totalGaps += result.gaps.length;
        lines.push(`  {yellow-fg}${result.gaps.length} gap(s){/} — states reachable by TLC but not observed:`);
        for (const gap of result.gaps) {
          lines.push(`    {red-fg}${gap}{/}`);
        }
        if (result.outputPath) {
          lines.push(`  Report: ${result.outputPath}`);
        }
      } else if (result.status === 'no-traces') {
        lines.push('  {gray-fg}No conformance traces found{/}');
      } else if (result.status === 'unknown-spec') {
        lines.push(`  {gray-fg}${result.reason}{/}`);
      }
      lines.push('');
    }

    lines.push('─'.repeat(60));
    if (totalGaps > 0) {
      lines.push(`{yellow-fg}Total gaps: ${totalGaps} state(s) need test coverage{/}`);
    } else {
      lines.push('{green-fg}No coverage gaps detected across all specs{/}');
    }

    setContent('Coverage Gaps', lines.join('\n'));
  } catch (err) {
    setContent('Coverage Gaps', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Requirements: Gate Scoring --------------------------------------------------
function gateScoreFlow() {
  try {
    const registryPath = path.join(getTargetPath(), '.planning', 'formal', 'model-registry.json');
    if (!fs.existsSync(registryPath)) {
      setContent('Gate Scoring', '{yellow-fg}No model-registry.json found in target project.{/}\n\n' +
        'Gate scoring requires a formal model registry at:\n  .planning/formal/model-registry.json\n\n' +
        'Run {bold}node bin/initialize-model-registry.cjs{/bold} to create one.');
      return;
    }
    const result = spawnSync('node', [
      path.join(__dirname, 'compute-per-model-gates.cjs'), '--aggregate', '--json',
      '--project-root=' + getTargetPath()
    ], { encoding: 'utf8', timeout: 15000, cwd: getTargetPath() });

    if (result.status !== 0) {
      setContent('Gate Scoring', `{red-fg}Error running gate computation: ${(result.stderr || '').slice(0, 200)}{/}`);
      return;
    }

    const data = JSON.parse(result.stdout);
    const lines = [];

    // Header: aggregate scores
    lines.push('{bold}Gate Scoring \u2014 Aggregate{/bold}');
    lines.push('\u2500'.repeat(60));
    const s = data.scores || {};
    lines.push(`  Wiring:Evidence pass: {bold}${s.gate_a_pass ?? '?'}{/bold} / ${data.total_models ?? '?'}`);
    lines.push(`  Wiring:Purpose pass: {bold}${s.gate_b_pass ?? '?'}{/bold} / ${data.total_models ?? '?'}`);
    lines.push(`  Wiring:Coverage pass: {bold}${s.gate_c_pass ?? '?'}{/bold} / ${data.total_models ?? '?'}`);
    lines.push(`  Avg layer maturity: {bold}${(s.avg_layer_maturity ?? 0).toFixed(2)}{/bold}`);
    lines.push('');

    // Per-model table: group by maturity level
    const pm = data.per_model || {};
    const models = Object.keys(pm);
    const byLevel = { HARD_GATE: [], SOFT_GATE: [], ADVISORY: [] };
    for (const m of models) {
      const level = pm[m].gate_maturity || 'ADVISORY';
      if (!byLevel[level]) byLevel[level] = [];
      byLevel[level].push(m);
    }

    const levelColors = { HARD_GATE: '{green-fg}', SOFT_GATE: '{yellow-fg}', ADVISORY: '{red-fg}' };
    lines.push('{bold}Per-Model Maturity{/bold}');
    lines.push('\u2500'.repeat(60));
    for (const level of ['HARD_GATE', 'SOFT_GATE', 'ADVISORY']) {
      const arr = byLevel[level] || [];
      const clr = levelColors[level] || '';
      lines.push(`  ${clr}${level}{/} (${arr.length})`);
      // Show first 10 models per level, truncate rest
      const show = arr.slice(0, 10);
      for (const m of show) {
        const short = m.replace(/^\.planning\/formal\//, '');
        const info = pm[m];
        const abc = `A:${info.gate_a ? 'Y' : 'N'} B:${info.gate_b ? 'Y' : 'N'} C:${info.gate_c ? 'Y' : 'N'}`;
        lines.push(`    ${short}  ${abc}`);
      }
      if (arr.length > 10) lines.push(`    ... and ${arr.length - 10} more`);
      lines.push('');
    }

    // Promotion changelog (last 10 entries)
    const changelogPath = path.join(__dirname, '..', '.planning', 'formal', 'promotion-changelog.json');
    if (fs.existsSync(changelogPath)) {
      const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
      const recent = changelog.slice(-10).reverse();
      if (recent.length > 0) {
        lines.push('{bold}Recent Promotions/Demotions{/bold}');
        lines.push('\u2500'.repeat(60));
        for (const entry of recent) {
          const short = (entry.model || '').replace(/^\.planning\/formal\//, '');
          const arrow = entry.to_level === 'ADVISORY' ? '{red-fg}v{/}' : '{green-fg}^{/}';
          const ts = (entry.timestamp || '').slice(0, 16).replace('T', ' ');
          lines.push(`  ${arrow} ${short}: ${entry.from_level} -> ${entry.to_level}  {gray-fg}${ts}{/}`);
        }
      }
    }

    setContent('Gate Scoring', lines.join('\n'));
  } catch (err) {
    setContent('Gate Scoring', `{red-fg}Error: ${err.message}{/}`);
  }
}

// ─── Solve: Residual view (read-only sweep result) ──────────────────────────
async function solveResidualView(title, fnName) {
  setContent(`Solve - ${title}`,
    `{bold}Solve \u2014 ${title}{/bold}\n` +
    '\u2500'.repeat(60) + '\n\n' +
    '{yellow-fg}* Running sweep in background...{/}'
  );
  screen.render();

  let result;
  try {
    result = await sweepAsync(fnName);
  } catch (err) {
    setContent(`Solve - ${title}`,
      `{bold}Solve \u2014 ${title}{/bold}\n` +
      '\u2500'.repeat(60) + '\n\n' +
      `{red-fg}Error running sweep: ${err.message}{/}`
    );
    return;
  }

  const lines = [];
  lines.push(`{bold}Solve \u2014 ${title}{/bold}`);
  lines.push('\u2500'.repeat(60));
  lines.push('');

  const residual = result.residual;
  const detail = result.detail || {};

  // Residual badge
  if (residual < 0) {
    if (detail.skipped) {
      lines.push(`{yellow-fg}! Skipped{/}  ${detail.reason || ''}`);
    } else if (detail.error) {
      lines.push(`{red-fg}x Error{/}  ${detail.stderr || 'unknown error'}`);
    } else {
      lines.push('{gray-fg}N/A{/}');
    }
  } else if (residual === 0) {
    lines.push('{green-fg}ok Residual: 0 \u2014 All clear{/}');
  } else {
    lines.push(`{red-fg}x Residual: ${residual}{/}`);
  }
  lines.push('');

  // Detail key-value pairs
  lines.push('{bold}Detail{/bold}');
  lines.push('\u2500'.repeat(40));
  for (const [key, val] of Object.entries(detail)) {
    if (key === 'skipped' || key === 'error' || key === 'stderr') continue;
    if (Array.isArray(val)) {
      lines.push(`  {cyan-fg}${key}{/}: ${val.length} item(s)`);
      for (const item of val.slice(0, 10)) {
        if (typeof item === 'object') {
          const summary = Object.entries(item).map(([k, v]) => `${k}=${v}`).join(', ');
          lines.push(`    {gray-fg}\u2022 ${summary}{/}`);
        } else {
          lines.push(`    {gray-fg}\u2022 ${item}{/}`);
        }
      }
      if (val.length > 10) lines.push(`    {gray-fg}... and ${val.length - 10} more{/}`);
    } else if (typeof val === 'object' && val !== null) {
      lines.push(`  {cyan-fg}${key}{/}:`);
      for (const [sk, sv] of Object.entries(val)) {
        lines.push(`    ${sk}: ${sv}`);
      }
    } else {
      lines.push(`  {cyan-fg}${key}{/}: ${val}`);
    }
  }

  setContent(`Solve - ${title}`, lines.join('\n'));
}

// ─── Solve: Browse overview ──────────────────────────────────────────────────
async function solveBrowseFlow() {
  setContent('Solve - Browse',
    '{bold}Solve Items{/bold}\n' +
    '\u2500'.repeat(60) + '\n\n' +
    '{yellow-fg}* Loading sweep data in background...{/}'
  );
  screen.render();

  let data;
  try {
    data = await loadSweepDataAsync();
  } catch (err) {
    setContent('Solve - Browse',
      '{bold}Solve Items{/bold}\n' +
      '\u2500'.repeat(60) + '\n\n' +
      `{red-fg}Error loading sweep data: ${err.message}{/}`
    );
    return;
  }

  const classifications = solveTui.readClassificationCache();
  const lines = [];
  lines.push('{bold}Solve Items{/bold}');
  lines.push('\u2500'.repeat(60));
  lines.push('');

  const catLabels = { dtoc: 'D->C Broken Claims', ctor: 'C->R Untraced Modules', ttor: 'T->R Orphan Tests', dtor: 'D->R Unbacked Claims' };
  const catColors = { dtoc: '{#ff6b6b-fg}', ctor: '{#4a9090-fg}', ttor: '{#c49060-fg}', dtor: '{#b07de0-fg}' };
  let totalCount = 0;

  for (const key of ['dtoc', 'ctor', 'ttor', 'dtor']) {
    const cat = data[key];
    const catClr = catColors[key] || '{yellow-fg}';
    if (!cat) { lines.push(`  {gray-fg}${catLabels[key]}: N/A{/}`); continue; }
    const count = cat.items ? cat.items.length : 0;
    totalCount += count;
    if (cat.error) {
      lines.push(`  {red-fg}${catLabels[key]}: ERROR - ${cat.error}{/}`);
    } else if (count === 0) {
      lines.push(`  {green-fg}${catLabels[key]}: 0 items{/}`);
    } else {
      lines.push(`  ${catClr}${catLabels[key]}: ${count} item(s){/}`);
      // Show type breakdown for D→C
      if (key === 'dtoc' && cat.items.length > 0) {
        const byType = {};
        const byCat = {};
        for (const it of cat.items) {
          byType[it.claimType || 'unknown'] = (byType[it.claimType || 'unknown'] || 0) + 1;
          byCat[it.category || 'unknown'] = (byCat[it.category || 'unknown'] || 0) + 1;
        }
        const typeStr = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(', ');
        const catStr = Object.entries(byCat).map(([k, v]) => `${k}: ${v}`).join(', ');
        lines.push(`    {gray-fg}by type: ${typeStr}{/}`);
        lines.push(`    {gray-fg}by doc category: ${catStr}{/}`);
      }
      // Show directory breakdown for C→R
      if (key === 'ctor' && cat.items.length > 0) {
        const byDir = {};
        for (const it of cat.items) {
          const dir = (it.file || '').split('/')[0] || 'unknown';
          byDir[dir] = (byDir[dir] || 0) + 1;
        }
        const dirStr = Object.entries(byDir).map(([k, v]) => `${k}/: ${v}`).join(', ');
        lines.push(`    {gray-fg}by directory: ${dirStr}{/}`);
      }
      // Show source module match stats for T→R
      if (key === 'ttor' && cat.items.length > 0) {
        let withSource = 0;
        for (const it of cat.items) {
          const base = (it.file || '').replace(/\.test\.(cjs|js|mjs)$/, '.$1');
          try { if (fs.existsSync(path.join(__dirname, '..', base))) withSource++; } catch (_) {}
        }
        lines.push(`    {gray-fg}with matching source module: ${withSource}/${cat.items.length}{/}`);
      }
      // Show Haiku classification breakdown if available
      const catClass = classifications[key] || {};
      if (Object.keys(catClass).length > 0) {
        let genuine = 0, fp = 0, review = 0;
        for (const it of cat.items) {
          const k = solveTui.itemKey(key, it);
          const v = catClass[k] || 'review';
          if (v === 'genuine') genuine++;
          else if (v === 'fp') fp++;
          else review++;
        }
        lines.push(`    {gray-fg}haiku triage: {red-fg}${genuine} genuine{/gray-fg} | {green-fg}${fp} fp{/gray-fg} | {yellow-fg}${review} review{/gray-fg}{/}`);
      }
    }
  }

  lines.push('');
  lines.push('\u2500'.repeat(60));
  lines.push(`{bold}Human-gated: ${totalCount} item(s) across 4 categories{/bold}`);
  // Show classification summary
  const hasAnyClassification = Object.values(classifications).some(c => Object.keys(c).length > 0);
  if (hasAnyClassification) {
    lines.push('{gray-fg}Haiku triage: per-item cache active. New items classified on demand.{/}');
  } else {
    lines.push('{gray-fg}No Haiku triage yet \u2014 run Classify All (Haiku) from menu{/}');
  }
  if (totalCount === 0) {
    lines.push('');
    lines.push('{green-fg}All clean! No human-gated items found.{/}');
  }

  // ── All 19 transitions overview (streamed from background worker) ──
  lines.push('');
  lines.push('{bold}All Layer Transitions{/bold}');
  lines.push('\u2500'.repeat(60));
  lines.push('{yellow-fg}* Running all 19 sweeps in background...{/}');
  setContent('Solve - Browse', lines.join('\n'));

  const sweepSummary = [
    { group: 'Forward', items: [
      { label: 'R\u2192F Req\u2192Formal',  fn: 'sweepRtoF' },
      { label: 'F\u2192T Formal\u2192Test', fn: 'sweepFtoT' },
      { label: 'C\u2192F Code\u2192Formal', fn: 'sweepCtoF' },
      { label: 'T\u2192C Test\u2192Code',   fn: 'sweepTtoC' },
      { label: 'F\u2192C Formal\u2192Code', fn: 'sweepFtoC' },
      { label: 'R\u2192D Req\u2192Docs',    fn: 'sweepRtoD' },
      { label: 'D\u2192C Doc\u2192Code',    fn: 'sweepDtoC' },
      { label: 'P\u2192F Prod\u2192Formal', fn: 'sweepPtoF' },
    ]},
    { group: 'Reverse', items: [
      { label: 'C\u2192R Untraced',   fn: 'sweepCtoR' },
      { label: 'T\u2192R Orphans',    fn: 'sweepTtoR' },
      { label: 'D\u2192R Unbacked',   fn: 'sweepDtoR' },
    ]},
    { group: 'Layer Alignment', items: [
      { label: 'L1\u2192L2 Wiring:Evidence', fn: 'sweepL1toL2' },
      { label: 'L2\u2192L3 Wiring:Purpose',  fn: 'sweepL2toL3' },
      { label: 'L3\u2192TC Wiring:Coverage', fn: 'sweepL3toTC' },
    ]},
    { group: 'Evidence & Maturity', items: [
      { label: 'F\u2192G Maturity',   fn: 'sweepPerModelGates' },
      { label: 'C\u2192E Heatmap',    fn: 'sweepGitHeatmap' },
      { label: 'G\u2192F Drift',      fn: 'sweepGitHistoryEvidence' },
      { label: 'F\u2192F Lint',       fn: 'sweepFormalLint' },
      { label: 'F\u2192H Hazard',     fn: 'sweepHazardModel' },
    ]},
  ];

  // Build fn→label lookup and collect all fnNames
  const fnLabelMap = {};
  const allFnNames = [];
  for (const grp of sweepSummary) {
    for (const s of grp.items) {
      fnLabelMap[s.fn] = { label: s.label, group: grp.group };
      allFnNames.push(s.fn);
    }
  }

  // Stream results from background worker
  const sweepResults = {};
  let completed = 0;
  try {
    await batchSweepAsync(allFnNames, (fnName, result, error) => {
      completed++;
      sweepResults[fnName] = error ? { error } : result;

      // Update the "All Layer Transitions" section with live progress
      const transLines = [];
      transLines.push('');
      transLines.push('{bold}All Layer Transitions{/bold}');
      transLines.push('\u2500'.repeat(60));
      transLines.push(`{gray-fg}Progress: ${completed}/${allFnNames.length}{/}`);
      for (const grp of sweepSummary) {
        transLines.push(`  {bold}${grp.group}{/bold}`);
        for (const s of grp.items) {
          const sr = sweepResults[s.fn];
          if (!sr) {
            transLines.push(`    {gray-fg}${s.label}: * pending...{/}`);
          } else if (sr.error) {
            transLines.push(`    {red-fg}${s.label}: ERROR ${sr.error}{/}`);
          } else {
            const res = sr.residual;
            if (res < 0) {
              const reason = (sr.detail && sr.detail.reason) || (sr.detail && sr.detail.stderr) || 'skipped';
              transLines.push(`    {yellow-fg}${s.label}: ! ${reason}{/}`);
            } else if (res === 0) {
              transLines.push(`    {green-fg}${s.label}: ok 0{/}`);
            } else {
              transLines.push(`    {red-fg}${s.label}: x ${res}{/}`);
            }
          }
        }
      }

      // Replace the transitions section in the content
      const cutIdx = lines.findIndex(l => l.includes('All Layer Transitions'));
      if (cutIdx >= 0) lines.length = cutIdx;
      lines.push(...transLines);
      setContent('Solve - Browse', lines.join('\n'));
    });
    // Force full redraw after streaming to clear any diff-algorithm ghost artifacts
    screen.alloc();
    screen.render();
  } catch (err) {
    const cutIdx = lines.findIndex(l => l.includes('All Layer Transitions'));
    if (cutIdx >= 0) lines.length = cutIdx;
    lines.push('');
    lines.push('{bold}All Layer Transitions{/bold}');
    lines.push('\u2500'.repeat(60));
    lines.push(`{red-fg}Error running batch sweep: ${err.message}{/}`);
    setContent('Solve - Browse', lines.join('\n'));
  }
}

// ─── Solve: Category drill-down ─────────────────────────────────────────────
async function solveCategoryFlow(catKey) {
  const PAGE_SIZE = 20;
  const catLabels = { dtoc: 'D->C Broken Claims', ctor: 'C->R Untraced Modules', ttor: 'T->R Orphan Tests', dtor: 'D->R Unbacked Claims' };
  const catLabel = catLabels[catKey] || catKey;

  setContent(`Solve - ${catLabel}`, '{yellow-fg}* Loading sweep data in background...{/}');
  screen.render();

  let data;
  try {
    data = await loadSweepDataAsync();
  } catch (err) {
    setContent(`Solve - ${catLabel}`, `{red-fg}Error loading data: ${err.message}{/}`);
    return;
  }
  const classifications = solveTui.readClassificationCache();
  const catClass = classifications[catKey] || {};
  const cat = data[catKey];

  if (!cat || cat.error) {
    setContent(`Solve - ${catLabel}`, `{red-fg}Error: ${(cat && cat.error) || 'Category not found'}{/}`);
    return;
  }

  const items = cat.items || [];
  if (items.length === 0) {
    setContent(`Solve - ${catLabel}`, '{gray-fg}No items found.{/}');
    return;
  }

  // Build paginated display
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  let page = 0;

  async function showPage() {
    const start = page * PAGE_SIZE;
    const end = Math.min(items.length, start + PAGE_SIZE);
    const pageItems = items.slice(start, end);

    const lines = [];
    lines.push(`{bold}${catLabel}{/bold}  {gray-fg}(${items.length} item(s)){/}`);
    lines.push('\u2500'.repeat(60));
    lines.push('');

    for (let i = 0; i < pageItems.length; i++) {
      const idx = start + i;
      const item = pageItems[i];
      const iKey = solveTui.itemKey(catKey, item);
      const verdict = catClass[iKey];
      const badge = verdict === 'genuine' ? '{red-fg}[!]{/}' : verdict === 'fp' ? '{green-fg}[~]{/}' : verdict === 'review' ? '{yellow-fg}[?]{/}' : '';
      const num = String(idx + 1).padStart(4) + '.';

      if (catKey === 'dtoc') {
        const typeTag = `[${item.claimType || item.type || '?'}]`;
        lines.push(`  ${num}${badge} {yellow-fg}${typeTag}{/} ${(item.value || item.summary || '').slice(0, 60)}`);
        lines.push(`       {cyan-fg}${item.doc_file || 'N/A'}${item.line ? ':' + item.line : ''}{/}  {red-fg}${item.reason || ''}{/}`);
        lines.push(`       {gray-fg}category: ${item.category || 'N/A'}{/}`);
      } else if (catKey === 'ctor') {
        const filePath = item.file || item.summary || 'N/A';
        lines.push(`  ${num}${badge} {cyan-fg}${filePath}{/}`);
        // Show first-line description from the module
        try {
          const absFile = path.join(__dirname, '..', filePath);
          const head = fs.readFileSync(absFile, 'utf8').split('\n').slice(0, 10);
          const desc = head.find(l => /^\s*\*\s+\S|^\/\/\s+\S|^\/\*\*/.test(l));
          if (desc) lines.push(`       {gray-fg}${desc.replace(/^\s*[\/*]+\s*/, '').slice(0, 65)}{/}`);
        } catch (_) {}
        // Check for matching test file
        const testFile = filePath.replace(/\.(cjs|js|mjs)$/, '.test.$1');
        try {
          if (fs.existsSync(path.join(__dirname, '..', testFile))) {
            lines.push(`       {green-fg}has test: ${testFile}{/}`);
          }
        } catch (_) {}
      } else if (catKey === 'ttor') {
        const filePath = item.file || item.summary || 'N/A';
        lines.push(`  ${num}${badge} {cyan-fg}${filePath}{/}`);
        // Show source module and whether it's requirement-traced
        const sourceFile = filePath.replace(/\.test\.(cjs|js|mjs)$/, '.$1');
        try {
          if (fs.existsSync(path.join(__dirname, '..', sourceFile))) {
            lines.push(`       {gray-fg}source: ${sourceFile}{/}`);
          } else {
            lines.push(`       {red-fg}no source module found{/}`);
          }
        } catch (_) {}
        // Show first describe() or test title
        try {
          const absFile = path.join(__dirname, '..', filePath);
          const head = fs.readFileSync(absFile, 'utf8').split('\n').slice(0, 30);
          const descLine = head.find(l => /describe\(|test\(|it\(/.test(l));
          if (descLine) {
            const match = descLine.match(/(?:describe|test|it)\(\s*['"`]([^'"`]+)/);
            if (match) lines.push(`       {gray-fg}tests: "${match[1].slice(0, 55)}"{/}`);
          }
        } catch (_) {}
      } else if (catKey === 'dtor') {
        lines.push(`  ${num}${badge} {yellow-fg}${(item.claim_text || item.summary || '').slice(0, 70)}{/}`);
        lines.push(`       {cyan-fg}${item.doc_file || 'N/A'}${item.line ? ':' + item.line : ''}{/}`);
        // Show the action verb that triggered detection
        const ACTION_VERBS_LIST = ['supports','enables','provides','ensures','guarantees','validates','enforces','detects','prevents','handles','automates','generates','monitors','verifies','dispatches'];
        const verb = ACTION_VERBS_LIST.find(v => (item.claim_text || '').toLowerCase().includes(v));
        if (verb) lines.push(`       {gray-fg}trigger: "${verb}"{/}`);
      }
    }

    lines.push('');
    lines.push(`{gray-fg}Page ${page + 1}/${totalPages} | Select item to act...{/}`);
    setContent(`Solve - ${catLabel}`, lines.join('\n'));

    // Build promptList items
    const listItems = pageItems.map((item, i) => {
      const idx = start + i;
      const label = `${idx + 1}. ${(item.summary || item.file || item.claim_text || '').slice(0, 40)}`;
      return { label, value: idx };
    });
    if (page > 0) listItems.unshift({ label: '\u25c0 Previous Page', value: '__prev__' });
    if (page < totalPages - 1) listItems.push({ label: '\u25b6 Next Page', value: '__next__' });
    listItems.push({ label: '[Back]', value: '__back__' });

    const choice = await promptList({ title: `${catLabel} (${items.length})`, items: listItems });

    if (choice.value === '__back__') return;
    if (choice.value === '__prev__') { page--; return showPage(); }
    if (choice.value === '__next__') { page++; return showPage(); }

    // Show item detail
    await showItemDetail(catKey, items[choice.value], catLabel);
    // After returning from detail, show page again
    return showPage();
  }

  await showPage();
}

async function showItemDetail(catKey, item, catLabel) {
  if (!item) return;

  // Show Haiku classification badge if available
  const classifications = solveTui.readClassificationCache();
  const catClass = classifications[catKey] || {};
  const iKey = solveTui.itemKey(catKey, item);
  const verdict = catClass[iKey];
  const verdictLabel = verdict === 'genuine' ? '{red-fg}[!] GENUINE — needs action{/}'
    : verdict === 'fp' ? '{green-fg}[~] FALSE POSITIVE — likely noise{/}'
    : verdict === 'review' ? '{yellow-fg}[?] NEEDS REVIEW — ambiguous{/}'
    : '{gray-fg}not classified — run Classify All{/}';

  const lines = [];
  lines.push('{bold}Item Detail{/bold}');
  lines.push('\u2500'.repeat(70));
  lines.push(`  {bold}Haiku triage:{/bold} ${verdictLabel}`);
  lines.push('');

  if (catKey === 'dtoc') {
    lines.push(`  {bold}Type:{/bold}      ${item.claimType || 'N/A'}`);
    lines.push(`  {bold}Value:{/bold}     ${item.value || 'N/A'}`);
    lines.push(`  {bold}File:{/bold}      {cyan-fg}${item.doc_file || 'N/A'}{/}`);
    lines.push(`  {bold}Line:{/bold}      ${item.line || 'N/A'}`);
    lines.push(`  {bold}Reason:{/bold}    {yellow-fg}${item.reason || 'N/A'}{/}`);
    lines.push(`  {bold}Category:{/bold}  ${item.category || 'N/A'}`);
  } else if (catKey === 'ctor') {
    const filePath = item.file || 'N/A';
    lines.push(`  {bold}File:{/bold}        {cyan-fg}${filePath}{/}`);
    // Classify module type
    const base = path.basename(filePath).replace(/\.\w+$/, '');
    const isInfra = /^(install|build|bundle|aggregate|migrate|resolve|generate|check-|validate-|analyze|lint|scan-|trace-|write-check|review-|token-|promote-)/.test(base);
    lines.push(`  {bold}Type:{/bold}        ${isInfra ? '{gray-fg}infrastructure/utility{/}' : '{yellow-fg}feature module{/}'}`);
    // Show test file status
    const testFile = filePath.replace(/\.(cjs|js|mjs)$/, '.test.$1');
    try {
      if (fs.existsSync(path.join(__dirname, '..', testFile))) {
        lines.push(`  {bold}Test:{/bold}        {green-fg}${testFile}{/}`);
      } else {
        lines.push(`  {bold}Test:{/bold}        {gray-fg}none{/}`);
      }
    } catch (_) { lines.push(`  {bold}Test:{/bold}        {gray-fg}none{/}`); }
    // Show first few comment lines as description
    try {
      const head = fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8').split('\n').slice(0, 15);
      const comments = head.filter(l => /^\s*[\/*]/.test(l) && !/^#!/.test(l)).slice(0, 3);
      if (comments.length > 0) {
        lines.push(`  {bold}Purpose:{/bold}`);
        for (const c of comments) {
          const cleaned = c.replace(/^\s*[\/*]+\s*/, '').slice(0, 70);
          if (cleaned) lines.push(`    {gray-fg}${cleaned}{/}`);
        }
      }
    } catch (_) {}
    lines.push('');
    lines.push(`  {bold}Action needed:{/bold} Either trace this module to a requirement,`);
    lines.push(`  or acknowledge as infrastructure that doesn't need requirement tracing.`);
  } else if (catKey === 'ttor') {
    const filePath = item.file || 'N/A';
    lines.push(`  {bold}Test File:{/bold}   {cyan-fg}${filePath}{/}`);
    // Show source module and its requirement tracing status
    const sourceFile = filePath.replace(/\.test\.(cjs|js|mjs)$/, '.$1');
    try {
      if (fs.existsSync(path.join(__dirname, '..', sourceFile))) {
        lines.push(`  {bold}Source:{/bold}      {cyan-fg}${sourceFile}{/}`);
        lines.push(`  {bold}Source traced:{/bold} Check if source module is traced to a requirement`);
      } else {
        lines.push(`  {bold}Source:{/bold}      {red-fg}no matching source module{/}`);
      }
    } catch (_) {}
    // Show test describe/title
    try {
      const content = fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8').split('\n').slice(0, 40);
      const describes = content.filter(l => /describe\(|test\(|it\(/.test(l)).slice(0, 3);
      if (describes.length > 0) {
        lines.push(`  {bold}Tests:{/bold}`);
        for (const d of describes) {
          const match = d.match(/(?:describe|test|it)\(\s*['"\`]([^'"\`]+)/);
          if (match) lines.push(`    {gray-fg}"${match[1].slice(0, 60)}"{/}`);
        }
      }
    } catch (_) {}
    lines.push('');
    lines.push(`  {bold}Action needed:{/bold} Add @req REQ-XX annotation to link this test`);
    lines.push(`  to a requirement, or acknowledge as utility test.`);
  } else if (catKey === 'dtor') {
    lines.push(`  {bold}Claim:{/bold}     ${item.claim_text || 'N/A'}`);
    lines.push(`  {bold}File:{/bold}      {cyan-fg}${item.doc_file || 'N/A'}{/}`);
    lines.push(`  {bold}Line:{/bold}      ${item.line || 'N/A'}`);
    // Highlight the action verb that triggered detection
    const ACTION_VERBS = ['supports','enables','provides','ensures','guarantees','validates','enforces','detects','prevents','handles','automates','generates','monitors','verifies','dispatches'];
    const foundVerb = ACTION_VERBS.find(v => (item.claim_text || '').toLowerCase().includes(v));
    if (foundVerb) {
      lines.push(`  {bold}Trigger:{/bold}   Action verb "{yellow-fg}${foundVerb}{/}" with no matching requirement`);
    }
    lines.push('');
    lines.push(`  {bold}Action needed:{/bold} Either create a requirement backing this claim,`);
    lines.push(`  or acknowledge as documentation that doesn't need requirement backing.`);
  }

  // Show file context around the item — the actual content you need to make decisions
  const filePath = item.doc_file || item.file;
  const targetLine = item.line;
  if (filePath) {
    lines.push('');
    lines.push('\u2500'.repeat(70));
    lines.push(`{bold}File Context:{/bold} {cyan-fg}${filePath}{/}`);
    lines.push('');

    const ctx = solveTui.readFileContext(filePath, targetLine, 5);
    if (ctx.error) {
      lines.push(`  {red-fg}Could not read file: ${ctx.error}{/}`);
    } else if (ctx.lines.length > 0) {
      // Show context around target line, or first 20 lines for items without a line number
      const start = targetLine ? Math.max(0, targetLine - 6) : 0;
      const end = targetLine ? Math.min(ctx.totalLines, targetLine + 5) : Math.min(20, ctx.totalLines);
      for (let i = start; i < end; i++) {
        const lineNum = String(i + 1).padStart(4);
        const lineText = (ctx.lines[i] || '').slice(0, 100);
        // Escape blessed markup in file content
        const escaped = lineText.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
        if (targetLine && i === targetLine - 1) {
          lines.push(`  {yellow-bg}{black-fg}${lineNum}  ${escaped}{/}`);
        } else {
          lines.push(`  {gray-fg}${lineNum}{/}  ${escaped}`);
        }
      }
      if (end < ctx.totalLines) {
        lines.push(`  {gray-fg}  ... (${ctx.totalLines - end} more lines){/}`);
      }
    }
  }

  lines.push('');
  lines.push('\u2500'.repeat(70));
  const actionHint = (catKey === 'ctor' || catKey === 'ttor' || catKey === 'dtor')
    ? 'Actions: Create Requirement | Acknowledge as FP | Add Regex Suppression | Back'
    : (catKey === 'dtoc')
      ? 'Actions: Create TODO | Acknowledge as FP | Add Regex Suppression | Back'
      : 'Actions: Acknowledge as FP | Add Regex Suppression | Back';
  lines.push(`{bold}  Press Enter: ${actionHint} | Scroll to read | ESC to go back{/}`);

  setContent(`Solve - ${catLabel} - Detail`, lines.join('\n'));

  // Focus contentBox so user can scroll and read the full page
  contentBox.focus();
  screen.render();

  // Wait for user to press Enter (open actions) or ESC (go back)
  await new Promise((resolve) => {
    function onKey(ch, key) {
      if (key.name === 'return' || key.name === 'enter') {
        contentBox.removeListener('keypress', onKey);
        resolve('actions');
      } else if (key.name === 'escape' || ch === 'q') {
        contentBox.removeListener('keypress', onKey);
        resolve('back');
      }
    }
    contentBox.on('keypress', onKey);
  }).then(async (result) => {
    if (result === 'back') {
      menuList.focus();
      screen.render();
      return;
    }

    // Build category-aware action menu
    let actionItems;
    if (catKey === 'ctor' || catKey === 'ttor' || catKey === 'dtor') {
      actionItems = [
        { label: 'Create Requirement', value: 'create-req' },
        { label: 'Acknowledge as FP', value: 'ack' },
        { label: 'Add Regex Suppression', value: 'regex' },
        { label: 'Back', value: 'back' },
      ];
    } else if (catKey === 'dtoc') {
      actionItems = [
        { label: 'Create TODO', value: 'create-todo' },
        { label: 'Acknowledge as FP', value: 'ack' },
        { label: 'Add Regex Suppression', value: 'regex' },
        { label: 'Back', value: 'back' },
      ];
    } else {
      actionItems = [
        { label: 'Acknowledge as FP', value: 'ack' },
        { label: 'Add Regex Suppression', value: 'regex' },
        { label: 'Back', value: 'back' },
      ];
    }

    let actionChoice;
    try {
      actionChoice = await promptList({ title: 'Item Actions', items: actionItems });
    } catch (_) { return; }

    if (actionChoice.value === 'create-req') {
      const result = solveTui.createRequirementFromItem(item, catKey);
      if (result.ok) {
        toast(`Requirement ${result.id} created in requirements.json`);
      } else {
        toast(`Error: ${result.reason}`, true);
      }
    } else if (actionChoice.value === 'create-todo') {
      const result = solveTui.createTodoFromItem(item);
      if (result.ok) {
        toast(`TODO ${result.id} added to .planning/todos.json`);
      } else {
        toast('Error creating TODO', true);
      }
    } else if (actionChoice.value === 'ack') {
      const ok = solveTui.acknowledgeItem(item);
      if (ok) {
        toast('Acknowledged -- will be suppressed on next sweep');
      } else {
        toast('Error writing acknowledgment file', true);
      }
    } else if (actionChoice.value === 'regex') {
      const regex = await promptInput({ title: 'Regex Suppression', prompt: 'Enter regex pattern:' });
      if (regex) {
        const reason = await promptInput({ title: 'Reason', prompt: 'Reason for suppression:', default: 'Added via nForma TUI' });
        const ok = solveTui.addRegexPattern(item, regex, reason || 'Added via nForma TUI');
        if (ok) {
          toast('Pattern added -- will be applied on next sweep');
        } else {
          toast('Error writing pattern file', true);
        }
      }
    }
  });
}

// ─── Solve: Classify All (Haiku sub-agent) ──────────────────────────────────
async function solveClassifyFlow() {
  setContent('Solve - Classify',
    '{bold}Haiku Classification{/bold}\n\n' +
    '{yellow-fg}* Loading sweep data in background...{/}'
  );
  screen.render();

  let data;
  try {
    data = await loadSweepDataAsync();
  } catch (err) {
    setContent('Solve - Classify',
      `{bold}Haiku Classification{/bold}\n\n{red-fg}Error loading data: ${err.message}{/}`
    );
    return;
  }

  const totalItems = ['dtoc', 'ctor', 'ttor', 'dtor'].reduce((sum, k) => {
    const cat = data[k];
    return sum + ((cat && cat.items) ? cat.items.length : 0);
  }, 0);

  // Check how many items already have cached classifications
  const existingCache = solveTui.readClassificationCache();
  let alreadyCached = 0;
  for (const catKey of ['dtoc', 'ctor', 'ttor', 'dtor']) {
    const cat = data[catKey];
    const catCache = existingCache[catKey] || {};
    if (cat && cat.items) {
      for (const item of cat.items) {
        if (catCache[solveTui.itemKey(catKey, item)]) alreadyCached++;
      }
    }
  }
  const newItems = totalItems - alreadyCached;

  setContent('Solve - Classify',
    `{bold}Haiku Classification{/bold}\n\n` +
    `Total items: ${totalItems}\n` +
    `Already classified: ${alreadyCached} (cached forever per item)\n` +
    `New items to classify: ${newItems}\n\n` +
    (newItems > 0
      ? `{yellow-fg}* Classifying ${newItems} new items via Haiku in background...{/}\n{gray-fg}Batched (50 per call). Only unclassified items are sent.{/}`
      : `{green-fg}All items already classified! Nothing to do.{/}`)
  );
  screen.render();

  if (newItems === 0) return;

  try {
    const classifications = await classifyAsync(data, { force: false });
    const cStats = classifications._stats || { cached: 0, classified: 0, failed: 0 };

    // Count verdicts across all categories
    const verdicts = { genuine: 0, fp: 0, review: 0 };
    for (const catKey of ['dtoc', 'ctor', 'ttor', 'dtor']) {
      const catClass = classifications[catKey] || {};
      for (const v of Object.values(catClass)) {
        if (verdicts[v] !== undefined) verdicts[v]++;
      }
    }

    const lines = [];
    lines.push('{bold}Haiku Classification Complete{/bold}');
    lines.push('\u2500'.repeat(60));
    lines.push('');
    lines.push(`  {red-fg}[!] Genuine gaps:{/}  ${verdicts.genuine}`);
    lines.push(`  {green-fg}[~] False positives:{/} ${verdicts.fp}`);
    lines.push(`  {yellow-fg}[?] Needs review:{/}  ${verdicts.review}`);
    lines.push('');
    lines.push(`  From cache: ${cStats.cached}  |  Newly classified: ${cStats.classified}  |  Failed: ${cStats.failed}`);
    lines.push('');
    lines.push('{gray-fg}Per-item cache: classifications persist forever until item changes.{/}');
    lines.push('{gray-fg}Badges now visible in category views.{/}');
    lines.push('');
    lines.push('{bold}Legend:{/bold} {red-fg}[!]{/} genuine  {green-fg}[~]{/} fp  {yellow-fg}[?]{/} review');

    setContent('Solve - Classify', lines.join('\n'));
    toast(`Done: ${cStats.classified} new, ${cStats.cached} cached`);
  } catch (e) {
    setContent('Solve - Classify',
      `{bold}Haiku Classification{/bold}\n\n{red-fg}Error: ${e.message}{/}\n\n` +
      `Make sure the claude CLI is available and ANTHROPIC_API_KEY is set.`
    );
  }
}

// ─── Solve: Suppressions ────────────────────────────────────────────────────
function solveSuppressionsFlow() {
  const fpData = solveTui.readFPFile();
  const lines = [];
  lines.push('{bold}Acknowledged False Positives{/bold}');
  lines.push('\u2500'.repeat(60));
  lines.push('');

  const entries = fpData.entries || [];
  const patterns = fpData.patterns || [];

  if (entries.length === 0 && patterns.length === 0) {
    lines.push('{gray-fg}No suppressions configured.{/}');
    setContent('Solve - Suppressions', lines.join('\n'));
    return;
  }

  lines.push(`{bold}Entries ({entries.length}){/bold}`);
  if (entries.length === 0) {
    lines.push('  {gray-fg}None{/}');
  } else {
    for (const e of entries) {
      lines.push(`  {yellow-fg}${e.type || e.source || 'unknown'}{/}  ${e.value || 'N/A'}`);
      if (e.reason) lines.push(`    {gray-fg}Reason: ${e.reason}{/}`);
      if (e.acknowledged_at) lines.push(`    {gray-fg}Date: ${e.acknowledged_at}{/}`);
    }
  }

  lines.push('');
  lines.push('\u2500'.repeat(40));
  lines.push('');
  lines.push(`{bold}Patterns ({patterns.length}){/bold}`);
  if (patterns.length === 0) {
    lines.push('  {gray-fg}None{/}');
  } else {
    for (const p of patterns) {
      const enabled = p.enabled !== false ? '{green-fg}ON{/}' : '{red-fg}OFF{/}';
      lines.push(`  ${enabled}  {yellow-fg}${p.type || 'general'}{/}  /${p.regex || ''}/`);
      if (p.reason) lines.push(`    {gray-fg}Reason: ${p.reason}{/}`);
    }
  }

  setContent('Solve - Suppressions', lines.join('\n'));
}

// ─── Key bindings ─────────────────────────────────────────────────────────────
screen.key(['q', 'C-c'], () => { screen.destroy(); process.exit(0); });
screen.key(['C-l'], () => showEventLog());
screen.key(['f1'], () => switchModule(0));
screen.key(['f2'], () => switchModule(1));
screen.key(['f3'], () => switchModule(2));
screen.key(['f4'], () => switchModule(3));
screen.key(['f5'], () => switchModule(4));
screen.key(['C-\\'], () => {
  if (activeModuleIdx === 3 && activeSessionIdx >= 0) {
    menuList.focus();
  }
});
screen.key(['tab'], () => switchModule((activeModuleIdx + 1) % MODULES.length));
screen.key(['S-tab'], () => switchModule((activeModuleIdx - 1 + MODULES.length) % MODULES.length));
screen.key(['r'], () => {
  const item = MODULES[activeModuleIdx].items[menuList.selected];
  if (item) dispatch(item.action);
});
screen.key(['u'], () => dispatch('update-agents'));
screen.key(['/'], async () => {
  // Filter shortcut: only active in Reqs module when browsing
  if (activeModuleIdx !== 1) return;
  const { requirements } = reqCore.readRequirementsJson();
  if (!requirements.length) return;
  const categories = reqCore.getUniqueCategories(requirements);
  const statuses   = [...new Set(requirements.map(r => r.status || 'Unknown'))].sort();
  try {
    const filterChoice = await promptList({ title: 'Filter', items: [
      { label: 'All',         value: 'all'      },
      { label: 'By Category', value: 'category' },
      { label: 'By Status',   value: 'status'   },
      { label: 'Search',      value: 'search'   },
    ] });
    let filters = {};
    if (filterChoice.value === 'category') {
      const catChoice = await promptList({ title: 'Category', items: categories.map(c => ({ label: c, value: c })) });
      filters.category = catChoice.value;
    } else if (filterChoice.value === 'status') {
      const statusChoice = await promptList({ title: 'Status', items: statuses.map(s => ({ label: s, value: s })) });
      filters.status = statusChoice.value;
    } else if (filterChoice.value === 'search') {
      const term = await promptInput({ title: 'Search', prompt: 'Search text (id or description):' });
      if (term) filters.search = term;
    }
    const filtered = reqCore.filterRequirements(requirements, filters);
    renderReqList(filtered, filters);
  } catch (_) { /* cancelled */ }
  menuList.focus();
});
menuList.on('select', (_, idx) => {
  const item = MODULES[activeModuleIdx].items[idx];
  if (item) dispatch(item.action);
});
menuList.key(['space'], () => {
  const idx = menuList.selected;
  const item = MODULES[activeModuleIdx].items[idx];
  if (item) dispatch(item.action);
});

// ─── Target path shortcut [C-t] ──────────────────────────────────────────────
screen.key(['C-t'], async () => {
  try {
    const newPath = await promptInput({
      title: 'Target Path',
      prompt: 'Project working directory:',
      default: getTargetPath(),
    });
    if (!newPath) return;
    const resolved = path.resolve(newPath);
    if (!fs.existsSync(resolved)) {
      toast(`Path does not exist: ${resolved}`, true);
      return;
    }
    targetPath = resolved;
    renderHeader();
    refreshStatusBar();
    toast(`Target → ${resolved}`);
  } catch (_) { /* cancelled */ }
});

// ─── Background update notice ─────────────────────────────────────────────────
const UPDATE_AGENTS_IDX = MODULES[0].items.findIndex(m => m.action === 'update-agents');

function applyUpdateBadge(outdatedCount) {
  // Status bar: show stats + optional update notice
  if (outdatedCount > 0) {
    const n = outdatedCount;
    refreshStatusBar(`{#888800-fg}⚑ ${n} update${n > 1 ? 's' : ''} available — press [u]{/}`);
  } else {
    refreshStatusBar();
  }
  // Menu item badge (only when Agents module is active)
  if (activeModuleIdx === 0 && UPDATE_AGENTS_IDX >= 0) {
    const base = '  Update Agents';
    menuList.setItem(UPDATE_AGENTS_IDX, outdatedCount > 0
      ? `${base}  {yellow-fg}(${outdatedCount}↑){/}`
      : base
    );
  }
  screen.render();
}

// Fire on startup — non-blocking, never throws
// skipGh=true: avoids spawning `gh` which reads macOS keychain for GitHub auth
(async () => {
  try {
    const statuses = await getUpdateStatuses({ skipGh: true });
    const outdated = [...statuses.values()].filter(s => s.status === 'update-available').length;
    applyUpdateBadge(outdated);
  } catch (_) {}
  // PLCY-03: auto-update policy check for slots configured as 'auto'
  runAutoUpdateCheck().catch(() => {});
})();

// ─── Start ────────────────────────────────────────────────────────────────────
// NF_TEST_MODE skips TUI startup in unit tests. Can't use require.main === module
// because nforma-cli.js require()'s this file, making require.main the CLI, not us.
if (!process.env.NF_TEST_MODE) {
  renderHeader();
  // Restore persisted session counter so IDs don't collide
  const _persisted = loadPersistedSessions();
  if (_persisted.length > 0) {
    sessionIdCounter = Math.max(..._persisted.map(p => p.id));
  }
  refreshSessionMenu();
  switchModule(0);
  const warns = _logEntries.filter(e => e.level === 'warn' || e.level === 'error');
  if (warns.length) {
    refreshStatusBar(`{yellow-fg}⚠ ${warns.length} warning${warns.length > 1 ? 's' : ''} — [C-l] event log{/}`);
  } else {
    refreshStatusBar();
  }
  renderList();
  screen.on('resize', () => { renderHeader(); refreshStatusBar(); renderList(); });
  screen.render();

  // Default target path: prefer repo root (one level up from bin/) over raw cwd.
  // This ensures `node bin/nForma.cjs` resolves to the project root regardless
  // of whether the user ran it from the repo root or the bin/ directory.
  if (!targetPath) {
    const cwd = process.cwd();
    const parentOfBin = path.dirname(__dirname);
    // If cwd is the bin/ directory itself, use the parent (repo root)
    if (path.basename(cwd) === 'bin' && cwd === __dirname) {
      targetPath = parentOfBin;
    } else {
      targetPath = cwd;
    }
    renderHeader();
  }
}

// ─── Exports (pure functions for testing) ────────────────────────────────────
module.exports._pure = {
  pad,
  readProvidersJson,
  writeProvidersJson,
  writeUpdatePolicy,
  agentRows,
  buildScoreboardLines,
  PROVIDER_KEY_NAMES,
  PROVIDER_PRESETS,
  MENU_ITEMS,
  MODULES,
  logEvent,
  _logEntries,
  loadPersistedSessions,
  savePersistedSessions,
  removePersistedSession,
  SESSIONS_FILE,
  deriveProviderName,
  buildHeaderInfo,
  readProjectConfig,
  writeProjectConfig,
  getTargetPath,
  get targetPath() { return targetPath; },
  set targetPath(v) { targetPath = v; },
  // Async solve worker wrappers (for testing)
  sweepAsync,
  loadSweepDataAsync,
  classifyAsync,
  batchSweepAsync,
  SOLVE_WORKER_PATH,
};
