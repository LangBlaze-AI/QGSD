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
const { resolveCli } = require('./resolve-cli.cjs');
const { acquireSlot, releaseSlot, providerKeyFromUrl } = require('./provider-concurrency.cjs');

// ─── Utilities ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

    // Read existing log
    let records = [];
    if (fs.existsSync(logPath)) {
      try {
        records = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        if (!Array.isArray(records)) records = [];
      } catch (_) { records = []; }
    }

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

    fs.writeFileSync(logPath, JSON.stringify(records, null, 2), 'utf8');
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
    let records = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (!Array.isArray(records)) return;
    const before = records.length;
    records = records.filter(r => r.slot !== slotName);
    if (records.length < before) {
      fs.writeFileSync(logPath, JSON.stringify(records, null, 2), 'utf8');
    }
  } catch (_) { /* recovery logging must never interrupt the primary flow */ }
}

// ─── Layer 2: Bridge failure log to scoreboard cooldown ──────────────────────
// After a slot fails, set a cooldown entry in the scoreboard so future dispatches
// skip it immediately. Uses spawnSync for synchronous hook context. Fail-open:
// scoreboard update must never block or crash the dispatch flow.
function setScoreboardCooldown(slotName, errorMsg) {
  try {
    const scoreboardScript = path.join(__dirname, 'update-scoreboard.cjs');
    spawnSync('node', [scoreboardScript, 'set-availability', '--slot', slotName, '--message', errorMsg], { timeout: 3000, stdio: 'pipe' });
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
// Canonical path is ~/.claude/nf-bin/providers.json — all code reads/writes this location.
// __dirname/providers.json (same dir as this script, which lives in nf-bin/) is the first
// fallback. The legacy ~/.claude/nf/bin/ path is checked last for backwards compatibility
// (it may be a symlink to nf-bin/ after migration).
function findProviders() {
  const searchPaths = [
    path.join(__dirname, 'providers.json'),                              // same dir (nf-bin) — canonical
    path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json'),      // installed canonical
    path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json'),   // legacy (pre-migration)
  ];

  // Also derive path from unified-1 MCP server config in ~/.claude.json
  try {
    const claudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const u1args = claudeJson?.mcpServers?.['unified-1']?.args ?? [];
    const serverScript = u1args.find(a => typeof a === 'string' && a.endsWith('unified-mcp-server.mjs'));
    if (serverScript) {
      searchPaths.unshift(path.join(path.dirname(serverScript), 'providers.json'));
    }
  } catch (_) { /* no claude.json — fine */ }

  for (const p of searchPaths) {
    try {
      if (fs.existsSync(p)) {
        const providers = JSON.parse(fs.readFileSync(p, 'utf8')).providers;
        // Skip empty files (the shipped repo source is empty by design); fall through to next path
        if (Array.isArray(providers) && providers.length > 0) return providers;
      }
    } catch (_) { /* try next */ }
  }
  return null;
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
  const isCcr = provider.display_type === 'claude-code-router' ||
    ((provider.resolvedCli ?? provider.cli) && (provider.resolvedCli ?? provider.cli).includes('ccr'));

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
  args = provider.args_template.map(a => (a === '{prompt}' ? safePrompt : a));
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

  return { args, useStdinPrompt, isCcr };
}

// ─── Subprocess dispatch ───────────────────────────────────────────────────────
function runSubprocess(provider, prompt, idleTimeoutMs, hardTimeoutMs, allowedToolsFlag) {
  const { args, useStdinPrompt, isCcr } = buildSpawnArgs(provider, prompt, allowedToolsFlag);

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

  const env  = { ...process.env, ...(provider.env ?? {}) };

  return new Promise((resolve, reject) => {
    let child;
    try {
      // detached: true creates a new process group — required to kill all descendants
      // (ccr → Claude Code → node, opencode → LLM subprocess, etc.)
      // Chain of fallbacks: resolvedCli (preferred, absolute path) → cli (raw field) →
      // mainTool (bare binary name, last resort). Guards against spawn(null) in case the
      // resolution above produced no value.
      const spawnTarget = provider.resolvedCli || provider.cli || provider.mainTool;
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
    const STALL_TIMEOUT_MS = 30000; // tighter idle timeout when CLI has produced < 500 bytes
    const STALL_BYTE_THRESHOLD = 500; // below this = "just a header, probably stalled"

    child.stdout.on('data', d => {
      totalBytesReceived += d.length;
      clearTimeout(idleTimer);
      // Adaptive idle: use tighter 30s timeout when CLI has barely produced output (header-only stall)
      const effectiveIdle = totalBytesReceived < STALL_BYTE_THRESHOLD ? STALL_TIMEOUT_MS : idleTimeoutMs;
      idleTimer = setTimeout(() => { timedOut = true; timeoutType = totalBytesReceived < STALL_BYTE_THRESHOLD ? 'STALL' : 'IDLE'; killGroup(); }, effectiveIdle);
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
      clearTimeout(idleTimer);
      const effectiveIdle = totalBytesReceived < STALL_BYTE_THRESHOLD ? STALL_TIMEOUT_MS : idleTimeoutMs;
      idleTimer = setTimeout(() => { timedOut = true; timeoutType = totalBytesReceived < STALL_BYTE_THRESHOLD ? 'STALL' : 'IDLE'; killGroup(); }, effectiveIdle);
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
function runHttp(provider, prompt, timeoutMs, slotName) {
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
  const lock = acquireSlot(providerKey, maxConcurrency, 30000);

  return new Promise((resolve, reject) => {
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
              resolve(content);
            } else {
              reject(new Error(`[HTTP error: unexpected response] ${data.slice(0, 500)}`));
            }
          } catch (e) {
            reject(new Error(`[HTTP error: JSON parse failed] ${data.slice(0, 500)}`));
          }
        });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        req.destroy();
        reject(new Error(`TIMEOUT after ${timeoutMs}ms`));
      }, timeoutMs);

      req.on('error', (err) => {
        clearTimeout(timer);
        if (!timedOut) reject(new Error(`[HTTP request error: ${err.message}]`));
      });

      req.write(body);
      req.end();
    } finally {
      // Release the provider slot when done (both success and error paths)
      if (lock && lock.release) {
        lock.release();
      }
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
      const hasValidVerdict = /\b(APPROVE|BLOCK|FLAG)\b/.test(result);
      // Substantial output must contain model content, not just hook/framework logs
      const isFrameworkNoise = /^(Created execution plan|Hook execution|Expanding hook|Attempt \d+ failed|Keychain|AgentRegistry|\[ERROR\])/m.test(result) && !/\b(APPROVE|BLOCK|FLAG|verdict|reasoning)\b/i.test(result);
      const hasSubstantialOutput = result.length > 100 && !isFrameworkNoise;

      if (hasValidVerdict || hasSubstantialOutput) {
        // Valid output despite non-zero exit -- treat as success with warning
        const latencyMs = Date.now() - startMs;
        const providerName = provider.provider || provider.name;
        const verdict = (/APPROVE|BLOCK|FLAG/.exec(result) || [])[0] || 'UNKNOWN';
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

    // Extract verdict from result using regex
    const verdict = (/APPROVE|BLOCK|FLAG/.exec(result) || [])[0] || 'UNKNOWN';
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
module.exports = { buildSpawnArgs, recordTelemetry, findProjectRoot };
