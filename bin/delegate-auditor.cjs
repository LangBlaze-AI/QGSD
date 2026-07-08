#!/usr/bin/env node
'use strict';

/**
 * delegate-auditor.cjs — independent auditor for the worker+auditor loop (piece #3).
 *
 * After a worker step edits the repo, an auditor reviews the resulting DIFF. By design
 * the auditor is:
 *   • INDEPENDENT — a different model family than the worker (Claude audits Codex, etc.)
 *   • FRESH each step — NO session (deliberately no memory; independence beats recall for
 *     a reviewer, the same reason the quorum uses independent voters), and
 *   • READ-ONLY — it reviews the diff as text; it never edits files.
 *
 * It returns a structured verdict the manager gates on: APPROVE (move on), REVISE (send
 * the issues back to the SAME worker session), or BLOCK (stop — the step is wrong).
 *
 * PURE  : buildAuditPrompt, parseAuditVerdict
 * IMPURE: runAudit (dispatches a fresh read-only reviewer via delegate-session)
 */

const { runWorkerStep } = require('./delegate-session.cjs');

const VERDICTS = ['APPROVE', 'REVISE', 'BLOCK'];

/**
 * PURE — build the auditor's review prompt. The diff is given as TEXT (the auditor
 * needs no file access). Asks for a strict, machine-parseable verdict block.
 * @param {object} o
 * @param {string} o.stepGoal   - what the worker was asked to do this step
 * @param {string} o.diff       - unified diff the worker produced
 * @param {string} [o.taskContext] - overall task, for grounding
 * @returns {string}
 */
function buildAuditPrompt({ stepGoal, diff, taskContext }) {
  const lines = [
    'You are an INDEPENDENT code auditor. Another AI worker just made a change. Review ONLY',
    'the diff below against the step goal. Do NOT edit files — this is a read-only review.',
    '',
  ];
  if (taskContext) lines.push('Overall task: ' + taskContext, '');
  lines.push('Step goal: ' + (stepGoal || '(unspecified)'), '');
  lines.push('--- BEGIN DIFF ---', String(diff || '(empty diff)'), '--- END DIFF ---', '');
  lines.push(
    'Judge: does the diff correctly and completely achieve the step goal, with no bugs,',
    'regressions, security issues, or weakened tests/guards? Then output EXACTLY this block',
    'as the LAST thing you say (nothing after it):',
    '',
    'VERDICT: <APPROVE|REVISE|BLOCK>',
    'ISSUES:',
    '- <one concrete, actionable issue per line, or "none">',
    'SUMMARY: <one sentence>',
    '',
    'APPROVE = correct and complete. REVISE = fixable issues the worker should address.',
    'BLOCK = fundamentally wrong / unsafe / must not proceed.',
  );
  return lines.join('\n');
}

/**
 * PURE — parse the auditor's VERDICT/ISSUES/SUMMARY block from its output. Tolerant of
 * surrounding prose; scans from the LAST 'VERDICT:' occurrence. Unrecognized/absent
 * verdict fails SAFE to REVISE (never silently APPROVE).
 * @param {string} text
 * @returns {{ verdict:'APPROVE'|'REVISE'|'BLOCK', issues:string[], summary:string, parsed:boolean }}
 */
function parseAuditVerdict(text) {
  const raw = String(text || '');
  const vIdx = raw.toUpperCase().lastIndexOf('VERDICT:');
  if (vIdx === -1) {
    return { verdict: 'REVISE', issues: ['auditor produced no VERDICT block'], summary: '', parsed: false };
  }
  const tail = raw.slice(vIdx);
  const vMatch = tail.match(/VERDICT:\s*(APPROVE|REVISE|BLOCK)/i);
  const verdict = vMatch ? vMatch[1].toUpperCase() : 'REVISE';

  const issues = [];
  const issuesMatch = tail.match(/ISSUES:\s*([\s\S]*?)(?:SUMMARY:|$)/i);
  if (issuesMatch) {
    for (const line of issuesMatch[1].split('\n')) {
      const t = line.replace(/^\s*[-*]\s*/, '').trim();
      if (t && !/^none$/i.test(t)) issues.push(t);
    }
  }
  const sMatch = tail.match(/SUMMARY:\s*(.+)/i);
  const summary = sMatch ? sMatch[1].trim() : '';
  return { verdict: VERDICTS.includes(verdict) ? verdict : 'REVISE', issues, summary, parsed: !!vMatch };
}

/**
 * IMPURE — run one audit. Dispatches a FRESH (no session), READ-ONLY reviewer of a
 * DIFFERENT family than the worker. Returns the parsed verdict plus the raw text.
 * @param {object} o
 * @param {string} o.family     - reviewer family (should differ from the worker's)
 * @param {string} o.stepGoal
 * @param {string} o.diff
 * @param {string} [o.taskContext]
 * @param {string} [o.cwd]
 * @param {number} [o.timeout]
 * @param {Function} [o.runFn]  - injectable (defaults to delegate-session.runWorkerStep)
 * @returns {Promise<{verdict, issues, summary, parsed, status, raw, error?}>}
 */
async function runAudit(o = {}) {
  const runFn = o.runFn || runWorkerStep;
  const prompt = buildAuditPrompt({ stepGoal: o.stepGoal, diff: o.diff, taskContext: o.taskContext });
  const res = await runFn({
    family: o.family,
    prompt,
    cwd: o.cwd,
    sandbox: 'read-only',   // auditor must never edit
    // NO sessionId — a fresh, independent reviewer every step
    timeout: o.timeout || 300000,
  });
  if (!res || res.status !== 'ok') {
    // A dead auditor must not read as APPROVE — fail safe to REVISE.
    return { verdict: 'REVISE', issues: ['auditor dispatch failed: ' + ((res && res.error) || 'unknown')], summary: '', parsed: false, status: 'error', raw: (res && res.text) || '' };
  }
  const parsed = parseAuditVerdict(res.text);
  return { ...parsed, status: 'ok', raw: res.text };
}

module.exports = { VERDICTS, buildAuditPrompt, parseAuditVerdict, runAudit };
