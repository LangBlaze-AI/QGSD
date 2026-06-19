#!/usr/bin/env node
'use strict';
// bin/quorum-content-verdict-integrity.test.cjs
// Issue #203 — content/verdict integrity cluster:
//   (a) anchored verdict parsing with the correct vocab (APPROVE|REJECT|FLAG)
//   (c) trace size cap + pre-spawn CONTEXT_OVERFLOW guard (not SPAWN_ERROR)
//   (d) compaction strips the actually-emitted headings to the closing sentinel
//   (b) CCR prompt mutation is surfaced via promptMutated

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cqs = require('./call-quorum-slot.cjs');
const dispatch = require('./quorum-slot-dispatch.cjs');

// ─── (a) VERDICT PARSING ──────────────────────────────────────────────────────

test('VERDICTS const is the Mode B vocabulary (APPROVE|REJECT|FLAG, never BLOCK)', () => {
  assert.deepStrictEqual([...cqs.VERDICTS].sort(), ['APPROVE', 'FLAG', 'REJECT']);
  assert.ok(!cqs.VERDICTS.includes('BLOCK'), 'BLOCK must not be a verdict');
});

test('parseVerdictLine: anchored verdict line wins', () => {
  assert.strictEqual(cqs.parseVerdictLine('verdict: APPROVE\nreasoning: ok'), 'APPROVE');
  assert.strictEqual(cqs.parseVerdictLine('verdict: REJECT\nreasoning: bad'), 'REJECT');
  assert.strictEqual(cqs.parseVerdictLine('verdict: FLAG'), 'FLAG');
});

test('parseVerdictLine: REJECT is recognized (was missing from legacy vocab)', () => {
  const out = 'reasoning: the change breaks invariant X.\nverdict: REJECT\n';
  assert.strictEqual(cqs.parseVerdictLine(out), 'REJECT');
});

test('parseVerdictLine: "would not APPROVE" in reasoning does NOT register a verdict', () => {
  // Legacy /APPROVE|BLOCK|FLAG/ matched the first keyword anywhere → false APPROVE.
  const out = 'reasoning: I would not APPROVE this because tests fail.\nverdict: REJECT';
  assert.strictEqual(cqs.parseVerdictLine(out), 'REJECT',
    'anchored parser must use the verdict: line, not prose mentions');
});

test('parseVerdictLine: prose-only mention with no verdict: line returns null', () => {
  assert.strictEqual(cqs.parseVerdictLine('I would not approve this code.'), null);
  assert.strictEqual(cqs.parseVerdictLine(''), null);
  assert.strictEqual(cqs.parseVerdictLine(null), null);
});

test('parseVerdictLine: is case-insensitive on the verdict keyword and label', () => {
  assert.strictEqual(cqs.parseVerdictLine('Verdict: approve'), 'APPROVE');
});

test('dispatch parseVerdict (Mode B) defers to anchored line; prose mention ignored', () => {
  // "would not APPROVE" prose + a real REJECT verdict line.
  const out = 'I would not APPROVE.\nverdict: REJECT\nreasoning: fails.';
  assert.strictEqual(dispatch.parseVerdict(out, 'B'), 'REJECT');
});

test('dispatch parseVerdict (Mode B) defaults to FLAG when no verdict line', () => {
  assert.strictEqual(dispatch.parseVerdict('no verdict here', 'B'), 'FLAG');
});

// ─── (c) TRACE SIZE CAP + CONTEXT_OVERFLOW ────────────────────────────────────

test('readBoundedTail returns full content when under cap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbt-small-'));
  const f = path.join(tmp, 'traces.txt');
  try {
    fs.writeFileSync(f, 'small trace');
    assert.strictEqual(dispatch.readBoundedTail(f, 1024, 'traces-file'), 'small trace');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readBoundedTail caps oversized files to a byte tail with an omission marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbt-big-'));
  const f = path.join(tmp, 'traces.txt');
  try {
    // 300KB file, cap at 100KB
    const big = 'A'.repeat(200 * 1024) + 'TAIL_SENTINEL' + 'B'.repeat(100 * 1024);
    fs.writeFileSync(f, big);
    const cap = 100 * 1024;
    const out = dispatch.readBoundedTail(f, cap, 'traces-file');
    assert.ok(out.length <= cap + 200, `capped output must be ~${cap} bytes, got ${out.length}`);
    assert.ok(out.startsWith('[...'), 'must prepend an omission marker');
    assert.ok(out.endsWith('B'.repeat(64)), 'must preserve the file tail');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readBoundedTail returns null for missing file (fail-open, no throw)', () => {
  assert.strictEqual(dispatch.readBoundedTail('/nonexistent/path/xyz', 1024, 'traces-file'), null);
  assert.strictEqual(dispatch.readBoundedTail(null, 1024), null);
});

test('oversized prompt → CONTEXT_OVERFLOW result block, NOT SPAWN_ERROR (E2E dispatch)', () => {
  // An uncapped input (here a 300KB question file) pushes the assembled prompt
  // past the single-arg ceiling. Previously this E2BIG'd the CLI subprocess and
  // surfaced as SPAWN_ERROR; the pre-spawn guard now emits CONTEXT_OVERFLOW
  // BEFORE spawning, so no subprocess is launched.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2big-'));
  const questionFile = path.join(tmp, 'question.txt');
  const outFile = path.join(tmp, 'out.txt');
  try {
    fs.writeFileSync(questionFile, 'Does this satisfy the requirement? ' + 'Z'.repeat(300 * 1024));
    const { spawnSync } = require('node:child_process');
    const res = spawnSync(process.execPath, [
      path.join(__dirname, 'quorum-slot-dispatch.cjs'),
      '--slot', 'gemini-1',
      '--mode', 'B',
      '--round', '1',
      '--question-file', questionFile,
      '--output-file', outFile,
      '--cwd', tmp,
    ], { encoding: 'utf8', timeout: 60000 });

    const blob = (res.stdout || '') + (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '');
    assert.ok(/CONTEXT_OVERFLOW/.test(blob),
      `expected CONTEXT_OVERFLOW in output, got:\n${blob.slice(0, 800)}\nstderr:\n${(res.stderr || '').slice(0, 800)}`);
    assert.ok(!/SPAWN_ERROR/.test(blob),
      'oversized prompt must NOT be misclassified as SPAWN_ERROR');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('multi-MB traces are capped so the prompt stays under the ARG_MAX ceiling (no E2BIG/SPAWN_ERROR)', () => {
  // With the 100KB tail cap, a 3MB traces file can no longer inflate the prompt
  // past the single-arg ceiling — the primary E2BIG fix. We verify the cap keeps
  // the assembled prompt well under the 200KB guard threshold by reading the
  // capped traces directly (the cap is what prevents the spawn-time failure).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const tracesFile = path.join(tmp, 'traces.txt');
  try {
    fs.writeFileSync(tracesFile, 'X'.repeat(3 * 1024 * 1024)); // 3MB
    const capped = dispatch.readBoundedTail(tracesFile, 100 * 1024, 'traces-file');
    assert.ok(capped !== null, 'capped read must succeed');
    assert.ok(Buffer.byteLength(capped, 'utf8') < 200 * 1024,
      'capped traces must be well under the 200KB single-arg ceiling');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── (d) COMPACTION HEADINGS ──────────────────────────────────────────────────

test('stripBlockByHeading strips the FULL precedents section to the closing sentinel', () => {
  const section = dispatch.formatPrecedentsSection([
    { consensus: 'APPROVE', date: '2026-01-01', question: 'q one', outcome: 'shipped' },
    { consensus: 'REJECT', date: '2026-02-01', question: 'q two', outcome: 'reverted' },
  ]);
  // Precedents section contains an internal blank line — the old first-blank-line
  // cut would have left the body. Embed it in a realistic prompt.
  const prompt = `Review this.\n\n${section}\n\nverdict: APPROVE | REJECT | FLAG\n`;
  const out = dispatch.stripBlockByHeading(prompt, '=== PAST QUORUM PRECEDENTS ===');
  assert.ok(out.changed, 'must report changed=true');
  assert.ok(!out.prompt.includes('PAST QUORUM PRECEDENTS'), 'heading must be gone');
  assert.ok(!out.prompt.includes('Outcome: shipped'), 'precedent body must be gone');
  assert.ok(!out.prompt.includes(dispatch.SECTION_END_SENTINEL), 'closing sentinel must be gone');
  assert.ok(out.prompt.includes('Review this.'), 'surrounding text preserved');
  assert.ok(out.prompt.includes('verdict: APPROVE | REJECT | FLAG'), 'trailing text preserved');
});

test('stripBlockByHeading with the WRONG (never-emitted) heading is a no-op', () => {
  const section = dispatch.formatPrecedentsSection([
    { consensus: 'APPROVE', date: '2026-01-01', question: 'q', outcome: 'ok' },
  ]);
  const prompt = `pre\n\n${section}\n\npost`;
  // The legacy stripper used "RELEVANT PRECEDENTS" which is never emitted.
  const out = dispatch.stripBlockByHeading(prompt, '=== RELEVANT PRECEDENTS ===');
  assert.strictEqual(out.changed, false, 'wrong heading must not match → no strip');
  assert.strictEqual(out.prompt, prompt);
});

test('compactPromptToFitBudget actually removes precedent bytes when over budget', () => {
  const precedents = dispatch.formatPrecedentsSection(
    Array.from({ length: 40 }, (_, i) => ({
      consensus: 'APPROVE', date: '2026-01-01',
      question: 'a fairly long precedent question number ' + i + ' '.repeat(40),
      outcome: 'a fairly long precedent outcome number ' + i + ' '.repeat(40),
    }))
  );
  const requirements = dispatch.formatRequirementsSection(
    Array.from({ length: 20 }, (_, i) => ({ id: 'R' + i, text: 'requirement '.repeat(20), category: 'Safety' }))
  );
  const prompt = `Question here.\n\n${precedents}\n\n${requirements}\n\nverdict: APPROVE | REJECT | FLAG`;
  // Tiny budget forces stripping. CCR provider so overhead/limit are applied.
  const provider = { display_type: 'claude-code-router', max_context_tokens: 1, ccr_overhead_tokens: 0, ccr_response_budget_tokens: 0 };
  const result = dispatch.compactPromptToFitBudget(prompt, provider, { charsPerToken: 4 });
  assert.ok(result.actions.includes('stripped_precedents'), `expected stripped_precedents, got ${JSON.stringify(result.actions)}`);
  assert.ok(!result.prompt.includes('PAST QUORUM PRECEDENTS'), 'precedent heading removed');
  assert.ok(result.prompt.length < prompt.length, 'compaction must shrink the prompt');
});

// ─── (b) CCR PROMPT MUTATION SURFACING ────────────────────────────────────────

test('buildSpawnArgs sets promptMutated=true for CCR when $/!/backtick neutralized', () => {
  const provider = {
    display_type: 'claude-code-router',
    args_template: ['-p', '{prompt}', '--dangerously-skip-permissions'],
  };
  const { promptMutated, args } = cqs.buildSpawnArgs(provider, 'cost is $5 and `code`!', null);
  assert.strictEqual(promptMutated, true);
  const promptArg = args.find(a => !a.startsWith('-'));
  assert.ok(!promptArg.includes('$'), 'CCR prompt has $ stripped');
});

test('buildSpawnArgs leaves non-CCR prompts untouched (promptMutated=false)', () => {
  const provider = { type: 'subprocess', args_template: ['-p', '{prompt}'] };
  const original = 'cost is $5 and `code`!';
  const { promptMutated, args } = cqs.buildSpawnArgs(provider, original, null);
  assert.strictEqual(promptMutated, false);
  assert.ok(args.includes(original), 'non-CCR prompt passed verbatim');
});

test('buildSpawnArgs: CCR with no special chars → promptMutated=false', () => {
  const provider = { display_type: 'claude-code-router', args_template: ['-p', '{prompt}'] };
  const { promptMutated } = cqs.buildSpawnArgs(provider, 'plain prompt with no shell chars', null);
  assert.strictEqual(promptMutated, false);
});
