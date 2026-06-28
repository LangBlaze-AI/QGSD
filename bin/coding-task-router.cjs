#!/usr/bin/env node
'use strict';

/**
 * coding-task-router.cjs — Coding task delegation to external agent CLIs
 *
 * Handles Mode C coding delegation: builds coding prompts, parses results,
 * routes tasks to named provider slots via call-quorum-slot.cjs.
 *
 * Exported pure functions (testable without subprocess):
 *   buildCodingPrompt, parseCodingResult, routeCodingTask, selectSlot
 *
 * CLI usage:
 *   node coding-task-router.cjs --slot <name> --task <text> [--files <comma-separated>] [--timeout <ms>] [--cwd <dir>]
 */

const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

// ─── Import routing-policy.cjs (fail-open) ─────────────────────────────────
let routingPolicy;
try {
  routingPolicy = require(path.join(__dirname, 'routing-policy.cjs'));
} catch (_) {
  routingPolicy = null;
}

// ─── Import classifyDispatchError from quorum-slot-dispatch.cjs ─────────────
let classifyDispatchError;
try {
  classifyDispatchError = require(path.join(__dirname, 'quorum-slot-dispatch.cjs')).classifyDispatchError;
} catch (_) {
  // Fail-open: if import fails, use a simple fallback
  classifyDispatchError = () => 'UNKNOWN';
}

// ─── buildCodingPrompt ──────────────────────────────────────────────────────
/**
 * Constructs a structured coding task prompt for an external agent CLI.
 *
 * @param {object} opts
 * @param {string}   opts.task        - Description of what to implement/fix/refactor
 * @param {string}   opts.repoDir     - Absolute path to the repository
 * @param {string[]} [opts.files]     - Files the agent should focus on
 * @param {string[]} [opts.constraints] - Optional constraints
 * @param {string}   [opts.context]   - Optional additional context
 * @returns {string} Structured prompt string
 */
function buildCodingPrompt({ task, repoDir, files, constraints, context } = {}) {
  const lines = [];

  lines.push('=== TASK ===');
  lines.push(task || '(no task specified)');
  lines.push('');

  lines.push('=== REPOSITORY ===');
  lines.push(repoDir || process.cwd());
  lines.push('');

  if (files && files.length > 0) {
    lines.push('=== FILES ===');
    for (const f of files) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  if (constraints && constraints.length > 0) {
    lines.push('=== CONSTRAINTS ===');
    for (const c of constraints) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  if (context) {
    lines.push('=== CONTEXT ===');
    lines.push(context);
    lines.push('');
  }

  lines.push('=== OUTPUT FORMAT ===');
  lines.push('When you finish, output a structured result with these fields:');
  lines.push('');
  lines.push('status: SUCCESS | PARTIAL | FAILED');
  lines.push('files_modified: [comma-separated list of files you changed]');
  lines.push('summary: [one-paragraph description of what was done]');
  lines.push('diff_preview: |');
  lines.push('  [optional abbreviated diff of key changes]');

  return lines.join('\n');
}

// ─── parseCodingResult ──────────────────────────────────────────────────────
/**
 * Extracts structured result from CLI output.
 *
 * Fail-open: if parsing fails, returns a fallback object with status UNKNOWN.
 *
 * @param {string} rawOutput - Raw CLI output
 * @returns {object} { status, filesModified, summary, diffPreview, rawOutput }
 */
function parseCodingResult(rawOutput) {
  const output = String(rawOutput || '');

  // Extract status
  const statusMatch = output.match(/^status:\s*(SUCCESS|PARTIAL|FAILED)/mi);
  const status = statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN';

  // Extract files_modified
  const filesMatch = output.match(/^files_modified:\s*\[([^\]]*)\]/mi);
  let filesModified = [];
  if (filesMatch && filesMatch[1].trim()) {
    filesModified = filesMatch[1].split(',').map(f => f.trim()).filter(Boolean);
  }

  // Extract summary
  const summaryMatch = output.match(/^summary:\s*(.+)$/mi);
  const summary = summaryMatch
    ? summaryMatch[1].trim()
    : output.slice(0, 500);

  // Extract diff_preview (block scalar)
  let diffPreview = null;
  const diffMatch = output.match(/^diff_preview:\s*\|?\s*\n([\s\S]*?)(?=\n\S|\n*$)/mi);
  if (diffMatch) {
    diffPreview = diffMatch[1].split('\n').map(l => l.replace(/^  /, '')).join('\n').trim() || null;
  }

  return {
    status,
    filesModified,
    summary,
    diffPreview,
    rawOutput: output,
  };
}

// ─── selectSlot ─────────────────────────────────────────────────────────────
/**
 * Simple slot selection — returns the first subprocess-type provider
 * with has_file_access: true. Pluggable policy placeholder for future
 * Q-learning routing.
 *
 * @param {string} taskType - e.g., "implement", "fix", "refactor", "test"
 * @param {Array} providers - array of provider objects from providers.json
 * @returns {string|null} Provider name string or null
 */
function selectSlot(taskType, providers) {
  if (!Array.isArray(providers)) return null;

  // Drop null / non-object entries so one corrupt provider can't crash the
  // legacy path or poison the policy layer into returning null.
  const safe = providers.filter(p => p && typeof p === 'object');

  // Delegate to policy layer if available (fail-open to legacy behavior)
  if (routingPolicy) {
    try {
      const result = routingPolicy.selectSlotWithPolicy(taskType, safe);
      return result.slot;
    } catch (_) {
      // Fall through to legacy logic
    }
  }

  // Legacy fallback — identical to original behavior
  const candidate = safe.find(
    p => p.type === 'subprocess' && p.has_file_access === true
  );

  return candidate ? candidate.name : null;
}

// ─── recordRoutingReward ────────────────────────────────────────────────────
/**
 * Convenience wrapper for recording routing reward signals.
 * Fail-open: reward recording is best-effort.
 *
 * @param {object} opts
 * @param {string} opts.taskType
 * @param {string} opts.slot
 * @param {number} opts.reward   - 0..1
 * @param {number} [opts.latencyMs]
 */
function recordRoutingReward({ taskType, slot, reward, latencyMs } = {}) {
  if (!routingPolicy) return;
  try {
    const recorder = new routingPolicy.RewardRecorder();
    recorder.record({ taskType, slot, reward, latencyMs });
  } catch (_) {
    // Fail-open: reward recording is best-effort
  }
}

// ─── routeCodingTask ────────────────────────────────────────────────────────
/**
 * Orchestrates coding task delegation to an external agent CLI.
 *
 * Builds the prompt, spawns call-quorum-slot.cjs, and parses the result.
 *
 * @param {object} opts
 * @param {string}   opts.task        - Task description
 * @param {string}   opts.slot        - Provider slot name
 * @param {string}   opts.repoDir     - Repository directory
 * @param {string[]} [opts.files]     - Files to focus on
 * @param {string[]} [opts.constraints] - Constraints
 * @param {string}   [opts.context]   - Additional context
 * @param {number}   [opts.timeout]   - Timeout in ms (default 300000)
 * @returns {Promise<object>} { slot, status, filesModified, summary, diffPreview, latencyMs, rawOutput }
 */
async function routeCodingTask({ task, slot, repoDir, files, constraints, context, timeout }) {
  const effectiveTimeout = timeout || 300000;
  const prompt = buildCodingPrompt({ task, repoDir, files, constraints, context });

  const cqsPath = path.join(__dirname, 'call-quorum-slot.cjs');
  const startMs = Date.now();

  try {
    const output = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(process.execPath, [
          cqsPath,
          '--slot', slot,
          '--timeout', String(effectiveTimeout),
          '--cwd', repoDir || process.cwd(),
        ], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new Error(`[spawn error: ${err.message}]`));
        return;
      }

      child.stdin.write(prompt, 'utf8');
      child.stdin.end();

      let stdout = '';
      let stderr = '';
      const MAX_BUF = 50 * 1024;

      child.stdout.on('data', d => {
        const chunk = d.toString();
        if (stdout.length + chunk.length <= MAX_BUF) {
          stdout += chunk;
        }
      });
      child.stderr.on('data', d => {
        stderr += d.toString().slice(0, 4096);
      });

      child.on('close', (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `Process exited with code ${code}`));
        } else {
          resolve(stdout || stderr || '(no output)');
        }
      });

      child.on('error', (err) => {
        reject(new Error(`[spawn error: ${err.message}]`));
      });
    });

    const latencyMs = Date.now() - startMs;
    const parsed = parseCodingResult(output);

    return {
      slot,
      status: parsed.status,
      filesModified: parsed.filesModified,
      summary: parsed.summary,
      diffPreview: parsed.diffPreview,
      latencyMs,
      rawOutput: output,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const errorOutput = err.message || String(err);

    return {
      slot,
      status: 'UNAVAIL',
      error_type: classifyDispatchError(errorOutput),
      filesModified: [],
      summary: errorOutput.slice(0, 500),
      diffPreview: null,
      latencyMs,
      rawOutput: errorOutput,
    };
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const getArg = (f) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };

  const slot    = getArg('--slot');
  const task    = getArg('--task');
  const filesArg = getArg('--files');
  const timeout = getArg('--timeout');
  const cwd     = getArg('--cwd') || process.cwd();

  if (!slot || !task) {
    process.stderr.write('Usage: node coding-task-router.cjs --slot <name> --task <text> [--files <comma-separated>] [--timeout <ms>] [--cwd <dir>]\n');
    process.exit(1);
  }

  const files = filesArg ? filesArg.split(',').map(f => f.trim()).filter(Boolean) : [];

  routeCodingTask({
    task,
    slot,
    repoDir: cwd,
    files,
    timeout: timeout ? parseInt(timeout, 10) : undefined,
  }).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.status === 'UNAVAIL' ? 1 : 0);
  }).catch(err => {
    process.stderr.write(`[coding-task-router] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

// ─── Module exports ─────────────────────────────────────────────────────────
module.exports = {
  buildCodingPrompt,
  parseCodingResult,
  recordRoutingReward,
  routeCodingTask,
  selectSlot,
};
