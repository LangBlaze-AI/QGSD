#!/usr/bin/env node
'use strict';

/**
 * call-quorum-slot.cjs — bash-callable quorum slot dispatcher
 *
 * Usage:
 *   echo "<prompt>" | node call-quorum-slot.cjs --slot <name> [--timeout <ms>] [--cwd <dir>]
 *   node call-quorum-slot.cjs --slot <name> [--timeout <ms>] [--cwd <dir>] <<'EOF'
 *   <multi-line prompt>
 *   EOF
 *
 * --cwd <dir>  Set the working directory for spawned CLI processes (defaults to process.cwd()).
 *              Pass the project repo path so CLIs auto-detect the correct git context.
 *
 * Reads providers.json, dispatches to the slot's CLI (subprocess) or HTTP provider,
 * prints the response text to stdout.
 *
 * Used by nf-quorum-orchestrator (sub-agent) which cannot access MCP tools.
 *
 * Exit codes: 0 = success, 1 = error (message on stderr)
 */

const { spawn, spawnSync } = require('child_process');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { resolveCli, resolveSpawnTarget } = require('./resolve-cli.cjs');
const { loadProviders } = require('./resolve-providers.cjs');
const { resolveArgsTemplate } = require('./provider-arg-templates.cjs');
const { acquireSlot, releaseSlot, providerKeyFromUrl } = require('./provider-concurrency.cjs');
const { resolveEnvPlaceholders, findUnresolvedPlaceholders, isPlaceholder, extractPlaceholderVar, namespacedSecretKey } = require('./resolve-env.cjs');
const { warnUnknownDispatchFlags } = require('./quorum-dispatch-argv.cjs'); // #202: parent→child argv contract

// ─── Utilities ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Verdict vocabulary (VERDICT-01) ─────────────────────────────────────────
// Mode B workers emit exactly one of these on a `verdict:` line. The legacy
// `/APPROVE|BLOCK|FLAG/` pattern was wrong on two counts:
//   1. BLOCK is not part of the vocabulary — Mode B emits APPROVE|REJECT|FLAG.
//   2. It was unanchored, so the first keyword anywhere in the text won
//      (e.g. "I would not APPROVE this" parsed as APPROVE), corrupting the
//      verdict telemetry that feeds the score-delta calibration (#175).
const VERDICTS = Object.freeze(['APPROVE', 'REJECT', 'FLAG']);
// Tolerant of common LLM markdown before the keyword: blockquote `>`, bold `*`,
// heading `#`, list bullet `-` (e.g. `## Verdict: APPROVE`, `- verdict: REJECT`),
// and bold around the keyword (`verdict: **APPROVE**`). Still effectively line-
// anchored — only markdown markers/whitespace may precede `verdict:`, so prose
// mentions ("I would not APPROVE") don't register.
// Sentinel-only: the keyword must END the line (modulo trailing whitespace, bold,
// and common punctuation). This keeps last-match-wins (parseVerdictLine) safe — a
// REASONING bullet like `- verdict: REJECT would overstate the issue` has trailing
// words, so it is NOT a vote and can't flip consensus, while a real `verdict: APPROVE.`
// / `verdict: **APPROVE**` still parses.
const VERDICT_LINE_RE = /^[\s>*#-]*verdict:\s*\**\s*(APPROVE|REJECT|FLAG)\b[*\s.,:;!?)\]'"]*$/im;

/**
 * parseVerdictLine — extract the verdict from an anchored `verdict:` line.
 *
 * Anchored to the start of a line (multiline) so prose that merely mentions a
 * verdict keyword does not register. Returns null when no `verdict:` line is
 * present, letting callers apply their own default.
 *
 * @param {string} text
 * @returns {'APPROVE'|'REJECT'|'FLAG'|null}
 */
function parseVerdictLine(text) {
  // Take the LAST anchored verdict line — when a worker revises mid-output
  // (`verdict: FLAG` … then `verdict: APPROVE`), the final position must win, not
  // a stale earlier one. (Single-verdict outputs are unaffected: last === first.)
  const re = new RegExp(VERDICT_LINE_RE.source, 'gim');
  let last = null;
  for (const m of String(text || '').matchAll(re)) last = m;
  return last ? last[1].toUpperCase() : null;
}

// ─── Token sentinel for CLI slots (OBSV-04) ───────────────────────────────────
function appendTokenSentinel(slotName) {
  try {
    const record = JSON.stringify({
      ts:                          new Date().toISOString(),
      session_id:                  null,
      agent_id:                    null,
      slot:                        slotName,
      input_tokens:                null,
      output_tokens:               null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens:     null,
    });
    const pp = require('./planning-paths.cjs');
    const logPath = pp.resolve(findProjectRoot(spawnCwd), 'token-usage');
    fs.appendFileSync(logPath, record + '\n', 'utf8');
  } catch (_) {} // observational — never fails
}

// ─── Telemetry logging for quorum slot dispatch (OBS-01) ─────────────────────
function recordTelemetry(slotName, round, verdict, latencyMs, provider, providerStatus, retryCount, errorType, truncated, truncationLayer, originalSizeBytes, outputPreview, outputLength, exitCode) {
  try {
    const sessionId = process.env.CLAUDE_SESSION_ID || 'session-' + Date.now();
    const record = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: sessionId,
      round: parseInt(round, 10) || 0,
      slot: slotName,
      verdict: verdict,
      latency_ms: latencyMs,
      provider: provider,
      provider_status: providerStatus,
      retry_count: retryCount,
      error_type: errorType,
      truncated: truncated || false,
      truncation_layer: truncationLayer || null,
      original_size_bytes: originalSizeBytes || null,
      output_preview: outputPreview || null,
      output_length: outputLength || null,
      exit_code: exitCode != null ? exitCode : null,
    });
    const pp = require('./planning-paths.cjs');
    const logPath = pp.resolve(findProjectRoot(spawnCwd), 'quorum-rounds', { sessionId });
    fs.appendFileSync(logPath, record + '\n', 'utf8');
  } catch (_) {
    // Fail-open: telemetry errors never block or crash the dispatch
    // Log to stderr for observability, but do not rethrow
    process.stderr.write('[call-quorum-slot] telemetry error (non-fatal): recordTelemetry failed\n');
  }
}

// ─── Failure log ───────────────────────────────────────────────────────────────
function findProjectRoot(cwd) {
  // If cwd is provided and has .planning/, use it directly
  // (avoids stale ~/.claude/.planning/ found via __dirname walk)
  if (cwd && fs.existsSync(path.join(cwd, '.planning'))) return cwd;
  // Fallback: walk up from __dirname (original behavior when no cwd)
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.planning'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd || process.cwd();
}

// ─── atomicUpdateJson: lock-free read-modify-write for a JSON array/object ─────
// Multiple parallel slots (4-8) share quorum-failures. A plain read-modify-write
// loses records under concurrency, and a torn read collapses to `[]`, wiping the
// log exactly during the correlated outages #192/#190 need to observe.
//
// This serializes writers with an exclusive (wx) lock file and writes atomically
// via tmp+rename (modeled on update-scoreboard.cjs's set-availability path). The
// transform `fn` receives the freshly-read current value and returns the next one.
// Fail-open: on any error the update is skipped — failure logging must never
// interrupt the primary dispatch flow.
function atomicUpdateJson(filePath, fn, fallback) {
  const lockPath = filePath + '.lock';
  const deadline = Date.now() + 5000;
  let held = false;
  try {
    // Acquire an exclusive writer lock (best-effort, with a stale backstop).
    while (Date.now() < deadline) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        held = true;
        break;
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          // Reclaim a stale lock (>5s old → a crashed writer left it behind).
          try {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.mtimeMs > 5000) { fs.unlinkSync(lockPath); continue; }
          } catch (_) {}
          // Brief synchronous spin — this RMW is sub-millisecond, contention is rare.
          const spinUntil = Date.now() + 5;
          while (Date.now() < spinUntil) { /* yield to fs above on next pass */ }
          continue;
        }
        throw err;
      }
    }
    if (!held) {
      // Could not get the lock in time — fail-open, do not corrupt by racing.
      return;
    }

    // Read current value under the lock.
    let current = fallback;
    if (fs.existsSync(filePath)) {
      try { current = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch (_) { current = fallback; }
    }

    const next = fn(current);
    if (next === undefined) return; // transform opted out

    // Atomic write: tmp + rename so a reader never sees a torn file.
    const tmpPath = filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (_) {
    // Fail-open: never throw out of failure logging.
  } finally {
    if (held) { try { fs.unlinkSync(lockPath); } catch (_) {} }
  }
}

function classifyErrorType(msg) {
  if (/usage:|unknown flag|unknown option|invalid flag|unrecognized/i.test(msg)) return 'CLI_SYNTAX';
  if (/CONTEXT_OVERFLOW/i.test(msg) || /exceeds.*maximum context length|token count exceeds|too many tokens/i.test(msg)) return 'CONTEXT_OVERFLOW';
  if (/RATE_LIMITED/i.test(msg)) return 'RATE_LIMITED';
  if (/STALL/i.test(msg)) return 'STALL';
  if (/IDLE_TIMEOUT/i.test(msg)) return 'IDLE_TIMEOUT';
  if (/HARD_TIMEOUT/i.test(msg)) return 'HARD_TIMEOUT';
  if (/TIMEOUT/i.test(msg)) return 'TIMEOUT'; // backward compat for old log entries
  if (/402|quota|rate.?limit|resource.?exhausted|Too Many Requests|exhausted your capacity/i.test(msg)) return 'QUOTA';
  if (/401|403|unauthorized|forbidden/i.test(msg)) return 'AUTH';
  if (/service not running|service.?down|not.?started/i.test(msg)) return 'SERVICE_DOWN';
  if (/spawn error/i.test(msg)) return 'SPAWN_ERROR';
  return 'UNKNOWN';
}

function writeFailureLog(slotName, errorMsg, stderrText) {
  try {
    const pp = require('./planning-paths.cjs');
    const logPath = pp.resolve(findProjectRoot(spawnCwd), 'quorum-failures');

    const error_type = classifyErrorType(errorMsg);

    // Extract pattern: first 200 chars of stderrText or errorMsg, strip ANSI codes
    const rawPattern = (stderrText && stderrText.length > 0) ? stderrText : errorMsg;
    const pattern = rawPattern.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200);

    // Lock-free read-modify-write under an exclusive writer lock so parallel slots
    // never lose records (and a torn read never wipes the whole log).
    atomicUpdateJson(logPath, (current) => {
      let records = Array.isArray(current) ? current : [];

      // Garbage-collect stale records (older than 60 minutes) to prevent unbounded growth
      const gcCutoff = Date.now() - 60 * 60 * 1000;
      records = records.filter(r => new Date(r.last_seen).getTime() > gcCutoff);

      // Update or insert record
      const existing = records.find(r => r.slot === slotName && r.error_type === error_type);
      if (existing) {
        existing.count++;
        existing.last_seen = new Date().toISOString();
      } else {
        records.push({ slot: slotName, error_type, pattern, count: 1, last_seen: new Date().toISOString() });
      }
      return records;
    }, []);
  } catch (_) { /* failure logging must never interrupt the primary flow */ }
}

// ─── Success recovery: clear failure records when a slot succeeds ────────────
// When a slot successfully completes inference, remove its failure records so
// the next quorum run doesn't skip it. This gives immediate recovery instead
// of waiting for the 30-minute TTL to expire.
function clearFailureOnSuccess(slotName) {
  try {
    const pp = require('./planning-paths.cjs');
    const logPath = pp.resolve(findProjectRoot(spawnCwd), 'quorum-failures');
    if (!fs.existsSync(logPath)) return;
    atomicUpdateJson(logPath, (current) => {
      if (!Array.isArray(current)) return undefined; // nothing coherent to clear
      const before = current.length;
      const next = current.filter(r => r.slot !== slotName);
      return next.length < before ? next : undefined; // skip write if unchanged
    }, []);
  } catch (_) { /* recovery logging must never interrupt the primary flow */ }
}

// ─── Layer 2: Bridge failure log to scoreboard cooldown ──────────────────────
// After a slot fails, set a cooldown entry in the scoreboard so future dispatches
// skip it immediately. Uses spawnSync for synchronous hook context. Fail-open:
// scoreboard update must never block or crash the dispatch flow.
function setScoreboardCooldown(slotName, errorMsg) {
  try {
    const scoreboardScript = path.join(__dirname, 'update-scoreboard.cjs');
    // Resolve the scoreboard path from the SAME basis the Layer 3 reader uses
    // (findProjectRoot(spawnCwd) via --cwd), then pass it explicitly as
    // --scoreboard. Without this the writer would resolve its default path from
    // the spawned process's process.cwd() (the Bash cwd), which can differ from
    // --cwd in subdir sessions, worktrees, or the Task harness — cooldowns would
    // land in one .planning and be read from another, so Layer 3 skip never
    // fires and dead slots get re-dispatched. Spawn with process.execPath rather
    // than bare 'node' so the write still works where PATH lacks node (GUI hooks).
    const pp = require('./planning-paths.cjs');
    const sbPath = pp.resolveWithFallback(findProjectRoot(spawnCwd), 'quorum-scoreboard');
    spawnSync(process.execPath, [scoreboardScript, 'set-availability', '--slot', slotName, '--message', errorMsg, '--scoreboard', sbPath], { timeout: 3000, stdio: 'pipe' });
    process.stderr.write(`[call-quorum-slot] Set cooldown for ${slotName} via set-availability\n`);
  } catch (_) { /* fail-open: scoreboard update must never block dispatch */ }
}

// ─── Retry with exponential backoff (FAIL-01) ───────────────────────────────
function isRetryable(error) {
  const msg = (error && error.message) ? error.message : String(error);

  // Non-retryable errors: fail immediately
  if (/spawn error/i.test(msg)) {
    return false;
  }
  if (/usage:|unknown flag|unknown option|invalid flag|unrecognized/i.test(msg)) {
    return false;
  }
  if (/CONTEXT_OVERFLOW|exceeds.*maximum context length|token count exceeds/i.test(msg)) {
    return false;
  }

  // Retryable errors: TIMEOUT and network errors
  if (/TIMEOUT/i.test(msg)) {
    return true;
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return true;
  }

  // Fail-open: unknown errors are retryable
  return true;
}

async function retryWithBackoff(fn, slotName, maxRetries = 2, delays = [1000, 3000]) {
  let retryAttempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, retryCount: retryAttempts };
    } catch (err) {
      const isLastAttempt = attempt >= maxRetries;
      const isNonRetryable = !isRetryable(err);

      // Fail immediately if non-retryable or no more retries
      if (isNonRetryable || isLastAttempt) {
        throw err;
      }

      // Log retry attempt and sleep before next attempt
      const delayMs = delays[attempt] ?? 3000; // default to 3s if delay not specified
      retryAttempts++;
      process.stderr.write(`[call-quorum-slot] retry ${attempt + 1}/${maxRetries} for slot ${slotName} after ${delayMs}ms\n`);
      await sleep(delayMs);
    }
  }
}

// ─── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (f) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : null; };

const slot      = getArg('--slot');
const _timeoutArg = getArg('--timeout');
// Treat 0 / negative / NaN as "not set" — fall through to provider.quorum_timeout_ms.
// Zero can be passed when the quorum orchestrator LLM fails to compute SLOT_TIMEOUTS,
// causing the process to be killed in ~1 ms and logged as "TIMEOUT after 0ms".
let timeoutMs = _timeoutArg !== null ? parseInt(_timeoutArg, 10) : null;
if (timeoutMs !== null && (isNaN(timeoutMs) || timeoutMs <= 0)) timeoutMs = null;
const roundNum  = getArg('--round');
const spawnCwd  = getArg('--cwd') ?? process.cwd();
const allowedTools = getArg('--allowed-tools'); // EXEC-01: e.g. "Read,Grep,Glob" for review-only slots
const innerOutputFile = getArg('--output-file');  // Defense-in-depth: write result file from child process
const innerDispatchNonce = getArg('--dispatch-nonce');  // Nonce from parent for file authenticity

// #202: warn (stderr) on any --flag this child does not parse, so future
// parent→child dispatch-argv contract drift is visible instead of silent.
warnUnknownDispatchFlags(argv);

// Defense-in-depth: write result file from child process (Haiku can't modify child argv)
function writeInnerOutputFile(result) {
  if (!innerOutputFile) return;
  try {
    fs.mkdirSync(path.dirname(innerOutputFile), { recursive: true });
    // Append dispatch_nonce if present in parent args but not already in result
    let content = result;
    if (innerDispatchNonce && !result.includes('dispatch_nonce:')) {
      content += `\ndispatch_nonce: ${innerDispatchNonce}\n`;
    }
    fs.writeFileSync(innerOutputFile, content.endsWith('\n') ? content : content + '\n', 'utf8');
  } catch (e) {
    process.stderr.write(`[call-quorum-slot] inner output-file write failed: ${e.message}\n`);
  }
}

if (!slot && require.main === module) {
  process.stderr.write('Usage: echo "<prompt>" | node call-quorum-slot.cjs --slot <name> [--timeout <ms>] [--cwd <dir>]\n');
  process.exit(1);
}

// ─── Find providers.json ───────────────────────────────────────────────────────
// Single source of truth lives in resolve-providers.cjs (issue #197). The canonical
// installed path is ~/.claude/nf-bin/providers.json (`'.claude', 'nf-bin', 'providers.json'`);
// the resolver also honors UNIFIED_PROVIDERS_CONFIG, the ~/.claude.json pointer, __dirname,
// and the legacy nf/bin path. baseDir=__dirname makes the "same dir" candidate resolve relative
// to this script (nf-bin after install).
function findProviders() {
  return loadProviders({ baseDir: __dirname });
}

// ─── Read stdin ────────────────────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    // If stdin is a TTY (no pipe), resolve immediately with empty string
    if (process.stdin.isTTY) resolve('');
  });
}

// ─── SHELL-ESCAPE-01: Args builder (extracted for testability) ────────────────
function buildSpawnArgs(provider, prompt, allowedToolsFlag) {
  // Match `ccr` as a path SEGMENT/basename, not a raw substring: a plain
  // `.includes('ccr')` false-matches innocent paths (e.g. /Users/mccray/bin/gemini),
  // wrongly flagging the slot as CCR and neutralizing $/!/backticks in its prompt.
  const _cliPath = provider.resolvedCli ?? provider.cli ?? '';
  const isCcr = provider.display_type === 'claude-code-router' ||
    /(^|\/)ccr([\/-]|$)/.test(_cliPath);

  let args;
  let useStdinPrompt = false;
  // SHELL-ESCAPE-01 (revised): spawn() uses args array without shell:true,
  // so there's no shell interpretation risk. Pass prompt via -p for ALL slots
  // including CCR. The original stdin-piping approach broke CCR because it
  // doesn't accept stdin input — only -p argument.
  // CCR v2.0.0 internally re-spawns with shell:true, so backticks, $(), and
  // ! in the prompt get interpreted as shell commands. Strip/neutralize these
  // for CCR slots — backticks are just markdown formatting in quorum prompts.
  const safePrompt = isCcr
    ? prompt.replace(/`/g, "'").replace(/\$\(/g, '(').replace(/\$/g, '').replace(/!/g, '.')
    : prompt;
  // CCR-MUTATE-01: surface whether the neutralization above actually changed the
  // prompt. CCR reviews then see mutilated code ($/!/backtick stripped) and may
  // cite lines that no longer match the original — callers should treat such
  // reviews with reduced confidence. Tracked via the returned `promptMutated`
  // flag (and a stderr warning in runSubprocess) until CCR can accept the prompt
  // over stdin/temp-file without shell re-interpretation.
  const promptMutated = Boolean(isCcr) && safePrompt !== prompt;
  // ARGS-TEMPLATE-01: providers.json entries from the auto-detect install path can
  // lack args_template; `.map` on undefined crashed every slot opaquely. Fall back
  // to the canonical per-family template (by mainTool), and fail LOUD with an
  // actionable message if the family is unknown — never the bare TypeError.
  const argsTemplate = resolveArgsTemplate(provider);
  if (!Array.isArray(argsTemplate)) {
    throw new Error(
      `provider ${provider.name || '(unnamed)'} has no args_template and family ` +
      `'${provider.mainTool || '?'}' has no canonical default — regenerate providers.json ` +
      `(run install or /nf:mcp-setup), or add an args_template to this slot.`
    );
  }
  // The prompt is delivered exclusively through a {prompt} placeholder (no slot uses
  // stdin). An empty template or one lacking the placeholder would silently drop the
  // prompt — the CLI runs with flags but no question. Fail LOUD instead, matching the
  // missing-args_template contract above.
  if (!useStdinPrompt && !argsTemplate.some(a => typeof a === 'string' && a.includes('{prompt}'))) {
    throw new Error(
      `provider ${provider.name || '(unnamed)'} args_template has no {prompt} placeholder ` +
      `(${JSON.stringify(argsTemplate)}) — the prompt would be silently dropped; fix providers.json.`
    );
  }
  // Substitute the {prompt} placeholder. Handle both a bare element (`'{prompt}'`)
  // AND an embedded form (`'--prompt={prompt}'`), and replace every occurrence —
  // exact-equality-only substitution silently shipped a literal `{prompt}` to the CLI.
  args = argsTemplate.map(a =>
    (typeof a === 'string' && a.includes('{prompt}')) ? a.split('{prompt}').join(safePrompt) : a
  );
  // Only use stdin for slots that explicitly require it (none currently do)
  useStdinPrompt = false;

  // EXEC-01: Inject --allowedTools for ccr-based slots when review-only
  if (allowedToolsFlag && isCcr) {
    const dspIdx = args.indexOf('--dangerously-skip-permissions');
    if (dspIdx !== -1) {
      args.splice(dspIdx, 0, '--allowedTools', allowedToolsFlag);
    } else {
      args.push('--allowedTools', allowedToolsFlag);
    }
  }

  return { args, useStdinPrompt, isCcr, promptMutated };
}

// ─── Subprocess dispatch ───────────────────────────────────────────────────────
// STALL-TIMEOUT-01: the "header-only stall" timer (used while a slot has produced
// < 500 bytes) defaults to 30s — fine for fast slots, but slow-bursty models routed
// via a third-party Anthropic-compatible API (GLM-5.2[1m], MiniMax-M3) emit a short
// preamble then pause well past 30s while generating. They are slow, not hung. A
// per-slot `stall_timeout_ms` in providers.json raises the threshold so they are not
// false-killed. Any value ≤ 0 / NaN / absent falls back to the 30s default.
// Node's setTimeout clamps delays above 2^31-1 ms and fires them IMMEDIATELY, so a
// nonsensically large stall_timeout_ms would silently disable the stall timer. Cap
// at TIMEOUT_MAX to keep the timer well-formed.
const TIMEOUT_MAX = 2147483647; // 2^31 - 1
function stallTimeoutFor(provider) {
  const raw = provider && provider.stall_timeout_ms;
  // Only coerce real numbers / numeric strings. Without this, Number(true) === 1
  // would pass the `> 0` guard and yield a 1ms stall timer that instantly false-kills
  // every slot. Booleans/objects/etc. fall back to the default.
  if (typeof raw !== 'number' && typeof raw !== 'string') return 30000;
  const v = Number(raw);
  if (!(v > 0)) return 30000;
  return Math.min(v, TIMEOUT_MAX);
}

function runSubprocess(provider, prompt, idleTimeoutMs, hardTimeoutMs, allowedToolsFlag) {
  const { args, useStdinPrompt, isCcr, promptMutated } = buildSpawnArgs(provider, prompt, allowedToolsFlag);
  if (promptMutated) {
    // CCR-MUTATE-01: warn that the prompt was neutralized for CCR's shell re-spawn.
    process.stderr.write('[call-quorum-slot] WARNING: prompt_mutated=true — CCR neutralized $/!/backtick chars; review may cite mutilated code\n');
  }

  // XPLAT-01: resolve CLI path at dispatch time (once per invocation)
  // `cli` is optional in providers.json — when absent, fall back to `mainTool` as the bare
  // binary name. Without this fallback, `provider.resolvedCli` stays undefined and the spawn
  // below hands `null` to child_process.spawn, throwing "The 'file' argument must be of type
  // string. Received null" before any model is contacted — taking the entire quorum offline.
  // Same fix as PR #161 applied to bin/unified-mcp-server.mjs.
  if (provider.type === 'subprocess') {
    const cliSource = provider.cli || provider.mainTool;
    if (cliSource) {
      const bareName = cliSource.split('/').pop();
      provider.resolvedCli = resolveCli(bareName);
    }
  }

  const env  = { ...process.env, ...resolveEnvPlaceholders(provider.env ?? {}) };

  return new Promise((resolve, reject) => {
    let child;
    try {
      // detached: true creates a new process group — required to kill all descendants
      // (ccr → Claude Code → node, opencode → LLM subprocess, etc.)
      // Shared spawn-target resolver (issue #197): resolvedCli (preferred, absolute path)
      // → resolveCli(cli || mainTool). Guards against spawn(null).
      const spawnTarget = resolveSpawnTarget(provider);
      if (!spawnTarget) throw new Error(`provider ${provider.name} has no resolvable CLI (cli, resolvedCli, and mainTool all empty)`);
      child = spawn(spawnTarget, args, { env, cwd: spawnCwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      reject(new Error(`[spawn error: ${err.message}]`));
      return;
    }

    // SHELL-ESCAPE-01: For ccr slots, pipe prompt via stdin to avoid shell interpretation.
    // For all other slots, close stdin immediately (non-interactive).
    if (useStdinPrompt) {
      child.stdin.write(prompt);
      child.stdin.end();
    } else {
      child.stdin.end(); // non-interactive
    }

    let stdout    = '';
    let stderr    = '';
    let timedOut  = false;
    let timeoutType = ''; // 'IDLE' or 'HARD'
    const MAX_BUF = 10 * 1024 * 1024;
    let l1Truncated = false;
    let l1OriginalSize = 0;
    // P2: clamp the initial idle/hard timers to the max-safe bound. Node fires setTimeout
    // delays above 2^31-1 ms IMMEDIATELY (silently disabling the timer), so an oversized
    // idle_timeout_ms/hard_timeout_ms would leave a slot with no timeout at all. Mirrors
    // stallTimeoutFor()'s clamp, which previously guarded only the stall window.
    idleTimeoutMs = Math.min(idleTimeoutMs, TIMEOUT_MAX);
    hardTimeoutMs = Math.min(hardTimeoutMs, TIMEOUT_MAX);

    // Kill entire process group, then destroy streams to force 'close' even if
    // grandchildren keep the pipes open (the common case with ccr/opencode).
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        try { child.stdout.destroy(); } catch (_) {}
        try { child.stderr.destroy(); } catch (_) {}
      }, 2000);
    };

    // Idle timer — resets on every stdout/stderr data event
    let idleTimer = setTimeout(() => {
      timedOut = true;
      timeoutType = 'IDLE';
      killGroup();
    }, idleTimeoutMs);

    // Hard wall-clock cap — never resets, absolute safety net
    const hardTimer = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        timeoutType = 'HARD';
        killGroup();
      }
    }, hardTimeoutMs);

    // Rate-limit / quota exhaustion early detection (RLIMIT-01)
    // Two detection modes:
    // A) Stream-based: CLI emits rate-limit messages (Gemini "Attempt N failed", etc.)
    //    → kill after 2 consecutive matches
    // B) Silent-hang: CLI produces zero bytes for 30s (OpenCode buffers internally)
    //    → the idle timer already handles this at 90s, but we add a tighter
    //    "no first byte" timer: if zero bytes received after 30s, kill early
    const RATE_LIMIT_PATTERNS = /Too Many Requests|exhausted your capacity|rate.limit|429|quota.exceeded|Attempt \d+ failed/i;
    let rateLimitHits = 0;
    const RATE_LIMIT_THRESHOLD = 2; // kill after 2 consecutive rate-limit messages
    let totalBytesReceived = 0;
    // P2 — STALL detection = "no FIRST byte", NOT "model is thinking".
    // Prior bug: the idle window was tightened to STALL_TIMEOUT_MS whenever total output
    // was < 500 bytes, so a slow model that emitted a short preamble (e.g. 202-byte CLI
    // framing) then paused >30s mid-generation was false-killed as STALL. A stall timeout
    // is meant for "the process stopped writing", not "the model is still generating".
    // Fix: a dedicated first-byte timer catches the genuine dead-on-arrival hang (zero bytes
    // by STALL_TIMEOUT_MS); once ANY byte arrives it is cleared and the normal per-chunk
    // idle window governs — so slow thinkers stream fine. Per-slot `stall_timeout_ms`
    // (stallTimeoutFor) still tunes the first-byte budget for slow-to-start providers.
    const STALL_TIMEOUT_MS = stallTimeoutFor(provider);
    let firstByteTimer = setTimeout(() => {
      if (totalBytesReceived === 0 && !timedOut) { timedOut = true; timeoutType = 'STALL'; killGroup(); }
    }, STALL_TIMEOUT_MS);

    child.stdout.on('data', d => {
      totalBytesReceived += d.length;
      clearTimeout(firstByteTimer);   // first byte seen → past the dead-on-arrival window
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; timeoutType = 'IDLE'; killGroup(); }, idleTimeoutMs);
      const chunk = d.toString();
      l1OriginalSize += chunk.length;
      if (stdout.length < MAX_BUF) {
        if (stdout.length + chunk.length > MAX_BUF) {
          stdout += chunk.slice(0, MAX_BUF - stdout.length);
          l1Truncated = true;
        } else {
          stdout += chunk;
        }
      } else {
        l1Truncated = true;
      }
      // Check stdout for rate-limit patterns
      if (RATE_LIMIT_PATTERNS.test(chunk)) {
        rateLimitHits++;
        if (rateLimitHits >= RATE_LIMIT_THRESHOLD && !timedOut) {
          timedOut = true;
          timeoutType = 'RATE_LIMITED';
          process.stderr.write('[call-quorum-slot] RATE_LIMITED: ' + rateLimitHits + ' rate-limit messages detected, killing early\n');
          killGroup();
        }
      }
    });
    child.stderr.on('data', d => {
      totalBytesReceived += d.length;
      clearTimeout(firstByteTimer);   // first byte seen (stderr counts) → past dead-on-arrival
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; timeoutType = 'IDLE'; killGroup(); }, idleTimeoutMs);
      const chunk = d.toString().slice(0, 4096);
      stderr += chunk;
      // Check stderr for rate-limit patterns too (gemini logs to stderr)
      if (RATE_LIMIT_PATTERNS.test(chunk)) {
        rateLimitHits++;
        if (rateLimitHits >= RATE_LIMIT_THRESHOLD && !timedOut) {
          timedOut = true;
          timeoutType = 'RATE_LIMITED';
          process.stderr.write('[call-quorum-slot] RATE_LIMITED: ' + rateLimitHits + ' rate-limit messages detected in stderr, killing early\n');
          killGroup();
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(firstByteTimer);
      if (timedOut) {
        // Content-based reclassification: when STALL fires, inspect the partial
        // stdout/stderr for known error patterns before using the generic label.
        // This distinguishes rate-limits, context overflow, and auth errors from
        // true stalls (provider hung with no meaningful output).
        if (timeoutType === 'STALL') {
          const partial = (stdout + stderr).slice(0, 2000);
          if (/exceeds.*maximum context length|token count exceeds|too many tokens/i.test(partial)) {
            timeoutType = 'CONTEXT_OVERFLOW';
          } else if (RATE_LIMIT_PATTERNS.test(partial)) {
            timeoutType = 'RATE_LIMITED';
          } else if (/401|403|unauthorized|forbidden|invalid.*api.?key/i.test(partial)) {
            timeoutType = 'AUTH';
          } else if (/402|quota|resource.?exhausted|billing/i.test(partial)) {
            timeoutType = 'QUOTA';
          }
        }
        const label = timeoutType === 'RATE_LIMITED'
          ? `RATE_LIMITED after ${rateLimitHits > 0 ? rateLimitHits + ' consecutive rate-limit errors' : 'partial output analysis'} (killed early)`
          : timeoutType === 'CONTEXT_OVERFLOW'
          ? `CONTEXT_OVERFLOW: model rejected prompt as too large (${totalBytesReceived} bytes partial response)`
          : timeoutType === 'AUTH'
          ? `AUTH: provider returned authentication error (${totalBytesReceived} bytes partial response)`
          : timeoutType === 'QUOTA'
          ? `QUOTA: provider returned quota/billing error (${totalBytesReceived} bytes partial response)`
          : timeoutType === 'STALL'
          ? `STALL: only ${totalBytesReceived} bytes received then silence for ${STALL_TIMEOUT_MS}ms — no recognizable error pattern in partial output`
          : timeoutType === 'HARD'
          ? `HARD_TIMEOUT after ${hardTimeoutMs}ms total`
          : `IDLE_TIMEOUT after ${idleTimeoutMs}ms of inactivity`;
        reject(new Error(label));
        return;
      }
      const l1Suffix = l1Truncated ? '\n\n[OUTPUT TRUNCATED at 10MB by call-quorum-slot]' : '';
      const output = (stdout || stderr || '(no output)') + l1Suffix;
      resolve(code !== 0 ? `${output}\n[exit code ${code}]` : output);
    });

    child.on('error', (err) => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      reject(new Error(`[spawn error: ${err.message}]`));
    });
  });
}

// ─── OAuth account rotation ────────────────────────────────────────────────────
function matchesRotationPattern(text, patterns) {
  const lower = (text ?? '').toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

function spawnRotateCmd(cmdArray) {
  return new Promise((resolve) => {
    const [bin, ...args] = cmdArray;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', (code) => {
      if (code !== 0) process.stderr.write(`[oauth-rotation] ${bin} exited ${code}\n`);
      resolve(); // non-fatal — always attempt retry
    });
    child.on('error', (err) => {
      process.stderr.write(`[oauth-rotation] ${bin} error: ${err.message}\n`);
      resolve(); // non-fatal
    });
  });
}

async function runSubprocessWithRotation(provider, prompt, idleTimeoutMs, hardTimeoutMs, allowedToolsFlag) {
  const rot      = provider.oauth_rotation;
  const max      = rot.max_retries ?? 3;
  const patterns = rot.retry_on_patterns ?? ['quota', 'resource_exhausted', 'unauthorized', '401', '403'];
  let lastErr    = null;
  let totalRetryCount = 0;

  for (let attempt = 0; attempt <= max; attempt++) {
    if (attempt > 0) {
      process.stderr.write(`[oauth-rotation] attempt ${attempt}/${max} — rotating OAuth account\n`);
      await spawnRotateCmd(rot.rotate_cmd);
    }
    try {
      // Wrap inner call with retry-with-backoff (each oauth attempt gets retry protection)
      const retryResult = await retryWithBackoff(() => runSubprocess(provider, prompt, idleTimeoutMs, hardTimeoutMs, allowedToolsFlag), provider.name);
      const out = retryResult.result;
      totalRetryCount = attempt + retryResult.retryCount;
      if (matchesRotationPattern(out, patterns) && attempt < max) {
        lastErr = new Error('quota/auth pattern in output');
        continue;
      }
      return { result: out, retryCount: totalRetryCount };
    } catch (err) {
      if (matchesRotationPattern(err.message, patterns) && attempt < max) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('[oauth-rotation] all attempts exhausted');
}

// ─── Read per-slot env from ~/.claude.json (for HTTP PROVIDER_SLOT pattern) ───
function loadSlotEnv(slotName) {
  try {
    const claudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return claudeJson?.mcpServers?.[slotName]?.env ?? {};
  } catch (_) { return {}; }
}

// ─── HTTP dispatch ─────────────────────────────────────────────────────────────
async function runHttp(provider, prompt, timeoutMs, slotName) {
  // HTTP slots use PROVIDER_SLOT mode: API keys live in ~/.claude.json server env,
  // not in process.env. Load them from there, falling back to process.env.
  const slotEnv = loadSlotEnv(provider.name);
  const apiKey  = slotEnv['ANTHROPIC_API_KEY']
               ?? process.env[provider.apiKeyEnv]
               ?? process.env['ANTHROPIC_API_KEY']
               ?? '';
  const baseUrl = slotEnv['ANTHROPIC_BASE_URL'] ?? provider.baseUrl;
  const model   = slotEnv['CLAUDE_DEFAULT_MODEL'] ?? provider.model;

  // Provider concurrency control: acquire a slot before dispatching HTTP request
  const providerKey = providerKeyFromUrl(baseUrl);
  const maxConcurrency = provider.max_concurrency || 3;
  // acquireSlot is async (await-based backoff, no busy-wait). Await it before the
  // request executor so the slot is held for the full request lifetime.
  const lock = await acquireSlot(providerKey, maxConcurrency, 30000);

  return new Promise((resolve, reject) => {
    // Hold the provider slot for the FULL request lifetime — release it only when
    // the request genuinely completes (response end, error, timeout, or a
    // synchronous setup failure). Releasing in a `finally` around the executor
    // would free the slot the instant req.end() returns, before the response
    // arrives, defeating the concurrency cap entirely.
    let lockReleased = false;
    const releaseLock = () => {
      if (lockReleased) return;
      lockReleased = true;
      try { if (lock && lock.release) lock.release(); } catch (_) {}
    };
    const succeed = (value) => { releaseLock(); resolve(value); };
    const fail = (err) => { releaseLock(); reject(err); };

    try {
      // Build messages array — include system message if provider defines one
      const messages = [];
      if (provider.system_prompt) {
        messages.push({ role: 'system', content: provider.system_prompt });
      }
      messages.push({ role: 'user', content: prompt });

      const body   = JSON.stringify({
        model:    model,
        messages,
        max_tokens: provider.max_output_tokens || 4096,
        temperature: provider.temperature ?? 0.3,
        stream:   false,
      });

      const url       = new URL(`${baseUrl}/chat/completions`);
      const isHttps   = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const options   = {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Authorization':  `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      let timedOut = false;

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (timedOut) return;
          clearTimeout(timer);
          try {
            const parsed  = JSON.parse(data);
            const content = parsed?.choices?.[0]?.message?.content;
            if (content) {
              succeed(content);
            } else {
              fail(new Error(`[HTTP error: unexpected response] ${data.slice(0, 500)}`));
            }
          } catch (e) {
            fail(new Error(`[HTTP error: JSON parse failed] ${data.slice(0, 500)}`));
          }
        });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        req.destroy();
        fail(new Error(`TIMEOUT after ${timeoutMs}ms`));
      }, timeoutMs);

      req.on('error', (err) => {
        clearTimeout(timer);
        // After a timeout the timeout path has already settled + released the
        // slot; releaseLock() is idempotent so this stays correct either way.
        if (!timedOut) fail(new Error(`[HTTP request error: ${err.message}]`));
        else releaseLock();
      });

      req.write(body);
      req.end();
    } catch (err) {
      // Synchronous setup failure (e.g. a malformed baseUrl) — release the slot
      // and reject so the promise always settles instead of hanging.
      fail(err instanceof Error ? err : new Error(`[HTTP dispatch error: ${err}]`));
    }
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const providers = findProviders();
  if (!providers) {
    process.stderr.write('[call-quorum-slot] Could not find providers.json\n');
    process.exit(1);
  }

  if (providers.length === 0) {
    process.stderr.write('[call-quorum-slot] No providers configured in providers.json — cannot dispatch slot\n');
    process.exit(1);
  }

  const provider = providers.find(p => p.name === slot);
  if (!provider) {
    const names = providers.map(p => p.name).join(', ');
    process.stderr.write(`[call-quorum-slot] Unknown slot: "${slot}". Available: ${names}\n`);
    process.exit(1);
  }

  const prompt = await readStdin();
  if (!prompt) {
    process.stderr.write('[call-quorum-slot] No prompt received on stdin\n');
    process.exit(1);
  }

  // ─── ${VAR} placeholder bootstrap ────────────────────────────────────────────
  // Load secrets for ${VAR} placeholders in the provider's env. The fan-out
  // import (issue 169) writes secret values as ${KEY} placeholders and stores
  // actual values in the secrets store (~/.claude/nf-secrets.json).
  // Secrets are namespaced by slot name (<slot>__<key>) to prevent collisions
  // when multiple providers share the same env key with different values.
  if (provider.env) {
    try {
      const secrets = require('./secrets.cjs');
      let loaded = 0;
      for (const [k, v] of Object.entries(provider.env)) {
        const envVarName = extractPlaceholderVar(v);
        if (envVarName !== null && process.env[envVarName] === undefined) {
          // Try namespaced key first, then fall back to unnamespaced
          const secret = await secrets.get('nforma', namespacedSecretKey(slot, envVarName))
                        ?? await secrets.get('nforma', envVarName);
          if (secret) {
            process.env[envVarName] = secret;
            loaded++;
          }
        }
      }
      if (loaded > 0) {
        process.stderr.write(`[call-quorum-slot] Loaded ${loaded} secret(s) for slot ${slot} from secrets store\n`);
      }
      // Warn on unresolved placeholders
      const unresolved = findUnresolvedPlaceholders(provider.env);
      if (unresolved.length > 0) {
        process.stderr.write(`[call-quorum-slot] WARNING: unresolved placeholder(s): ${unresolved.join(', ')} — set in env or run /nf:mcp-setup to store in secrets\n`);
      }
    } catch (e) {
      process.stderr.write(`[call-quorum-slot] secrets bootstrap for slot ${slot}: ${e.message}\n`);
    }
  }

  // ─── Layer 3: Pre-dispatch scoreboard cooldown check ────────────────────────
  // If this slot has an active cooldown from a recent failure, skip immediately.
  // Zero-latency: local file read, not an API call. Fail-open on any error.
  try {
    const pp = require('./planning-paths.cjs');
    const sbPath = pp.resolveWithFallback(findProjectRoot(spawnCwd), 'quorum-scoreboard');
    if (fs.existsSync(sbPath)) {
      const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
      const avail = sb?.availability?.[slot];
      if (avail?.available_at_iso) {
        const cooldownEnd = new Date(avail.available_at_iso).getTime();
        if (!isNaN(cooldownEnd) && cooldownEnd > Date.now()) {
          const remainingMs = cooldownEnd - Date.now();
          process.stderr.write(`[call-quorum-slot] COOLDOWN: ${slot} is cooling down for ${Math.ceil(remainingMs / 1000)}s more (until ${avail.available_at_iso})\n`);
          recordTelemetry(slot, roundNum, 'FLAG', 0, provider.provider || provider.name, 'cooldown', 0, 'COOLDOWN_ACTIVE', false, null, null, `Cooldown: ${Math.ceil(remainingMs / 1000)}s remaining`, 0, null);
          writeFailureLog(slot, `COOLDOWN_ACTIVE: ${Math.ceil(remainingMs / 1000)}s remaining`, '');
          appendTokenSentinel(slot);
          process.exit(1);
        }
      }
    }
  } catch (_) { /* fail-open: missing/malformed scoreboard = no cooldown check */ }

  // Dual timeout resolution:
  // - idle_timeout_ms: inactivity timer that resets on stdout/stderr, defaults to 90s
  // - hard_timeout_ms: absolute wall-clock cap that never resets, defaults to 5min (300s)
  // - --timeout CLI arg maps to idle timeout (backward compat)
  // - latency_budget_ms (LTCY-01) is the ultimate ceiling for both
  // - quorum_timeout_ms caps the hard timeout
  const latencyBudget = provider.latency_budget_ms ?? null;
  const providerIdle = provider.idle_timeout_ms ?? 90000;
  const providerHard = provider.hard_timeout_ms ?? 300000;
  const providerCap = provider.quorum_timeout_ms ?? null;

  let effectiveIdleTimeout = timeoutMs ?? providerIdle;
  let effectiveHardTimeout = providerHard;

  // quorum_timeout_ms caps the hard timeout
  if (providerCap !== null) {
    effectiveHardTimeout = Math.min(effectiveHardTimeout, providerCap);
  }

  // LTCY-01: latency_budget_ms is the ultimate ceiling for both
  if (latencyBudget !== null && latencyBudget > 0) {
    effectiveIdleTimeout = Math.min(effectiveIdleTimeout, latencyBudget);
    effectiveHardTimeout = Math.min(effectiveHardTimeout, latencyBudget);
    process.stderr.write(`[call-quorum-slot] Using latency_budget_ms=${latencyBudget} for slot ${slot}\n`);
  }

  // Hard cap must be >= idle timeout (otherwise idle never fires)
  effectiveHardTimeout = Math.max(effectiveHardTimeout, effectiveIdleTimeout);

  process.stderr.write(`[call-quorum-slot] Timeouts: idle=${effectiveIdleTimeout}ms hard=${effectiveHardTimeout}ms for slot ${slot}\n`);

  const startMs = Date.now();

  try {
    let result;
    let retryCount = 0;

    if (provider.type === 'subprocess') {
      if (provider.oauth_rotation?.enabled) {
        const retryResult = await runSubprocessWithRotation(provider, prompt, effectiveIdleTimeout, effectiveHardTimeout, allowedTools);
        result = retryResult.result;
        retryCount = retryResult.retryCount;
      } else {
        const retryResult = await retryWithBackoff(() => runSubprocess(provider, prompt, effectiveIdleTimeout, effectiveHardTimeout, allowedTools), slot);
        result = retryResult.result;
        retryCount = retryResult.retryCount;
      }
    } else if (provider.type === 'http') {
      const retryResult = await retryWithBackoff(() => runHttp(provider, prompt, effectiveIdleTimeout, slot), slot);
      result = retryResult.result;
      retryCount = retryResult.retryCount;
    } else {
      process.stderr.write(`[call-quorum-slot] Unknown provider type: ${provider.type}\n`);
      writeFailureLog(slot, `Unknown provider type: ${provider.type}`, '');
      setScoreboardCooldown(slot, 'Unknown provider type: ' + provider.type);
      appendTokenSentinel(slot);
      const latencyMs = Date.now() - startMs;
      recordTelemetry(slot, roundNum, 'FLAG', latencyMs, provider.provider || provider.name, 'unavailable', 0, 'UNKNOWN_TYPE', false, null, null, null, 0, null);
      process.exit(1);
    }

    // Detect non-zero exit code in resolved output (subprocess failures that didn't throw).
    // Pattern: "...\n[exit code N]" appended by runSubprocess on non-zero exit.
    const exitCodeMatch = result.match(/\[exit code (\d+)\]\s*$/);
    if (exitCodeMatch && exitCodeMatch[1] !== '0') {
      const cliExitCode = parseInt(exitCodeMatch[1], 10);
      // Check if output contains a valid verdict despite non-zero exit
      // (common cause: Gemini SessionEnd hook exits non-zero, but response is fine)
      const hasValidVerdict = parseVerdictLine(result) !== null;
      // Substantial output must contain model content, not just hook/framework logs
      const isFrameworkNoise = /^(Created execution plan|Hook execution|Expanding hook|Attempt \d+ failed|Keychain|AgentRegistry|\[ERROR\])/m.test(result) && parseVerdictLine(result) === null && !/\b(APPROVE|REJECT|FLAG|verdict|reasoning)\b/i.test(result);
      const hasSubstantialOutput = result.length > 100 && !isFrameworkNoise;

      if (hasValidVerdict || hasSubstantialOutput) {
        // Valid output despite non-zero exit -- treat as success with warning
        const latencyMs = Date.now() - startMs;
        const providerName = provider.provider || provider.name;
        const verdict = parseVerdictLine(result) || 'UNKNOWN';
        const l1Detect = result.includes('[OUTPUT TRUNCATED at 10MB');
        process.stderr.write('[call-quorum-slot] WARNING: ' + slot + ' CLI exited non-zero (code ' + cliExitCode + ') but produced valid output -- treating as available\n');
        recordTelemetry(slot, roundNum, verdict, latencyMs, providerName, 'available_with_warning', retryCount, null, l1Detect, l1Detect ? 'L1' : null, null, result.slice(0, 500), result.length, cliExitCode);
        clearFailureOnSuccess(slot);
        writeInnerOutputFile(result);
        process.stdout.write(result);
        if (!result.endsWith('\n')) process.stdout.write('\n');
        appendTokenSentinel(slot);
        process.exit(0);
      }

      // No valid output -- original unavailable behavior
      const latencyMs = Date.now() - startMs;
      const providerName = provider.provider || provider.name;
      const errorType = classifyErrorType(result);
      recordTelemetry(slot, roundNum, 'FLAG', latencyMs, providerName, 'unavailable', retryCount, errorType, false, null, null, result.slice(0, 500), result.length, cliExitCode);
      writeFailureLog(slot, result, '');
      setScoreboardCooldown(slot, result);
      // Still output the result so quorum-slot-dispatch can parse it
      process.stdout.write(result);
      if (!result.endsWith('\n')) process.stdout.write('\n');
      appendTokenSentinel(slot);
      process.exit(1);
    }

    // Extract verdict from result using the anchored verdict-line parser
    const verdict = parseVerdictLine(result) || 'UNKNOWN';
    const latencyMs = Date.now() - startMs;
    const providerName = provider.provider || provider.name;

    const l1Detect = result.includes('[OUTPUT TRUNCATED at 10MB');
    recordTelemetry(slot, roundNum, verdict, latencyMs, providerName, 'available', retryCount, null, l1Detect, l1Detect ? 'L1' : null, null, result.slice(0, 500), result.length, 0);

    // Slot succeeded — clear any failure records so next quorum run doesn't skip it
    clearFailureOnSuccess(slot);

    writeInnerOutputFile(result);
    process.stdout.write(result);
    if (!result.endsWith('\n')) process.stdout.write('\n');
    appendTokenSentinel(slot);
    process.exit(0);
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const providerName = provider.provider || provider.name;

    const errorType = classifyErrorType(err.message);

    recordTelemetry(slot, roundNum, 'FLAG', latencyMs, providerName, 'unavailable', 0, errorType, false, null, null, err.message.slice(0, 500), 0, null);

    process.stderr.write(`[call-quorum-slot] ${err.message}\n`);
    writeFailureLog(slot, err.message, '');
    setScoreboardCooldown(slot, err.message);
    appendTokenSentinel(slot);
    process.exit(1);
  }
}

// Guard main() so require() from tests doesn't trigger process.exit()
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`[call-quorum-slot] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// ─── Test exports (SHELL-ESCAPE-01, TRUNC-01, INFRA-367) ───────────────────────
module.exports = { buildSpawnArgs, stallTimeoutFor, recordTelemetry, findProjectRoot, writeFailureLog, atomicUpdateJson, VERDICTS, VERDICT_LINE_RE, parseVerdictLine };
