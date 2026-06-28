#!/usr/bin/env node
// hooks/nf-session-start.js
// SessionStart hook — syncs nForma keychain secrets into ~/.claude.json
// on every session start so mcpServers env blocks always reflect current keychain state.
//
// Runs synchronously (hook expects process to exit) — uses async IIFE with catch.

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

// ─── Stdin accumulation (for hook input JSON containing cwd) ─────────────────
// Only register stdin handler when run directly (not when require()'d by tests)
let _stdinRaw = '';
let _stdinPromise;
if (require.main === module) {
  let _stdinReady;
  _stdinPromise = new Promise(resolve => { _stdinReady = resolve; });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => _stdinRaw += c);
  process.stdin.on('end', () => _stdinReady());
} else {
  _stdinPromise = Promise.resolve();
}

// Locate secrets.cjs — try installed global path first, then local dev path.
//
// IMPORTANT: install.js copies bin/*.cjs to ~/.claude/nf-bin/ (not ~/.claude/nf/bin/).
// See bin/install.js line ~1679: binDest = path.join(targetDir, 'nf-bin')
// where targetDir = os.homedir() + '/.claude'.
function findSecrets() {
  try { return require(resolveBin('secrets.cjs')); } catch (_) { return null; }
}

// Locate memory-store.cjs via resolveBin (nf-bin installed path, then repo bin/).
function findMemoryStore() {
  try { return require(resolveBin('memory-store.cjs')); } catch (_) { return null; }
}

// ─── State reminder parser ──────────────────────────────────────────────────

/**
 * Parse STATE.md content for an in-progress phase and return a terse reminder.
 * Returns null if no reminder is needed (complete, not started, or missing fields).
 * @param {string} stateContent - Raw STATE.md content.
 * @returns {string|null}
 */
function parseStateForReminder(stateContent) {
  if (!stateContent || typeof stateContent !== 'string') return null;

  const phaseMatch = stateContent.match(/Phase:[ \t]*(.+)/);
  const statusMatch = stateContent.match(/Status:[ \t]*(.+)/);
  const planMatch = stateContent.match(/Plan:[ \t]*(.+)/);
  const lastMatch = stateContent.match(/Last activity:[ \t]*(.+)/);

  if (!phaseMatch) return null;
  if (!statusMatch) return null;

  const status = statusMatch[1].trim();
  if (status === 'Complete' || status === 'Not started') return null;

  const phase = phaseMatch[1].trim();
  const plan = planMatch ? planMatch[1].trim() : 'unknown plan';
  const lastActivity = lastMatch ? lastMatch[1].trim() : 'unknown';

  return 'SESSION STATE REMINDER: Phase ' + phase + ' -- ' + plan + ' -- ' + status + ' (last: ' + lastActivity + ')';
}

if (require.main === module) (async () => {
  // Resolve project cwd from hook input JSON
  await _stdinPromise;
  let _hookCwd = process.cwd();
  let _parsedInput = null;
  // NOTE: Never write to process.stderr in hooks — Claude Code treats any stderr as a hook error.
  try { _parsedInput = JSON.parse(_stdinRaw); _hookCwd = _parsedInput.cwd || process.cwd(); } catch (e) {
    // Fail-open: malformed JSON is non-fatal
  }
  if (_parsedInput) {
    const _eventType = _parsedInput.hook_event_name || _parsedInput.hookEventName || 'SessionStart';
    const _validation = validateHookInput(_eventType, _parsedInput);
    if (!_validation.valid) {
      process.exit(0); // Fail-open
    }
  }

  // Profile guard — exit early if this hook is not active for the current profile
  const config = loadConfig(_hookCwd);
  const profile = config.hook_profile || 'standard';
  if (!shouldRunHook('nf-session-start', profile)) {
    process.exit(0);
  }

  const secrets = findSecrets();
  if (!secrets) {
    // silently skip — nForma may not be installed yet or secrets store absent
    process.exit(0);
  }
  try {
    await secrets.syncToClaudeJson(secrets.SERVICE);
  } catch (e) {
    // Non-fatal — fail silently (never write to stderr; Claude Code treats it as hook error)
  }

  // Populate CCR config from secrets store (fail-silent — CCR may not be installed)
  try {
    const { execFileSync } = require('child_process');
    const nodeFsRef = require('fs');
    const ccrConfigPath = resolveBin('ccr-secure-config.cjs');
    if (nodeFsRef.existsSync(ccrConfigPath)) {
      execFileSync(process.execPath, [ccrConfigPath], { stdio: 'pipe', timeout: 10000 });
    }
  } catch (e) {
    // Non-fatal — fail silently (never write to stderr; Claude Code treats it as hook error)
  }

  // Collect all additionalContext pieces — write once at the end
  const _contextPieces = [];

  // Post-compaction continuation context (CONT-01).
  // nf-precompact persists rich resume context to this sidecar before compaction,
  // because the PreCompact event cannot inject additionalContext itself (the
  // harness rejects PreCompact hookSpecificOutput). We consume-and-delete it here,
  // injecting via the valid SessionStart channel. One-shot, fresh-only (6h), and
  // source-tolerant so it works whether the post-compaction event reports
  // source "compact"/"resume" or omits source entirely.
  try {
    const contPath = path.join(_hookCwd, '.claude', 'precompact-continuation.txt');
    // Symlink hardening: lstat (not stat) so a planted symlink is NOT followed —
    // a repo-controlled symlink here could otherwise leak an arbitrary file's
    // contents into additionalContext. Only inject from a regular file, and cap
    // the size so a huge file can't blow up the context budget. Always remove the
    // path afterwards (one-shot), including the rejected-symlink case.
    let _st = null;
    try { _st = fs.lstatSync(contPath); } catch (_) { _st = null; }
    if (_st) {
      const MAX = 64 * 1024; // 64KB cap
      const _ageMs = Date.now() - _st.mtimeMs;
      const _fresh = _ageMs >= 0 && _ageMs < 6 * 60 * 60 * 1000;
      const _src = _parsedInput && _parsedInput.source;
      const _wantInject = _src === 'compact' || _src === 'resume' || _src == null;
      if (_st.isFile() && _st.size <= MAX && _fresh && _wantInject) {
        const cont = fs.readFileSync(contPath, 'utf8').trim();
        if (cont) _contextPieces.push(cont);
      }
      // One-shot: delete regardless (stale / wrong-source / oversized / symlink).
      try { fs.unlinkSync(contPath); } catch (_) {}
    }
  } catch (_) {}

  // Telemetry surfacing — inject top unsurfaced issue as additionalContext
  // Guard: only active when running inside the nForma dev repo itself
  try {
    const pkgPath = path.join(_hookCwd, 'package.json');
    const isNfRepo = fs.existsSync(pkgPath) &&
      JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name === 'nforma';
    const fixesPath = path.join(_hookCwd, '.planning', 'telemetry', 'pending-fixes.json');
    if (isNfRepo && fs.existsSync(fixesPath)) {
      const fixes = JSON.parse(fs.readFileSync(fixesPath, 'utf8'));
      const issue = (Array.isArray(fixes.issues) ? fixes.issues : []).find(i => i && typeof i === 'object' && !i.surfaced && i.priority >= 50);
      if (issue) {
        issue.surfaced = true;
        issue.surfacedAt = new Date().toISOString();
        fs.writeFileSync(fixesPath, JSON.stringify(fixes, null, 2), 'utf8');
        _contextPieces.push('Telemetry alert [priority=' + issue.priority + ']: ' + issue.description + '\nSuggested fix: ' + issue.action);
      }
    }
  } catch (_) {}

  // Session state reminder — inject brief context when work is in progress
  try {
    const statePath = path.join(_hookCwd, '.planning', 'STATE.md');
    if (fs.existsSync(statePath)) {
      const stateContent = fs.readFileSync(statePath, 'utf8');
      const reminder = parseStateForReminder(stateContent);
      if (reminder) {
        _contextPieces.push(reminder);
      }
    }
  } catch (_) {}

  // Memory reminder injection (MEMP-02)
  try {
    const memStore = findMemoryStore();
    if (memStore && memStore.generateSessionReminder) {
      const hasTelemetry = _contextPieces.some(p => p.includes('Telemetry alert'));
      if (hasTelemetry && memStore.countEntries) {
        // Lower priority — shorten to one-liner when telemetry alert is present
        const dCount = memStore.countEntries(_hookCwd, 'decisions');
        const eCount = memStore.countEntries(_hookCwd, 'errors');
        const qCount = memStore.countEntries(_hookCwd, 'quorum');
        const sCount = memStore.countEntries ? memStore.countEntries(_hookCwd, 'skills') : 0;
        const fCount = memStore.countEntries ? memStore.countEntries(_hookCwd, 'failures') : 0;
        const cCount = memStore.countEntries ? memStore.countEntries(_hookCwd, 'corrections') : 0;
        if (dCount > 0 || eCount > 0 || qCount > 0) {
          let oneLiner = 'Memory available: ' + dCount + ' decisions, ' + eCount + ' errors, ' + qCount + ' quorum entries.';
          if (sCount > 0 || fCount > 0 || cCount > 0) {
            oneLiner += ' Learning: ' + sCount + ' skills, ' + fCount + ' failures, ' + cCount + ' corrections.';
          }
          oneLiner += ' Query: node bin/memory-store.cjs query-decisions --last 5';
          _contextPieces.push(oneLiner);
        }
      } else {
        const reminder = memStore.generateSessionReminder(_hookCwd);
        if (reminder) {
          _contextPieces.push(reminder);
        }

        // Learning catalog counts (LRNG-01, LRNG-04)
        if (memStore.countEntries) {
          const skillCount = memStore.countEntries(_hookCwd, 'skills');
          const failureCount = memStore.countEntries(_hookCwd, 'failures');
          const correctionCount = memStore.countEntries(_hookCwd, 'corrections');

          if (skillCount > 0 || failureCount > 0 || correctionCount > 0) {
            let learningLine = 'Learning catalog:';
            if (skillCount > 0) learningLine += ' ' + skillCount + ' validated skills,';
            if (failureCount > 0) learningLine += ' ' + failureCount + ' known failures,';
            if (correctionCount > 0) learningLine += ' ' + correctionCount + ' corrections.';
            learningLine += ' Query: node bin/memory-store.cjs query-failures --min-confidence 0.3';
            _contextPieces.push(learningLine);
          }
        }
      }
    }
  } catch (_) {}

  // Memory staleness check — surface outdated MEMORY.md entries via additionalContext
  // NOTE: Do NOT write to stderr here — Claude Code treats any stderr as a hook error.
  try {
    let validateMemoryMod = null;
    try { validateMemoryMod = require(resolveBin('validate-memory.cjs')); } catch (_) {}
    if (validateMemoryMod) {
      const { findings } = validateMemoryMod.validateMemory({ cwd: _hookCwd, quiet: true });
      if (findings.length > 0) {
        const summary = findings
          .map(f => '[memory-check] ' + f.message)
          .join('\n');
        _contextPieces.push(summary);
      }
    }
  } catch (_) {}

  // Write combined additionalContext output (once)
  if (_contextPieces.length > 0) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: _contextPieces.join('\n\n') }
    }));
  }

  // Fire-and-forget coderlm auto-start — keep coderlm warm so it's ready for quick/phase tasks.
  // Only runs if the binary is present; fails silently if lifecycle script is missing or crashes.
  try {
    const coderlmBin = path.join(os.homedir(), '.claude', 'nf-bin', 'coderlm');
    if (fs.existsSync(coderlmBin)) {
      let lifecyclePath = null;
      try { lifecyclePath = resolveBin('coderlm-lifecycle.cjs'); } catch (_) {}
      if (lifecyclePath && fs.existsSync(lifecyclePath)) {
        const { spawn } = require('child_process');
        // Pass default port (8787) + project cwd so coderlm indexes the right directory
        const child = spawn(process.execPath, [lifecyclePath, '--start', '8787', _hookCwd], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }
    }
  } catch (_) {}

  process.exit(0);
})();

// Export for unit testing.
// When require()'d by tests, the stdin handler and async IIFE are not registered (require.main guard above).
module.exports = { parseStateForReminder, findMemoryStore };

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark