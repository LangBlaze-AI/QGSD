#!/usr/bin/env node
'use strict';

/**
 * delegate-session.cjs — resumable cross-LLM worker sessions (piece #1).
 *
 * The delegation path (Mode C / coding-task-router) is one-shot today: every call
 * re-serializes context as text and the worker forgets everything between steps.
 * This module lets a worker CLI keep a NATIVE conversation across steps by capturing
 * its session id on the first call and resuming it on the next — so the manager
 * (Claude) continues the SAME worker instead of re-explaining state each step.
 *
 * Proven end-to-end against real `codex exec` (thread.started → thread_id → `codex
 * exec resume <id>`). `claude -p --resume` is wired the same way. Families without a
 * resume mechanism report supportsSession:false so callers fall back to text-context.
 *
 * Split PURE (testable, no subprocess) / IMPURE (spawns the CLI):
 *   PURE  : buildWorkerArgs, parseWorkerResult
 *   IMPURE: runWorkerStep (spawnFn injectable)
 */

const { spawn } = require('child_process');

// ── Per-family worker command shape ──────────────────────────────────────────
// freshArgs: first turn (no session yet). resumeArgs: continue an existing session.
// parse(stdout) → { session_id, text, raw } extracted from the CLI's structured output.
const WORKER_FAMILIES = {
  codex: {
    bin: 'codex',
    supportsSession: true,
    // codex exec --json emits JSONL; first event is {type:'thread.started',thread_id}.
    // Sandbox is set via `-c sandbox_mode=workspace-write` (a config override valid on
    // BOTH `exec` and `exec resume` — the `--sandbox`/`-C` FLAGS are rejected by the
    // resume subcommand). The working root comes from the spawn cwd, not `-C`.
    freshArgs: ({ prompt }) => [
      'exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', prompt,
    ],
    resumeArgs: ({ prompt, sessionId }) => [
      'exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', prompt,
    ],
    parse: parseCodexJsonl,
  },
  claude: {
    bin: 'claude',
    supportsSession: true,
    // claude -p --output-format json returns a single JSON object carrying session_id + result.
    freshArgs: ({ prompt }) => ['-p', '--output-format', 'json', prompt],
    resumeArgs: ({ prompt, sessionId }) => ['-p', '--resume', sessionId, '--output-format', 'json', prompt],
    parse: parseClaudeJson,
  },
};

/**
 * PURE — parse codex `exec --json` JSONL. session_id = first thread.started's
 * thread_id; text = last completed agent_message. Tolerates non-JSON noise lines.
 * @param {string} stdout
 * @returns {{ session_id: string|null, text: string, raw: string }}
 */
function parseCodexJsonl(stdout) {
  let sessionId = null;
  let text = '';
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(t); } catch (_) { continue; }
    if (ev.type === 'thread.started' && ev.thread_id && !sessionId) sessionId = ev.thread_id;
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
      text = ev.item.text; // last agent_message wins
    }
  }
  return { session_id: sessionId, text, raw: String(stdout || '') };
}

/**
 * PURE — parse claude `-p --output-format json` (a single JSON object with
 * session_id + result). Falls back to raw text if it isn't valid JSON.
 * @param {string} stdout
 * @returns {{ session_id: string|null, text: string, raw: string }}
 */
function parseClaudeJson(stdout) {
  const raw = String(stdout || '');
  const i = raw.indexOf('{');
  if (i !== -1) {
    try {
      const j = JSON.parse(raw.slice(i));
      return { session_id: j.session_id || null, text: typeof j.result === 'string' ? j.result : (j.text || ''), raw };
    } catch (_) { /* fall through */ }
  }
  return { session_id: null, text: raw.trim(), raw };
}

/**
 * PURE — build the argv for one worker step. When sessionId is set AND the family
 * supports sessions, produces the resume form; otherwise the fresh form.
 * @param {string} family  - e.g. 'codex' | 'claude'
 * @param {object} opts     - { prompt, cwd?, sessionId? }
 * @returns {{ bin: string, args: string[], resumed: boolean }}
 * @throws if the family is unknown
 */
function buildWorkerArgs(family, opts = {}) {
  const fam = WORKER_FAMILIES[family];
  if (!fam) throw new Error(`unknown worker family: ${family}`);
  const resume = !!(opts.sessionId && fam.supportsSession);
  const args = resume ? fam.resumeArgs(opts) : fam.freshArgs(opts);
  return { bin: fam.bin, args, resumed: resume };
}

/**
 * PURE — parse a worker family's stdout into { session_id, text, raw }.
 */
function parseWorkerResult(family, stdout) {
  const fam = WORKER_FAMILIES[family];
  if (!fam) throw new Error(`unknown worker family: ${family}`);
  return fam.parse(stdout);
}

/**
 * IMPURE — run one worker step. On the first step omit sessionId; capture the
 * returned session_id and pass it back on the next step to continue the SAME
 * conversation. spawnFn is injectable for tests.
 *
 * @param {object} opts
 * @param {string} opts.family
 * @param {string} opts.prompt
 * @param {string} [opts.cwd]
 * @param {string} [opts.sessionId]  - continue an existing session
 * @param {number} [opts.timeout]    - ms (default 600000)
 * @param {Function} [opts.spawnFn]  - child_process.spawn-compatible
 * @returns {Promise<{ session_id: string|null, text: string, status: 'ok'|'error', code: number|null, resumed: boolean, error?: string }>}
 */
function runWorkerStep(opts = {}) {
  const { family, prompt, cwd, sessionId, timeout = 600000 } = opts;
  const spawnFn = opts.spawnFn || spawn;
  let built;
  try {
    built = buildWorkerArgs(family, { prompt, cwd, sessionId });
  } catch (err) {
    return Promise.resolve({ session_id: null, text: '', status: 'error', code: null, resumed: false, error: err.message });
  }
  return new Promise((resolve) => {
    // `timer` MUST be declared before `finish` — a synchronous spawnFn throw calls
    // finish() from the catch below, and clearTimeout(timer) would otherwise hit the
    // const's temporal dead zone (ReferenceError instead of the intended error result).
    let child, timer, done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    try {
      child = spawnFn(built.bin, built.args, { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return finish({ session_id: null, text: '', status: 'error', code: null, resumed: built.resumed, error: `spawn: ${err.message}` });
    }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish({ session_id: sessionId || null, text: '', status: 'error', code: null, resumed: built.resumed, error: `timeout after ${timeout}ms` }); }, timeout);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString().slice(0, 8192); });
    child.on('error', (e) => finish({ session_id: sessionId || null, text: '', status: 'error', code: null, resumed: built.resumed, error: `spawn: ${e.message}` }));
    child.on('close', (code) => {
      const parsed = parseWorkerResult(family, out);
      finish({
        // Prefer a freshly-captured session id; keep the one we resumed with otherwise.
        session_id: parsed.session_id || sessionId || null,
        text: parsed.text,
        status: code === 0 ? 'ok' : 'error',
        code,
        resumed: built.resumed,
        ...(code === 0 ? {} : { error: (err || `exit ${code}`).slice(0, 500) }),
      });
    });
  });
}

module.exports = {
  WORKER_FAMILIES,
  parseCodexJsonl,
  parseClaudeJson,
  buildWorkerArgs,
  parseWorkerResult,
  runWorkerStep,
};
