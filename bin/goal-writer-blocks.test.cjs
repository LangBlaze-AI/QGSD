'use strict';

// Live-path gate for /nf:goal-writer.
//
// The skill shipped with a char-count verifier that used `node -e`, which the
// nf-node-eval-guard PreToolUse hook DENIES on zsh — so the documented command
// failed every time it ran. lint:isolation and all four skill lints passed it:
// they check for arguments AFTER an eval, never the use of -e itself. Only
// executing the block found it.
//
// This is the recorded "skill live-path test gap" class — bugs ship green
// because tests cover extracted helpers rather than the form that actually runs.
// These tests execute the skill's own embedded blocks.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MD_PATH = path.join(__dirname, '../commands/nf/goal-writer.md');
const MD = fs.readFileSync(MD_PATH, 'utf8');

const ESC = String.fromCharCode(27);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/**
 * Remove ANSI SGR escapes so assertions match human-readable text.
 *
 * The escape byte is built with String.fromCharCode(27) rather than embedded
 * literally: a raw ESC in source is invisible, and any formatter or copy-paste
 * that drops it degrades this to /\[[0-9;]*m/, which strips "[33m" but leaves a
 * bare ESC behind — silently defeating a following \s* match. The test would then
 * pass or fail depending on whether the runner colourises, which is worse than
 * failing outright.
 */
function stripAnsi(s) {
  return String(s).replace(ANSI_SGR, '');
}

/**
 * Env for the shipped verifier, with colour pinned OFF. console.log colourises
 * numeric args via util.inspect, so without this the result depends on whether
 * the developer's shell exports FORCE_COLOR.
 */
function noColorEnv(extra) {
  const env = { ...process.env, ...extra, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return env;
}

/** Bodies of executable shell fences (```bash / ```sh / ```shell). */
function shellBlocks(md) {
  const re = /^```(?:bash|sh|shell)\r?\n([\s\S]*?)^```/gm;
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}

describe('goal-writer — no command form the eval guard rejects', () => {
  it('contains no `node -e` inside an executable shell block', () => {
    const offenders = [];
    shellBlocks(MD).forEach((b, i) => {
      b.split('\n').forEach((line) => {
        if (/(^|[|;&(\s])node\s+-e\b/.test(line)) offenders.push(`block#${i + 1}: ${line.trim()}`);
      });
    });
    assert.deepEqual(
      offenders,
      [],
      'nf-node-eval-guard DENIES `node -e`; use the `node << \'NF_EVAL\'` heredoc form:\n' +
        offenders.join('\n')
    );
  });

  it('uses the heredoc eval form the guard permits', () => {
    assert.match(MD, /node << 'NF_EVAL'/, 'expected at least one guard-safe heredoc eval');
  });
});

describe('goal-writer — embedded blocks actually execute', () => {
  it('every shell block is syntactically valid (bash -n)', () => {
    shellBlocks(MD).forEach((b, i) => {
      // Placeholders like <the condition, verbatim> and <slug> are prose, not shell.
      const src = b.replace(/<[^>\n]{0,80}>/g, 'PLACEHOLDER');
      const r = spawnSync('bash', ['-n'], { input: src, encoding: 'utf8' });
      assert.equal(r.status, 0, `block#${i + 1} is not valid shell:\n${r.stderr}\n--- src ---\n${src}`);
    });
  });

  it('the recurrence-scan grep works under stock POSIX grep, not just GNU', () => {
    // `\w` is a GNU extension; the skill must use a POSIX class so the scan does
    // not silently return nothing on busybox / older BSD.
    const line = shellBlocks(MD).flatMap((b) => b.split('\n')).find((l) => /git log .*grep/.test(l));
    assert.ok(line, 'recurrence-scan command not found in the skill');
    assert.doesNotMatch(line, /\\w/, 'use [[:alnum:]_] instead of the non-POSIX \\w');

    const m = line.match(/grep -[a-zA-Z]*E '([^']+)'/);
    assert.ok(m, `could not extract the grep pattern from: ${line}`);
    const r = spawnSync('bash', ['-c', `printf 'abc1234 fix(x): y\\n' | /usr/bin/grep -icE ${JSON.stringify(m[1])}`], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '1', 'pattern must match a conventional fix commit under stock grep');
  });

  it('the SHIPPED char-count verifier runs and reports a correct length', () => {
    // Extract and execute the skill's actual NF_EVAL body — do NOT reimplement it.
    // A reimplementation stays green when the shipped verifier's input contract or
    // count logic changes, which is the very live-path gap this file exists to close.
    const m = MD.match(/node << 'NF_EVAL'\r?\n([\s\S]*?)\r?\nNF_EVAL/);
    assert.ok(m, 'could not extract the NF_EVAL verifier from the skill');
    const verifier = m[1];
    assert.match(verifier, /GOAL_FILE/, 'shipped verifier is expected to read process.env.GOAL_FILE');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-goalw-'));
    try {
      // Deliberately adversarial: quotes, backticks, parens and $VAR are exactly
      // what the old shell-interpolated form mangled.
      const cond = `Read /abs/d.md and follow it. "quoted" \`ticks\` (parens) $VAR -- stop after 40 turns.`;
      const f = path.join(dir, 'goal.txt');
      fs.writeFileSync(f, cond + '\n');

      const r = spawnSync('node', [], {
        input: verifier,
        env: noColorEnv({ GOAL_FILE: f }),
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `shipped verifier failed to run:\n${r.stderr}`);
      // It prints e.g. "chars: 96 / 4000 — OK". console.log colourises numeric args
      // via util.inspect, so the count can arrive wrapped in ANSI escapes — strip
      // them before matching. (A reimplementation using JSON.stringify never shows
      // this, which is precisely why the shipped block must be the thing executed.)
      const printed = stripAnsi(r.stdout).match(/chars:\s*(\d+)/);
      assert.ok(printed, `shipped verifier printed no char count:\n${r.stdout}`);
      assert.equal(
        Number(printed[1]),
        cond.length,
        'shipped verifier must report the true condition length (special chars intact)'
      );
      assert.match(stripAnsi(r.stdout), /\bOK\b/, 'a short condition must be reported as OK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the SHIPPED verifier flags an over-limit condition', () => {
    const verifier = MD.match(/node << 'NF_EVAL'\r?\n([\s\S]*?)\r?\nNF_EVAL/)[1];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-goalw-long-'));
    try {
      const f = path.join(dir, 'goal.txt');
      fs.writeFileSync(f, 'x'.repeat(4001));
      const r = spawnSync('node', [], {
        input: verifier,
        env: noColorEnv({ GOAL_FILE: f }),
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(stripAnsi(r.stdout), /TOO LONG/, '4001 chars must be reported as over the /goal limit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('goal-writer — /goal contract facts stay correct', () => {
  // Wrong facts here produce an unsatisfiable condition, which is worse than none:
  // the session spins until its turn cap with no way to succeed.
  it('states the 4000-character limit', () => {
    assert.match(MD, /4000/, 'the /goal character limit must be stated');
  });

  it('warns that /goal has no @file reference syntax', () => {
    assert.match(MD, /no `?@file\.md`? (reference )?syntax|No file references|has no `@file\.md` syntax/i);
  });

  it('requires a turn cap in generated conditions', () => {
    assert.match(MD, /stop after N turns/i, 'generated conditions must carry a turn cap');
  });

  it('records that /goal does not grant tool permissions', () => {
    assert.match(MD, /not.{0,40}per-tool permission|auto mode/i);
  });
});
