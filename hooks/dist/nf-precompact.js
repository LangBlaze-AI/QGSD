#!/usr/bin/env node
// hooks/nf-precompact.js
// PreCompact hook — captures nForma session state before context compaction.
// Reads .planning/STATE.md "Current Position" section and any pending task files.
//
// IMPORTANT: the harness does NOT accept hookSpecificOutput/additionalContext for
// the PreCompact event (it validates output against a discriminated union that
// only includes PreToolUse/UserPromptSubmit/PostToolUse/PostToolBatch/Stop) — a
// PreCompact hook that emits it is rejected with "Invalid input" on every
// compaction. Instead we persist the continuation context to a sidecar file
// (.claude/precompact-continuation.txt) and emit NOTHING on stdout; the
// nf-session-start hook injects it via the valid SessionStart channel on the
// post-compaction SessionStart (source: "compact").
//
// Fails open on all errors — never blocks compaction, never writes to stdout.

'use strict';

const fs   = require('fs');
const path = require('path');
const { validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

// Fail-open require of execution-progress module (VERF-01)
const executionProgress = (() => {
  try { return require(resolveBin('execution-progress.cjs')); }
  catch { return null; }
})();

// Fail-open require of memory-store module (MEMP-01, MEMP-04)
const memoryStore = (() => {
  try { return require(resolveBin('memory-store.cjs')); }
  catch { return null; }
})();

// Fail-open require of context-stack module (ORCH-02)
const contextStack = (() => {
  try { return require(resolveBin('context-stack.cjs')); }
  catch { return null; }
})();

// Extract the "## Current Position" section from STATE.md content.
// Returns the trimmed text between "## Current Position" and the next "## " header.
// Returns null if the section is not found.
function extractCurrentPosition(stateContent) {
  const startMarker = '## Current Position';
  const startIdx = stateContent.indexOf(startMarker);
  if (startIdx === -1) return null;

  const afterStart = startIdx + startMarker.length;
  // Find the next section header (## followed by a space at start of line)
  const nextHeaderMatch = stateContent.slice(afterStart).search(/\n## /);
  let section;
  if (nextHeaderMatch === -1) {
    section = stateContent.slice(afterStart);
  } else {
    section = stateContent.slice(afterStart, afterStart + nextHeaderMatch);
  }
  return section.trim() || null;
}

// Read pending task files without consuming them (unlike nf-prompt.js's consumePendingTask).
// Checks .claude/pending-task.txt and .claude/pending-task-*.txt files.
// Returns an array of { filename, content } objects for each file found.
function readPendingTasks(cwd) {
  const claudeDir = path.join(cwd, '.claude');
  const results = [];

  if (!fs.existsSync(claudeDir)) return results;

  // Check generic pending-task.txt first
  const genericFile = path.join(claudeDir, 'pending-task.txt');
  if (fs.existsSync(genericFile)) {
    try {
      const content = fs.readFileSync(genericFile, 'utf8').trim();
      if (content) results.push({ filename: 'pending-task.txt', content });
    } catch (e) {
      process.stderr.write('[nf-precompact] Could not read ' + genericFile + ': ' + e.message + '\n');
    }
  }

  // Check session-scoped pending-task-*.txt files
  try {
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      if (entry.startsWith('pending-task-') && entry.endsWith('.txt') && !entry.endsWith('.claimed')) {
        const filePath = path.join(claudeDir, entry);
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (content) results.push({ filename: entry, content });
        } catch (e) {
          process.stderr.write('[nf-precompact] Could not read ' + filePath + ': ' + e.message + '\n');
        }
      }
    }
  } catch (e) {
    process.stderr.write('[nf-precompact] Could not read .claude dir: ' + e.message + '\n');
  }

  return results;
}

// Read execution progress and increment iteration counter on compaction (VERF-01).
// Returns updated progress object or null if no active execution.
function readExecutionProgress(cwd) {
  if (!executionProgress) return null;
  try {
    const status = executionProgress.getStatus(cwd);
    if (status.status === 'no_progress_file') return null;
    if (status.status !== 'in_progress') return null;
    // Increment iteration count (only happens on compaction, not on status checks)
    const updated = executionProgress.incrementIteration(cwd);
    return updated;
  } catch (e) {
    process.stderr.write('[nf-precompact] Could not read execution progress: ' + e.message + '\n');
    return null;
  }
}

// Format execution progress as injection block for compaction continuation context.
// Returns string or null. Output capped at 3200 characters.
function formatProgressInjection(progress) {
  if (!progress) return null;

  const completed = progress.tasks.filter(t => t.status === 'complete');
  const completedCount = completed.length;
  const next = progress.tasks.find(t => t.status === 'pending' || t.status === 'in_progress');

  const lines = [
    '## Execution Progress (auto-injected at compaction)',
    '',
    'Plan: ' + progress.plan_file,
    'Status: ' + progress.status + ' (' + completedCount + '/' + progress.total_tasks + ' tasks complete, iteration ' + progress.iteration_count + ' of ' + progress.max_iterations + ')',
  ];

  if (progress.status === 'failed') {
    lines.push('');
    lines.push('EXECUTION FAILED: ' + progress.failure_reason);
    lines.push('Report this failure to the user. Do NOT continue execution.');
    return lines.join('\n');
  }

  // For plans with 6+ completed tasks, summarize instead of listing all
  if (completedCount > 5) {
    lines.push('');
    lines.push('Tasks 1-' + completedCount + ' complete. Resume at Task ' + (next ? next.number : 'N/A') + '.');
  } else if (completedCount > 0) {
    lines.push('');
    lines.push('Completed tasks:');
    for (const t of completed) {
      lines.push('  [x] ' + t.name + ' (commit ' + (t.commit_hash || 'unknown') + ')');
    }
  }

  if (next) {
    lines.push('');
    lines.push('Resume at:');
    lines.push('  [ ] ' + next.name);
    lines.push('');
    lines.push('IMPORTANT: Read ' + progress.plan_file + ' and continue from Task ' + next.number + '.');
    lines.push('Do NOT re-execute Tasks 1-' + completedCount + ' -- they are already committed.');
  }

  const result = lines.join('\n');
  // Cap at 3200 characters (800 token estimate)
  if (result.length > 3200) {
    // Truncate completed task list but keep header + resume instruction
    const headerEnd = result.indexOf('Completed tasks:');
    const resumeStart = result.indexOf('Resume at:');
    if (headerEnd !== -1 && resumeStart !== -1) {
      return result.slice(0, headerEnd) + 'Tasks 1-' + completedCount + ' complete (truncated for space).\n\n' + result.slice(resumeStart);
    }
    return result.slice(0, 3200);
  }
  return result;
}

// Read memory injection for compaction continuation context.
// Returns formatted string or null if no entries or module unavailable.
function readMemoryInjection(cwd) {
  if (!memoryStore || !memoryStore.formatMemoryInjection) return null;
  try {
    return memoryStore.formatMemoryInjection(cwd);
  } catch (e) {
    process.stderr.write('[nf-precompact] Could not read memory: ' + e.message + '\n');
    return null;
  }
}

// Only register stdin handler when run directly (not when require()'d by tests)
if (require.main === module) {
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const _eventType = input.hook_event_name || input.hookEventName || 'PreCompact';
    const _validation = validateHookInput(_eventType, input);
    if (!_validation.valid) {
      process.stderr.write('[nf] WARNING: nf-precompact: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
      process.exit(0); // Fail-open
    }
    const cwd = input.cwd || process.cwd();

    const statePath = path.join(cwd, '.planning', 'STATE.md');

    let additionalContext;

    if (!fs.existsSync(statePath)) {
      // No STATE.md — minimal context
      additionalContext = 'nForma session resumed after compaction. Run `cat .planning/STATE.md` for project state.';
    } else {
      let stateContent;
      try {
        stateContent = fs.readFileSync(statePath, 'utf8');
      } catch (e) {
        process.stderr.write('[nf-precompact] Could not read STATE.md: ' + e.message + '\n');
        additionalContext = 'nForma session resumed after compaction. Run `cat .planning/STATE.md` for project state.';
        emitOutput(cwd, additionalContext);
        return;
      }

      const currentPosition = extractCurrentPosition(stateContent);
      const pendingTasks = readPendingTasks(cwd);

      const lines = [
        'nForma CONTINUATION CONTEXT (auto-injected at compaction)',
        '',
        '## Current Position',
        currentPosition || '(Could not extract Current Position section — run `cat .planning/STATE.md` for full state.)',
      ];

      if (pendingTasks.length > 0) {
        lines.push('');
        lines.push('## Pending Task');
        // Include the first pending task found (generic file takes priority)
        lines.push(pendingTasks[0].content);
        if (pendingTasks.length > 1) {
          process.stderr.write('[nf-precompact] Multiple pending task files found; injecting first: ' + pendingTasks[0].filename + '\n');
        }
      }

      lines.push('');
      lines.push('## Resume Instructions');
      lines.push('You are mid-session on a nForma project. The context above shows where you were.');
      lines.push('- If a PLAN.md is in progress, continue executing from the current plan.');
      lines.push('- If a pending task is shown above, execute it next.');
      lines.push('- Run `cat .planning/STATE.md` to get full project state if needed.');
      lines.push('- All project rules in CLAUDE.md still apply (quorum required for planning commands).');

      // Execution progress injection (VERF-01)
      const execProgress = readExecutionProgress(cwd);
      const progressBlock = formatProgressInjection(execProgress);
      if (progressBlock) {
        lines.push('');
        lines.push(progressBlock);
      }

      // Memory snapshot injection (MEMP-01, MEMP-04)
      const memoryBlock = readMemoryInjection(cwd);
      if (memoryBlock) {
        lines.push('');
        lines.push(memoryBlock);
      }

      // Learning snapshot injection (LRNG-01, LRNG-04)
      try {
        if (memoryStore && memoryStore.readLastN) {
          const recentFailures = memoryStore.readLastN(cwd, 'failures', 2);
          const recentCorrections = memoryStore.readLastN(cwd, 'corrections', 2);
          if (recentFailures.length > 0 || recentCorrections.length > 0) {
            const learningLines = ['', '## Learning Snapshot (auto-injected at compaction)', ''];
            if (recentFailures.length > 0) {
              learningLines.push('Known failures:');
              for (const f of recentFailures) {
                const approach = (f.approach || '').slice(0, 60);
                const conf = memoryStore.computeCurrentConfidence ? memoryStore.computeCurrentConfidence(f) : (f.confidence || 0.7);
                learningLines.push('  - ' + approach + ' (conf: ' + conf.toFixed(2) + ')');
              }
            }
            if (recentCorrections.length > 0) {
              learningLines.push('Recent corrections:');
              for (const c of recentCorrections) {
                const wrong = (c.wrong_approach || '').slice(0, 50);
                const correct = (c.correct_approach || '').slice(0, 50);
                learningLines.push('  - Not: ' + wrong + ' -> Instead: ' + correct);
              }
            }
            lines.push(...learningLines);
          }
        }
      } catch (_) {}

      // Context stack injection (ORCH-02)
      if (contextStack) {
        try {
          let currentPhase = null;
          if (stateContent) {
            const phaseMatch = stateContent.match(/Phase:\s*(v[\d.]+-\d+)/);
            if (phaseMatch) currentPhase = phaseMatch[1];
          }
          const stackBlock = contextStack.formatInjection(cwd, currentPhase || 'unknown');
          if (stackBlock) {
            lines.push('');
            lines.push(stackBlock);
          }
        } catch (_) { /* fail-open */ }
      }

      additionalContext = lines.join('\n');
    }

    emitOutput(cwd, additionalContext);

  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-precompact: malformed JSON on stdin: ' + e.message + '\n');
    } else {
      process.stderr.write('[nf-precompact] Fatal error: ' + e.message + '\n');
    }
    process.exit(0); // Fail open — never block compaction
  }
});
} // end require.main === module

// Persist the continuation context to a sidecar file for the post-compaction
// SessionStart hook to inject. We do NOT write to stdout: PreCompact output does
// not support hookSpecificOutput.additionalContext (the harness rejects it), so
// handing the context to nf-session-start via .claude/precompact-continuation.txt
// is the only valid channel. nf-session-start consumes-and-deletes the file on
// the next SessionStart (source: "compact"). Fail-open: any write error is
// swallowed so compaction is never blocked.
function emitOutput(cwd, additionalContext) {
  try {
    const claudeDir = path.join(cwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const target = path.join(claudeDir, 'precompact-continuation.txt');
    // Symlink hardening: a pre-planted symlink at the target would make
    // writeFileSync follow it and clobber an arbitrary file. Remove any existing
    // non-regular file first, then write with O_NOFOLLOW so we never traverse a
    // symlink that races in between (TOCTOU-safe). Falls back cleanly on error.
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile()) fs.rmSync(target, { force: true });
    } catch (_) { /* target absent — nothing to clean up */ }
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, additionalContext, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    process.stderr.write('[nf-precompact] Could not persist continuation context: ' + e.message + '\n');
  }
  process.exit(0);
}

// Export helpers for unit testing.
// When require()d by tests, the stdin handler is not registered (require.main guard above).
if (typeof module !== 'undefined') {
  module.exports = module.exports || {};
  module.exports.extractCurrentPosition = extractCurrentPosition;
  module.exports.readPendingTasks = readPendingTasks;
  module.exports.readExecutionProgress = readExecutionProgress;
  module.exports.formatProgressInjection = formatProgressInjection;
  module.exports.readMemoryInjection = readMemoryInjection;
}

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark