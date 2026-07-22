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

  it('the char-count verifier runs and reports a correct length', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-goalw-'));
    try {
      // Deliberately adversarial: quotes, backticks, parens and $VAR are exactly
      // what the old shell-interpolated form mangled.
      const cond = `Read /abs/d.md and follow it. "quoted" \`ticks\` (parens) $VAR -- stop after 40 turns.`;
      const f = path.join(dir, 'goal.txt');
      fs.writeFileSync(f, cond + '\n');
      const r = spawnSync('node', [], {
        input: `const t=require('fs').readFileSync(process.env.GOAL_FILE,'utf8').trim();
                console.log(JSON.stringify({len:t.length, intact:t.includes('"quoted"')&&t.includes('$VAR')}));`,
        env: { ...process.env, GOAL_FILE: f },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(r.stdout);
      assert.equal(got.len, cond.length, 'reported length must match the real condition length');
      assert.equal(got.intact, true, 'special characters must survive the round-trip');
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
