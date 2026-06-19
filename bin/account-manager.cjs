#!/usr/bin/env node
'use strict';

/**
 * account-manager.cjs — OAuth account pool manager for nForma providers
 *
 * Manages multiple OAuth credentials for providers with oauth_rotation config.
 * The implementation is a state machine that directly mirrors
 * .planning/formal/tla/NFAccountManager.tla — each TLA+ action is one FSM event.
 *
 * Usage:
 *   node bin/account-manager.cjs add --login [--name alias] [--provider gemini-1]
 *   node bin/account-manager.cjs add --name user@gmail.com [--provider gemini-1]
 *   node bin/account-manager.cjs list       [--provider gemini-1]
 *   node bin/account-manager.cjs switch next|prev|<name>|<N>  [--provider gemini-1]
 *   node bin/account-manager.cjs remove <name>  [--provider gemini-1]
 *   node bin/account-manager.cjs status    [--provider gemini-1]
 *
 * Credential layout (configurable via oauth_rotation in providers.json):
 *   active_file  — ~/.gemini/oauth_creds.json  (the live credential Gemini CLI reads)
 *   creds_dir    — ~/.gemini/accounts/          (pool: one .json per account)
 *   active_ptr   — ~/.gemini/accounts/.nf-active  (sidecar: name of active account)
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const { loadProviders } = require('./resolve-providers.cjs');

// ─── FSM states and events (mirrors NFAccountManager.tla) ──────────────────

const S = Object.freeze({
  IDLE:      'IDLE',
  ADDING:    'ADDING',
  SAVING:    'SAVING',
  SWITCHING: 'SWITCHING',
  REMOVING:  'REMOVING',
  ERROR:     'ERROR',
});

const E = Object.freeze({
  ADD:           'ADD',
  OAUTH_SUCCESS: 'OAUTH_SUCCESS',
  OAUTH_FAIL:    'OAUTH_FAIL',
  WRITE_OK:      'WRITE_OK',
  WRITE_FAIL:    'WRITE_FAIL',
  SWITCH:        'SWITCH',
  SWAP_OK:       'SWAP_OK',
  SWAP_FAIL:     'SWAP_FAIL',
  REMOVE:        'REMOVE',
  RM_OK:         'RM_OK',
  RM_FAIL:       'RM_FAIL',
  RESET:         'RESET',
});

// Transition table derived from NFAccountManager.tla Next relation.
// TRANSITIONS[currentState][event] = nextState
const TRANSITIONS = {
  [S.IDLE]: {
    [E.ADD]:    S.ADDING,
    [E.SWITCH]: S.SWITCHING,
    [E.REMOVE]: S.REMOVING,
  },
  [S.ADDING]: {
    [E.OAUTH_SUCCESS]: S.SAVING,
    [E.OAUTH_FAIL]:    S.ERROR,
  },
  [S.SAVING]: {
    [E.WRITE_OK]:   S.IDLE,
    [E.WRITE_FAIL]: S.ERROR,
  },
  [S.SWITCHING]: {
    [E.SWAP_OK]:   S.IDLE,
    [E.SWAP_FAIL]: S.ERROR,
  },
  [S.REMOVING]: {
    [E.RM_OK]:   S.IDLE,
    [E.RM_FAIL]: S.ERROR,
  },
  [S.ERROR]: {
    [E.RESET]: S.IDLE,
  },
};

class AccountManagerFSM {
  constructor() {
    this.state     = S.IDLE;
    this.pendingOp = null;  // { type: string, target: string } — mirrors TLA+ pending_op
    this.errorMsg  = null;
  }

  // send(event, payload?) — drives the FSM one step.
  // Mutates this.state and this.pendingOp per the transition table.
  // Throws on invalid transitions (maps to TLA+ TypeOK violation).
  send(event, payload = {}) {
    const next = TRANSITIONS[this.state]?.[event];
    if (!next) throw new Error(`[FSM] Invalid: ${this.state} + ${event}`);

    if (payload.target !== undefined) {
      this.pendingOp = { type: event, target: payload.target };
    }
    if (next === S.IDLE)  { this.pendingOp = null; this.errorMsg = null; }
    if (next === S.ERROR) { this.errorMsg = payload.error ?? 'unknown error'; }
    this.state = next;
    return this;
  }
}

// ─── Provider resolution ──────────────────────────────────────────────────────

function expandHome(p) {
  return typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function findProviders() {
  // Single source of truth: resolve-providers.cjs (issue #197/#218). The canonical
  // installed path is ~/.claude/nf-bin/providers.json (`'.claude', 'nf-bin', 'providers.json'`).
  const providers = loadProviders({ baseDir: __dirname });
  return (Array.isArray(providers) && providers.length > 0) ? providers : null;
}

function resolveProvider(providerArg) {
  const providers = findProviders();
  if (!providers) die('Could not find providers.json');
  if (providerArg) {
    const p = providers.find(p => p.name === providerArg);
    if (!p)               die(`Unknown provider: ${providerArg}`);
    if (!p.oauth_rotation) die(`Provider "${providerArg}" has no oauth_rotation config`);
    return p;
  }
  const p = providers.find(p => p.oauth_rotation?.enabled);
  if (!p) die('No OAuth-enabled provider found in providers.json');
  return p;
}

// ─── Login + identity helpers ─────────────────────────────────────────────────

// Spawns the provider's login command with fully inherited stdio so the browser
// redirect URL and confirmation prompts appear inline in the user's terminal.
// Uses auth_check.login_args from providers.json (e.g. ["login"] for codex,
// ["auth", "login"] for gemini). Falls back to ["auth", "login"] if not set.
function spawnInteractiveLogin(provider) {
  const loginArgs = provider.auth_check?.login_args ?? ['auth', 'login'];
  return new Promise((resolve, reject) => {
    console.log(`\n  Launching ${provider.cli} ${loginArgs.join(' ')} …\n`);
    const child = spawn(provider.cli, loginArgs, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${provider.cli} ${loginArgs.join(' ')} exited ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
}

// Extracts account identity from credential files (no network call).
// Supports multiple formats:
//   - Gemini: id_token JWT → payload.email
//   - Codex:  tokens.access_token JWT → payload.email, or OPENAI_API_KEY prefix
function extractEmailFromCreds(activeFile) {
  try {
    const creds = JSON.parse(fs.readFileSync(activeFile, 'utf8'));

    // Try id_token first (Gemini format)
    if (creds.id_token) {
      const payload = Buffer.from(creds.id_token.split('.')[1], 'base64url').toString('utf8');
      const email = JSON.parse(payload).email;
      if (email) return email;
    }

    // Try nested tokens (Codex format: { tokens: { id_token, access_token, ... } })
    // id_token contains the email; access_token has sub but no email
    for (const key of ['id_token', 'access_token']) {
      const jwt = creds.tokens?.[key];
      if (jwt && jwt.includes('.')) {
        try {
          const payload = Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8');
          const parsed = JSON.parse(payload);
          if (parsed.email) return parsed.email;
          if (parsed.sub) return parsed.sub;
        } catch (_) { /* not a JWT, continue */ }
      }
    }

    return null;
  } catch (_) { return null; }
}

// ─── Credential pool helpers ──────────────────────────────────────────────────

function getCredsDir(provider) {
  return expandHome(provider.oauth_rotation?.creds_dir ?? '~/.gemini/accounts');
}

function getActiveFile(provider) {
  return expandHome(provider.oauth_rotation?.active_file ?? '~/.gemini/oauth_creds.json');
}

// Sidecar pointer file — stores just the account name of the current active.
// Avoids content-diffing which breaks when tokens are silently refreshed.
function getActivePtr(credsDir) {
  return path.join(credsDir, '.nf-active');
}

function listPool(credsDir) {
  if (!fs.existsSync(credsDir)) return [];
  return fs.readdirSync(credsDir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.nf-'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

function readActivePtr(credsDir) {
  const ptr = getActivePtr(credsDir);
  if (!fs.existsSync(ptr)) return null;
  return fs.readFileSync(ptr, 'utf8').trim() || null;
}

function writeActivePtr(credsDir, name) {
  fs.mkdirSync(credsDir, { recursive: true });
  fs.writeFileSync(getActivePtr(credsDir), name, 'utf8');
}

function clearActivePtr(credsDir) {
  const ptr = getActivePtr(credsDir);
  if (fs.existsSync(ptr)) fs.rmSync(ptr);
}

// ─── Tier metadata ─────────────────────────────────────────────────────────────
// Stored as .nf-tiers.json in the pool directory: { "user@example.com": "subscribed" }
// Valid tiers: "subscribed" (paid quota), "free" (limited/no quota)
// Accounts without a tier entry default to "subscribed" (optimistic).

function getTiersFile(credsDir) {
  return path.join(credsDir, '.nf-tiers.json');
}

function readTiers(credsDir) {
  const f = getTiersFile(credsDir);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return {}; }
}

function writeTiers(credsDir, tiers) {
  fs.writeFileSync(getTiersFile(credsDir), JSON.stringify(tiers, null, 2) + '\n', 'utf8');
}

function getAccountTier(credsDir, name) {
  return readTiers(credsDir)[name] ?? 'subscribed';
}

function setAccountTier(credsDir, name, tier) {
  const tiers = readTiers(credsDir);
  tiers[name] = tier;
  writeTiers(credsDir, tiers);
}

// Returns pool sorted by tier: subscribed first, then free. Skip accounts excluded.
// Within each tier group, original alphabetical order is preserved.
// Valid tiers: "subscribed" (paid), "free" (limited), "skip" (never use in rotation)
function listPoolByTier(credsDir) {
  const pool  = listPool(credsDir);
  const tiers = readTiers(credsDir);
  const subscribed = pool.filter(n => (tiers[n] ?? 'subscribed') === 'subscribed');
  const free       = pool.filter(n => tiers[n] === 'free');
  // skip accounts are excluded from rotation entirely
  return { subscribed, free, ordered: [...subscribed, ...free] };
}

// ─── Commands (each drives the FSM through the appropriate TLA+ action sequence)

// add: StartAdd → OAuthSuccess → SaveOk  (or OAuthFail / SaveFail → ERROR)
//
// Two modes:
//   --login     Spawns `<provider.cli> auth login` inline (inherited stdio),
//               then auto-extracts email from the id_token JWT. No --name needed.
//   (no flag)   Captures the current active credential. --name is required.
async function cmdAdd(fsm, provider, nameArg, doLogin) {
  const credsDir   = getCredsDir(provider);
  const activeFile = getActiveFile(provider);

  // Placeholder target for the FSM until we know the real name
  fsm.send(E.ADD, { target: nameArg ?? '__pending__' });  // IDLE → ADDING

  if (doLogin) {
    try {
      await spawnInteractiveLogin(provider);
    } catch (err) {
      fsm.send(E.OAUTH_FAIL, { error: err.message });
      die(`Login failed: ${fsm.errorMsg}`);
    }
  } else if (!fs.existsSync(activeFile)) {
    fsm.send(E.OAUTH_FAIL, { error: `Active credential not found: ${activeFile}` });
    die(`${fsm.errorMsg}\n  Run with --login to authenticate, or run \`${provider.cli} auth login\` first.`);
  }

  // Resolve name: explicit --name overrides auto-detection
  const name = nameArg ?? extractEmailFromCreds(activeFile);
  if (!name) {
    fsm.send(E.OAUTH_FAIL, { error: 'Could not detect email from id_token' });
    die(`${fsm.errorMsg}\n  Re-run with --name <email> to set the account name manually.`);
  }

  if (doLogin) console.log(`  Detected account: ${name}`);
  fsm.send(E.OAUTH_SUCCESS);                              // ADDING → SAVING

  try {
    fs.mkdirSync(credsDir, { recursive: true });
    const dest = path.join(credsDir, `${name}.json`);
    if (fs.existsSync(dest)) {
      process.stderr.write(`  [warn] Pool already contains "${name}" — overwriting.\n`);
    }
    fs.copyFileSync(activeFile, dest);

    const pool           = listPool(credsDir);
    const isFirstAccount = pool.length === 1;            // pool now contains this file
    if (isFirstAccount || readActivePtr(credsDir) === null) {
      writeActivePtr(credsDir, name);
    } else if (doLogin) {
      // --login flow: newly added account becomes active (user just authenticated it)
      writeActivePtr(credsDir, name);
    }

    fsm.send(E.WRITE_OK);                                 // SAVING → IDLE
    console.log(`  ✓ "${name}" added to pool`);
    if (readActivePtr(credsDir) === name) {
      console.log(`  ✓ Set as active account`);
    }
  } catch (err) {
    fsm.send(E.WRITE_FAIL, { error: err.message });
    die(`Save failed: ${fsm.errorMsg}`);
  }
}

// list: read-only, no FSM transitions needed
function cmdList(provider) {
  const credsDir = getCredsDir(provider);
  const pool     = listPool(credsDir);
  const active   = readActivePtr(credsDir);

  if (pool.length === 0) {
    console.log(`  (pool empty — run \`add --login\` to add your first account)`);
    return;
  }
  const tiers = readTiers(credsDir);
  console.log(`  OAuth pool for ${provider.name} (${provider.display_provider ?? provider.name}):`);
  pool.forEach((name, i) => {
    const marker = name === active ? '●' : ' ';
    const tier   = tiers[name] ?? 'subscribed';
    const tag    = tier === 'free' ? ' [free]' : tier === 'skip' ? ' [skip]' : '';
    console.log(`  ${marker} ${i + 1}. ${name}${tag}`);
  });
}

// switch: StartSwitch → SwapOk  (or SwapFail → ERROR)
function cmdSwitch(fsm, provider, target) {
  const credsDir   = getCredsDir(provider);
  const activeFile = getActiveFile(provider);
  const pool       = listPool(credsDir);

  if (pool.length === 0) die('Pool is empty — nothing to switch to');

  let targetName;
  if (target === 'next' || target === 'prev') {
    const active = readActivePtr(credsDir);
    if (pool.length === 1) {
      console.log(`  (only one account in pool — already on "${pool[0]}")`);
      return;
    }
    // Tier-aware rotation: cycle within subscribed accounts first.
    // Only spill into free accounts when all subscribed are exhausted.
    const { subscribed, ordered } = listPoolByTier(credsDir);
    const tierPool = subscribed.length > 1 ? subscribed
                   : subscribed.length === 1 && subscribed[0] !== active ? subscribed
                   : ordered;  // fallback: all accounts
    const idx = active ? tierPool.indexOf(active) : -1;
    const effectiveIdx = idx === -1 ? 0 : idx;
    targetName = target === 'next'
      ? tierPool[(effectiveIdx + 1) % tierPool.length]
      : tierPool[(effectiveIdx - 1 + tierPool.length) % tierPool.length];
  } else if (/^\d+$/.test(target)) {
    const idx = parseInt(target, 10) - 1;
    if (idx < 0 || idx >= pool.length) die(`Index ${target} out of range (1–${pool.length})`);
    targetName = pool[idx];
  } else {
    if (!pool.includes(target)) die(`Account "${target}" not in pool`);
    targetName = target;
  }

  fsm.send(E.SWITCH, { target: targetName });             // IDLE → SWITCHING

  try {
    fs.copyFileSync(path.join(credsDir, `${targetName}.json`), activeFile);
    writeActivePtr(credsDir, targetName);
    fsm.send(E.SWAP_OK);                                  // SWITCHING → IDLE
    console.log(`  ✓ Switched to "${targetName}"`);
  } catch (err) {
    fsm.send(E.SWAP_FAIL, { error: err.message });
    die(`Switch failed: ${fsm.errorMsg}`);
  }
}

// remove: StartRemove → RemoveOk  (or RemoveFail → ERROR)
function cmdRemove(fsm, provider, name) {
  const credsDir   = getCredsDir(provider);
  const activeFile = getActiveFile(provider);
  const pool       = listPool(credsDir);

  if (!pool.includes(name)) die(`Account "${name}" not in pool`);

  fsm.send(E.REMOVE, { target: name });                   // IDLE → REMOVING

  try {
    const active    = readActivePtr(credsDir);
    const remaining = pool.filter(a => a !== name);

    // If removing active account, rotate to next remaining (mirrors TLA+ RemoveOk CHOOSE)
    if (active === name) {
      if (remaining.length > 0) {
        const next = remaining[0];
        fs.copyFileSync(path.join(credsDir, `${next}.json`), activeFile);
        writeActivePtr(credsDir, next);
        console.log(`  → Rotated active to "${next}"`);
      } else {
        clearActivePtr(credsDir);
        console.log(`  ⚠  Removed last account — active credential unchanged on disk`);
      }
    }

    fs.rmSync(path.join(credsDir, `${name}.json`));
    fsm.send(E.RM_OK);                                    // REMOVING → IDLE
    console.log(`  ✓ Removed "${name}" from pool`);
  } catch (err) {
    fsm.send(E.RM_FAIL, { error: err.message });
    die(`Remove failed: ${fsm.errorMsg}`);
  }
}

// status: read-only
function cmdStatus(provider) {
  const credsDir   = getCredsDir(provider);
  const activeFile = getActiveFile(provider);
  const pool       = listPool(credsDir);
  const active     = readActivePtr(credsDir);
  const rot        = provider.oauth_rotation;

  console.log(`  Provider    : ${provider.name} (${provider.display_provider ?? provider.name})`);
  console.log(`  Pool dir    : ${credsDir} (${pool.length} account${pool.length !== 1 ? 's' : ''})`);
  console.log(`  Active      : ${active ?? '(none)'}`);
  console.log(`  Active file : ${activeFile} ${fs.existsSync(activeFile) ? '✓' : '✗ missing'}`);
  console.log(`  Max retries : ${rot?.max_retries ?? 3}`);
  console.log(`  Rotate cmd  : ${(rot?.rotate_cmd ?? []).join(' ')}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// ─── TUI ──────────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
};


function printAccountsHeader(provider, pool, active) {
  const tag    = `nForma · Accounts · ${provider.name}  ·  ${provider.display_provider ?? ''}`;
  const border = '─'.repeat(tag.length + 4);
  console.log('');
  console.log(`  ${C.cyan}╭${border}╮${C.reset}`);
  console.log(`  ${C.cyan}│${C.reset}  ${C.bold}${tag}${C.reset}  ${C.cyan}│${C.reset}`);
  console.log(`  ${C.cyan}╰${border}╯${C.reset}`);
  console.log('');
  if (pool.length === 0) {
    console.log(`  ${C.dim}  (pool is empty)${C.reset}`);
  } else {
    pool.forEach((name, i) => {
      const isActive = name === active;
      const dot      = isActive ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
      const label    = isActive
        ? `${C.bold}${name}${C.reset}  ${C.dim}(active)${C.reset}`
        : `${C.dim}${name}${C.reset}`;
      console.log(`    ${dot}  ${i + 1}. ${label}`);
    });
  }
  console.log('');
}

async function tuiFlowAdd(provider, inquirer) {
  const { doLogin } = await inquirer.prompt([{
    type:    'confirm',
    name:    'doLogin',
    message: 'Launch Google OAuth login? (opens a browser)',
    default: true,
    prefix:  ' ',
  }]);
  if (!doLogin) return;

  try {
    await spawnInteractiveLogin(provider);
  } catch (err) {
    console.log(`\n  ${C.red}✗${C.reset}  Login failed: ${err.message}`);
    return;
  }

  const detectedEmail = extractEmailFromCreds(getActiveFile(provider));
  let name;

  if (detectedEmail) {
    console.log(`\n  ${C.green}✓${C.reset}  Detected: ${C.bold}${detectedEmail}${C.reset}`);
    const { useDetected } = await inquirer.prompt([{
      type:    'confirm',
      name:    'useDetected',
      message: `Save as "${detectedEmail}"?`,
      default: true,
      prefix:  ' ',
    }]);
    if (useDetected) {
      name = detectedEmail;
    } else {
      const { alias } = await inquirer.prompt([{
        type:    'input',
        name:    'alias',
        message: 'Enter an alias for this account:',
        prefix:  ' ',
      }]);
      name = alias.trim();
    }
  } else {
    const { alias } = await inquirer.prompt([{
      type:    'input',
      name:    'alias',
      message: 'Could not detect email — enter a name for this account:',
      prefix:  ' ',
    }]);
    name = alias.trim();
  }

  if (!name) { console.log(`  ${C.yellow}⚠${C.reset}  Cancelled`); return; }

  const credsDir = getCredsDir(provider);
  if (listPool(credsDir).includes(name)) {
    const { overwrite } = await inquirer.prompt([{
      type:    'confirm',
      name:    'overwrite',
      message: `"${name}" already in pool — overwrite?`,
      default: false,
      prefix:  ' ',
    }]);
    if (!overwrite) return;
  }

  // Drive FSM through the same transitions as cmdAdd (IDLE→ADDING→SAVING→IDLE)
  // so all TLA+ invariants (ActiveIsPoolMember, NoActiveWhenEmpty) are enforced.
  const fsm = new AccountManagerFSM();
  fsm.send(E.ADD, { target: name });           // IDLE → ADDING (name now resolved)
  fsm.send(E.OAUTH_SUCCESS);                   // ADDING → SAVING (login already done)

  try {
    const credsDir   = getCredsDir(provider);
    const activeFile = getActiveFile(provider);
    fs.mkdirSync(credsDir, { recursive: true });
    fs.copyFileSync(activeFile, path.join(credsDir, `${name}.json`));
    const pool    = listPool(credsDir);
    const isFirst = pool.length === 1;
    if (isFirst || readActivePtr(credsDir) === null) writeActivePtr(credsDir, name);
    else writeActivePtr(credsDir, name);        // TUI add-with-login → new account is active
    fsm.send(E.WRITE_OK);                       // SAVING → IDLE
    console.log(`\n  ${C.green}✓${C.reset}  "${name}" added to pool`);
    if (readActivePtr(credsDir) === name) console.log(`  ${C.green}✓${C.reset}  Set as active account`);
  } catch (err) {
    fsm.send(E.WRITE_FAIL, { error: err.message });  // SAVING → ERROR
    console.log(`\n  ${C.red}✗${C.reset}  Save failed: ${err.message}`);
  }
}

async function tuiFlowSwitch(provider, pool, active, inquirer) {
  const choices = pool.map(name => ({
    name:  name === active
             ? `${name}  ${C.dim}(active)${C.reset}`
             : `${C.dim}${name}${C.reset}`,
    value: name,
  }));
  choices.push(new inquirer.Separator('  ─────────────────────────────'));
  choices.push({ name: `  ${C.dim}Cancel${C.reset}`, value: null });

  const { target } = await inquirer.prompt([{
    type:     'list',
    name:     'target',
    message:  'Switch to',
    choices,
    prefix:   ' ',
    pageSize: 15,
  }]);

  if (!target || target === active) return;

  // Drive FSM through IDLE→SWITCHING→IDLE, same as cmdSwitch,
  // so ActiveIsPoolMember is preserved on partial failures.
  const fsm        = new AccountManagerFSM();
  const credsDir   = getCredsDir(provider);
  const activeFile = getActiveFile(provider);
  fsm.send(E.SWITCH, { target });              // IDLE → SWITCHING

  try {
    fs.copyFileSync(path.join(credsDir, `${target}.json`), activeFile);
    writeActivePtr(credsDir, target);
    fsm.send(E.SWAP_OK);                       // SWITCHING → IDLE
    console.log(`\n  ${C.green}✓${C.reset}  Switched to ${C.bold}"${target}"${C.reset}`);
  } catch (err) {
    fsm.send(E.SWAP_FAIL, { error: err.message }); // SWITCHING → ERROR
    console.log(`\n  ${C.red}✗${C.reset}  Switch failed: ${err.message}`);
  }
}

async function tuiFlowRemove(provider, pool, active, inquirer) {
  const choices = pool.map(name => ({
    name:  name === active
             ? `${name}  ${C.dim}(active)${C.reset}`
             : `${C.dim}${name}${C.reset}`,
    value: name,
  }));
  choices.push(new inquirer.Separator('  ─────────────────────────────'));
  choices.push({ name: `  ${C.dim}Cancel${C.reset}`, value: null });

  const { target } = await inquirer.prompt([{
    type:     'list',
    name:     'target',
    message:  'Remove which account?',
    choices,
    prefix:   ' ',
    pageSize: 15,
  }]);
  if (!target) return;

  const { confirm } = await inquirer.prompt([{
    type:    'confirm',
    name:    'confirm',
    message: `Remove "${target}" from pool permanently?`,
    default: false,
    prefix:  ' ',
  }]);
  if (!confirm) return;

  const fsm = new AccountManagerFSM();
  cmdRemove(fsm, provider, target);
}

async function runTUI(provider) {
  const inquirer = require('inquirer');

  while (true) {
    const credsDir = getCredsDir(provider);
    const pool     = listPool(credsDir);
    const active   = readActivePtr(credsDir);

    process.stdout.write('\x1Bc');
    printAccountsHeader(provider, pool, active);

    const choices = [
      { name: `  ${C.green}+${C.reset}  Add account`, value: 'add' },
    ];
    if (pool.length > 1) choices.push({ name: `  ${C.cyan}↕${C.reset}  Switch account`, value: 'switch' });
    if (pool.length > 0) choices.push({ name: `  ${C.red}×${C.reset}  Remove account`, value: 'remove' });
    choices.push(new inquirer.Separator('  ─────────────────────────────'));
    choices.push({ name: `  ${C.dim}Exit${C.reset}`, value: 'exit' });

    const { action } = await inquirer.prompt([{
      type:     'list',
      name:     'action',
      message:  'Action',
      choices,
      prefix:   ' ',
      pageSize: 10,
    }]);

    if (action === 'exit') { process.stdout.write('\x1Bc'); break; }

    console.log('');
    try {
      if (action === 'add')    await tuiFlowAdd(provider, inquirer);
      if (action === 'switch') await tuiFlowSwitch(provider, pool, active, inquirer);
      if (action === 'remove') await tuiFlowRemove(provider, pool, active, inquirer);
    } catch (err) {
      console.log(`\n  ${C.red}✗${C.reset}  ${err.message}`);
    }

    console.log('');
    await inquirer.prompt([{
      type:    'input',
      name:    '_',
      message: `${C.dim}Press Enter to continue${C.reset}`,
      prefix:  ' ',
    }]);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function die(msg) {
  process.stderr.write(`[account-manager] ${msg}\n`);
  process.exit(1);
}

function usage(prefix = 'node bin/account-manager.cjs') {
  console.log([
    `Usage: ${prefix} <command> [options]`,
    '',
    'Commands:',
    '  add --login [--name alias]    Authenticate inline and add to pool (recommended)',
    '  add --name <email>            Capture current active credential into pool',
    '  list                          Show pool accounts',
    '  switch <name|next|prev|N>     Switch active account (tier-aware)',
    '  remove <name>                 Remove account from pool',
    '  tier                          Show all account tiers',
    '  tier <name> <subscribed|free|skip> Set account tier',
    '  status                        Show provider and pool state',
    '',
    'Options:',
    '  --provider <slot>   Provider slot (default: first oauth_rotation-enabled provider)',
    '  --login             Spawn auth login inline; auto-detect email from id_token',
    '  --name <email>      Account name/email (overrides auto-detection)',
    '',
    'Formal spec: .planning/formal/tla/NFAccountManager.tla',
  ].join('\n'));
}

// ─── Exported entry point (called by nf.cjs) ─────────────────────────

async function run(argv, usagePrefix) {
  const getArg  = (f) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : null; };
  const command     = argv[0];
  const providerArg = getArg('--provider');
  const nameArg     = getArg('--name');
  const doLogin     = argv.includes('--login');

  if (!command || argv.includes('--help') || argv.includes('-h')) {
    usage(usagePrefix);
    return;
  }

  const provider = resolveProvider(providerArg);
  const fsm      = new AccountManagerFSM();

  switch (command) {
    case 'add':
      if (!doLogin && !nameArg) die('add requires --login or --name <email>');
      await cmdAdd(fsm, provider, nameArg, doLogin);
      break;

    case 'list':
      cmdList(provider);
      break;

    case 'switch': {
      const target = argv[1];
      if (!target) die('switch requires <name|next|prev|N>');
      cmdSwitch(fsm, provider, target);
      break;
    }

    case 'remove': {
      const target = argv[1];
      if (!target) die('remove requires <name>');
      cmdRemove(fsm, provider, target);
      break;
    }

    case 'tier': {
      // Extract positional args (skip --flag and their values)
      const positionals = [];
      for (let i = 1; i < argv.length; i++) {
        if (argv[i].startsWith('--')) { i++; continue; }  // skip --flag value
        positionals.push(argv[i]);
      }
      const target = positionals[0];
      const tierVal = positionals[1];
      if (!target) {
        // Show all tiers
        const credsDir = getCredsDir(provider);
        const pool = listPool(credsDir);
        const tiers = readTiers(credsDir);
        console.log(`  Account tiers for ${provider.name}:`);
        pool.forEach(name => {
          const t = tiers[name] ?? 'subscribed';
          console.log(`    ${name}: ${t}`);
        });
        break;
      }
      if (!tierVal || !['subscribed', 'free', 'skip'].includes(tierVal)) {
        die('tier requires: <account-name> <subscribed|free|skip>');
      }
      const cd = getCredsDir(provider);
      const pl = listPool(cd);
      if (!pl.includes(target)) die(`Account "${target}" not in pool`);
      setAccountTier(cd, target, tierVal);
      console.log(`  ✓ ${target} → ${tierVal}`);
      break;
    }

    case 'status':
      cmdStatus(provider);
      break;

    default:
      die(`Unknown accounts command: "${command}". Run with --help for usage.`);
  }
}

module.exports = { run, runTUI, resolveProvider };

// Allow direct invocation: node bin/account-manager.cjs <args>
if (require.main === module) {
  run(process.argv.slice(2)).catch(err => die(err.message));
}
