#!/usr/bin/env node
// hooks/nf-context-monitor.js
// PostToolUse hook — context window monitor with budget tracking and smart compact.
//
// Reads context_window metrics from the PostToolUse event payload.
// Injects WARNING or CRITICAL into additionalContext when context usage
// exceeds configurable thresholds. Also injects budget warnings and
// smart compact suggestions at clean workflow boundaries.
// Fails open on all errors.
//
// Config: context_monitor.warn_pct (default 70%) and
//         context_monitor.critical_pct (default 90%) in nf.json.
// Two-layer merge via shared config-loader.

'use strict';

const path = require('path');
const fs = require('fs');
const { loadConfig, shouldRunHook, validateHookInput } = require('./config-loader');
const resolveBin = require('./nf-resolve-bin');

// Continuous verification integration (fail-open: null if module unavailable)
const continuousVerify = (() => {
  try { return require(resolveBin('continuous-verify.cjs')); }
  catch { return null; }
})();

// Append a conformance event to conformance-events.jsonl (fail-open)
function appendConformanceEvent(event) {
  try {
    let eventsPath;
    try {
      const planningPaths = require(resolveBin('planning-paths.cjs'));
      eventsPath = planningPaths.resolveWithFallback(process.cwd(), 'conformance-events');
    } catch {
      eventsPath = path.join(process.cwd(), '.planning', 'telemetry', 'conformance-events.jsonl');
    }
    const dir = path.dirname(eventsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // Fail-open
  }
}

// Detect if the just-completed tool call represents a clean workflow boundary
function detectCleanBoundary(toolName, toolInput) {
  if (toolName !== 'Bash' || !toolInput) return null;
  const input = typeof toolInput === 'string'
    ? toolInput
    : (toolInput && typeof toolInput.command === 'string' ? toolInput.command : '');
  if (input.includes('nf-tools.cjs phase-complete')) return 'phase_complete';
  if (input.includes('nf-tools.cjs commit') && input.includes('VERIFICATION')) return 'verification_done';
  if (input.includes('nf-tools.cjs commit') && input.includes('SUMMARY')) return 'plan_complete';
  if (input.includes('nf-tools.cjs commit')) return 'commit';
  if (input.includes('execute-plan') && input.includes('wave')) return 'wave_barrier';
  return null;
}

// Format a smart compact suggestion
function formatCompactSuggestion(usedPct, boundaryType, compactThreshold, classification) {
  let msg = `SMART COMPACT SUGGESTION: Context at ${usedPct}% (threshold: ${compactThreshold}%) -- clean workflow boundary (${boundaryType}).`;
  if (classification) {
    msg += `\nCurrent task complexity: ${classification.complexity} (${classification.tier} tier).`;
  }
  msg += `\nConsider running /compact now.

What survives compaction:
  + STATE.md Current Position (phase, plan, last activity)
  + Pending task files (.claude/pending-task*.txt)
  + CLAUDE.md project rules

What will be lost:
  - Conversation history and reasoning
  - File contents read during this session
  - Quorum deliberation transcripts
  - Intermediate tool outputs`;
  return msg;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const _eventType = input.hook_event_name || input.hookEventName || 'PostToolUse';
    const _validation = validateHookInput(_eventType, input);
    if (!_validation.valid) {
      process.stderr.write('[nf] WARNING: nf-context-monitor: invalid input: ' + JSON.stringify(_validation.errors) + '\n');
      process.exit(0); // Fail-open
    }

    // Profile guard — exit early if this hook is not active for the current profile
    const config = loadConfig(input.cwd || process.cwd());
    const profile = config.hook_profile || 'standard';
    if (!shouldRunHook('nf-context-monitor', profile)) {
      process.exit(0);
    }

    const ctxWindow = input.context_window;
    if (!ctxWindow || ctxWindow.remaining_percentage == null) {
      process.exit(0); // No context data — fail-open
    }

    const remaining = ctxWindow.remaining_percentage;
    const usedPct = Math.round(100 - remaining);

    const monitorCfg = config.context_monitor || {};
    const warnPct = monitorCfg.warn_pct != null ? monitorCfg.warn_pct : 70;
    const criticalPct = monitorCfg.critical_pct != null ? monitorCfg.critical_pct : 90;

    // Context window message
    let contextMessage = null;
    if (usedPct >= criticalPct) {
      contextMessage =
        `CONTEXT MONITOR CRITICAL: Context window ${usedPct}% used (${Math.round(remaining)}% remaining). ` +
        'STOP new work immediately. Save state and inform the user that context is nearly exhausted. ' +
        'Run /nf:pause-work to save execution state.';
    } else if (usedPct >= warnPct) {
      contextMessage =
        `CONTEXT MONITOR WARNING: Context window ${usedPct}% used (${Math.round(remaining)}% remaining). ` +
        'Begin wrapping up current task. Do not start new complex work. ' +
        'Consider /nf:pause-work to save state.';
    }

    // Budget tracking
    let budgetMessage = null;
    const budgetTracker = (() => {
      try { return require(resolveBin('budget-tracker.cjs')); }
      catch { return null; }
    })();

    const cwd = input.cwd || process.cwd();

    if (budgetTracker) {
      // Check cooldown before attempting downgrade
      const cooldownStatus = budgetTracker.checkCooldown(cwd);
      const status = budgetTracker.computeBudgetStatus(usedPct, config.budget || {}, config.agent_config || {}, cooldownStatus.active);
      if (status.active && status.shouldDowngrade) {
        const downgradeResult = budgetTracker.triggerProfileDowngrade(cwd);
        budgetMessage = budgetTracker.formatBudgetWarning(status, downgradeResult);
        appendConformanceEvent({
          action: 'budget_downgrade',
          ts: new Date().toISOString(),
          budget_used_pct: status.budgetUsedPct,
          estimated_tokens: status.estimatedTokens,
          downgrade: downgradeResult,
        });
      } else if (cooldownStatus.active && budgetTracker.computeBudgetStatus(usedPct, config.budget || {}, config.agent_config || {}).shouldDowngrade) {
        // Would have downgraded but cooldown is active
        appendConformanceEvent({
          action: 'budget_downgrade_cooldown',
          ts: new Date().toISOString(),
          budget_used_pct: status.budgetUsedPct,
          estimated_tokens: status.estimatedTokens,
          cooldown_remaining_ms: cooldownStatus.remainingMs,
        });
      } else if (status.active && status.shouldWarn) {
        budgetMessage = budgetTracker.formatBudgetWarning(status, null);
        appendConformanceEvent({
          action: 'budget_warn',
          ts: new Date().toISOString(),
          budget_used_pct: status.budgetUsedPct,
          estimated_tokens: status.estimatedTokens,
        });
      }
    }

    // Smart compact suggestion
    let compactMessage = null;
    const smartCfg = config.smart_compact || {};
    const compactThreshold = config.smart_compact_threshold_pct || 65;
    if (smartCfg.enabled !== false) {
      if (usedPct >= compactThreshold) {
        // Quorum-in-progress lockout: never suggest compaction during active quorum
        const quorumActive = fs.existsSync(path.join(cwd, '.claude', 'quorum-in-progress'));
        if (!quorumActive) {
          const boundary = detectCleanBoundary(input.tool_name, input.tool_input);
          if (boundary) {
            // Read task classification (fail-open)
            let classification = null;
            try {
              const classificationPath = path.join(cwd, '.planning', 'task-classification.json');
              if (fs.existsSync(classificationPath)) {
                classification = JSON.parse(fs.readFileSync(classificationPath, 'utf8'));
              }
            } catch { /* fail-open */ }
            compactMessage = formatCompactSuggestion(usedPct, boundary, compactThreshold, classification);
          }
        }
      }
    }

    // Continuous verification (advisory, never blocking)
    let verifyMessage = null;
    try {
      if (continuousVerify && config.continuous_verify_enabled !== false) {
        let verifyState = continuousVerify.getVerifyState(cwd);
        if (!verifyState) {
          // First call: initialize state
          let phase = 'unknown';
          try {
            const progressPath = path.join(cwd, '.planning', 'execution-progress.json');
            if (fs.existsSync(progressPath)) {
              const prog = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
              phase = prog.phase || 'unknown';
            }
          } catch { /* fail-open */ }
          verifyState = continuousVerify.initVerifyState(phase);
          continuousVerify.saveVerifyState(cwd, verifyState);
        }

        const triggered = continuousVerify.shouldTriggerVerification(
          input.tool_name, input.tool_input, verifyState
        );

        if (triggered) {
          const runResult = continuousVerify.runChecks(
            cwd, verifyState.accumulated_files, verifyState.timeout_ms || 5000
          );
          verifyState.runs_used += 1;
          verifyState.runs.push(runResult);
          verifyState.accumulated_files = [];
          verifyState.last_run = new Date().toISOString();
          continuousVerify.saveVerifyState(cwd, verifyState);

          // Build warning message for failed checks
          const failedChecks = (runResult.checks || []).filter(c => !c.pass);
          if (failedChecks.length > 0 && verifyState.runs_used <= verifyState.max_runs) {
            const issues = failedChecks.map(c => {
              const out = (c.output || c.reason || '').slice(0, 200);
              return `- ${c.type}: ${out}`;
            }).join('\n');
            verifyMessage = `VERIFICATION WARNING: ${failedChecks.length} issue(s) found in recent code changes.\n${issues}\nFix before completing this task. Budget: ${verifyState.runs_used}/${verifyState.max_runs} runs used.`;
          }
        } else {
          // Save state even if not triggered (accumulated_files may have grown)
          continuousVerify.saveVerifyState(cwd, verifyState);
        }
      }
    } catch {
      // Fail-open: never let verification errors crash the hook
      verifyMessage = null;
    }

    // Combine all messages
    const messages = [contextMessage, budgetMessage, compactMessage, verifyMessage].filter(Boolean);
    if (messages.length === 0) {
      process.exit(0);
    }

    const combined = messages.join('\n\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: combined,
      },
    }));
    process.exit(0);

  } catch (e) {
    if (e instanceof SyntaxError) {
      process.stderr.write('[nf] WARNING: nf-context-monitor: malformed JSON on stdin: ' + e.message + '\n');
    }
    // Fail-open: never crash the user's session on any unexpected error
    process.exit(0);
  }
});

// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark
// modified by benchmark