'use strict';

/**
 * auth-drivers/gh-cli.cjs — GitHub CLI keychain driver
 *
 * Accounts live in the macOS/system keychain managed by gh.
 * There is no credential file to copy — all operations delegate to gh.
 * This is the single source of truth for gh auth status parsing,
 * replacing duplicated regex in nf.cjs and gh-account-rotate.cjs.
 *
 * Applies to: copilot-1
 *
 * Required providers.json fields:
 *   auth.login  — add command (e.g. ["gh", "auth", "login"])
 */

const { spawnSync } = require('child_process');

/**
 * parseGhStatus() → { accounts: string[], active: string | null }
 * Single authoritative parser for `gh auth status` output.
 * gh writes to stderr; we merge both streams.
 */
function parseGhStatus() {
  const r   = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout || '') + (r.stderr || '');

  const accounts = [];
  let active = null;
  let last   = null;

  for (const line of out.split('\n')) {
    const m = line.match(/account (\S+)/);
    if (m) last = m[1];
    if (/Logged in to github\.com account/.test(line) && last && !accounts.includes(last)) {
      accounts.push(last);
    }
    if (/Active account:\s*true/.test(line) && last && accounts.includes(last)) {
      active = last;
    }
  }

  return { accounts, active };
}

/**
 * list(provider) → [{ name, active }]
 */
function list(_provider) {
  const { accounts, active } = parseGhStatus();
  return accounts.map(name => ({ name, active: name === active }));
}

/**
 * switch(provider, name) — calls gh auth switch (non-interactive, stays in TUI).
 */
function switchAccount(_provider, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('gh auth switch: account name must be a non-empty string');
  }
  const r = spawnSync('gh', ['auth', 'switch', '--user', name, '--hostname', 'github.com'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'gh auth switch failed').trim());
  }
}

/**
 * addCredentialFile() → null
 * gh stores credentials in the OS keychain — no file to poll.
 * promptLoginExternal will wait for manual [Enter] confirmation.
 */
function addCredentialFile(_provider) {
  return null;
}

/**
 * extractAccountName() → null
 * Cannot auto-detect from a file. TUI will not prompt for a name either —
 * gh manages account identity internally; the new account will appear in
 * the next `gh auth status` call.
 */
function extractAccountName(_provider) {
  return null;
}

/**
 * add() — no-op: gh auth login handles everything internally.
 * The account appears automatically in parseGhStatus() after login.
 */
async function add(_provider, _name) {
  // gh manages account storage; nothing to capture.
}

module.exports = { list, switch: switchAccount, addCredentialFile, extractAccountName, add, parseGhStatus };
