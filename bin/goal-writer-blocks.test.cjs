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

/**
 * Whitespace-normalised view of the skill, for prose assertions.
 * Markdown is hard-wrapped, so a phrase like '"Looks fine" is not a check' spans a
 * line break. Matching against raw MD makes the test fail whenever a paragraph is
 * reflowed — a false alarm about formatting dressed up as a contract violation.
 */
const PROSE = MD.replace(/\s+/g, ' ');

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

describe('goal-writer — delivery target drives pr-resolve past merge', () => {
  // A goal whose definition of done is "live in staging" cannot be satisfied by an
  // agent that stops at merge. These assertions are RELATIONAL: a document-wide
  // keyword check passes even when the rule is missing or attached to the wrong
  // clause, which is the failure mode that makes contract tests feel safe and not be.

  /** The prose of a numbered doctrine-section requirement, e.g. section 5. */
  function section(n) {
    const re = new RegExp(`\\n${n}\\. \\*\\*[\\s\\S]*?(?=\\n${n + 1}\\. \\*\\*|\\n</step>)`);
    const m = MD.match(re);
    assert.ok(m, `doctrine section ${n} not found`);
    return m[0].replace(/\s+/g, ' ');
  }
  const SKILL_PROTOCOL = () => section(4);
  const HARD_STOPS = () => section(5);
  const DONE = () => section(6);

  it('defines all three delivery targets with distinct authority', () => {
    for (const t of ['merged', 'staging', 'production']) {
      assert.match(PROSE, new RegExp('`' + t + '`'), `target \`${t}\` must be defined`);
    }
    // merged must authorise nothing beyond merge; production must authorise both envs.
    assert.match(PROSE, /`merged`\s*\|[^|]*\|\s*nothing beyond merge/i,
      'the `merged` row must authorise nothing beyond merge');
    assert.match(PROSE, /`production`\s*\|[^|]*\|\s*staging \*\*and\*\* production/i,
      'the `production` row must authorise staging and production');
  });

  it('canonicalises the target instead of recording a freeform answer', () => {
    assert.match(PROSE, /Canonicalise before using it/i,
      'an answer like "b" must not flow into authorisation logic');
    assert.match(PROSE, /least-privileged/i,
      'a multi-target answer must resolve DOWN, never grant unrequested deploy authority');
    assert.match(PROSE, /re-prompt\*{0,2}\. Do not default/i,
      'an ambiguous target must re-prompt rather than default');
  });

  it('ties the pr-resolve terminus to the target, per target', () => {
    const s = SKILL_PROTOCOL();
    assert.match(s, /nf:pr-resolve/, 'pr-resolve must be addressed in the skill-protocol section');
    assert.match(s, /terminus/i, 'its terminus must be stated');
    // The rule must be attached to the deploying targets specifically.
    assert.match(s, /`staging` → merge, then \*\*follow the deployment through\*\*/,
      'the staging terminus must require following the deployment through');
    assert.match(s, /`merged` → resolve threads, merge, done/,
      'the merged terminus must end at merge');
  });

  it('rejects "pipeline green" as health, in the terminus clause itself', () => {
    const s = SKILL_PROTOCOL();
    assert.match(s, /verify it is \*healthy\* — not merely that the pipeline reported green/i,
      'health must be required in the same clause that defines the terminus');
    assert.match(s, /health check concretely[\s\S]{0,160}endpoint, smoke command, or error-rate signal/i,
      'the health check must be required to be concrete');
  });

  it('scopes merged-but-undeployed to deploying targets only', () => {
    const s = SKILL_PROTOCOL();
    assert.match(s, /Under a deploying target[^.]*merged-but-undeployed PR is an unfinished unit/i,
      'the unfinished-unit rule must be scoped to deploying targets');
    assert.match(s, /Under `merged` this rule does not apply/i,
      'under `merged` the rule must be explicitly disapplied — otherwise the target self-contradicts');
  });

  it('authorises deploy to the target and hard-stops past it, in the hard-stop section', () => {
    const h = HARD_STOPS();
    assert.match(h, /Deploying \*\*to the declared target\*\* is authorised work/i);
    assert.match(h, /Deploying \*\*past\*\* the declared target is a hard stop/i);
    assert.match(h, /`staging` never\s*authorises a production promotion/i,
      'the staging→prod escalation must be named explicitly');
  });

  it('authorises rollback only for a self-driven, unhealthy deploy', () => {
    const h = HARD_STOPS();
    assert.match(h, /Rolling back a deploy this session drove\*{0,2}, when observed unhealthy, is\s*authorised/i,
      'rollback authority must be conditioned on self-driven AND observed-unhealthy');
  });

  it('resolves precedence between deploy authority and the reversibility test', () => {
    const h = HARD_STOPS();
    assert.match(h, /Precedence/i, 'precedence must be stated or the doctrine contradicts itself');
    assert.match(h, /An explicit hard stop always wins/i);
    assert.match(h, /exempt\s*from the reversibility test/i,
      'deployment to the target must be exempted, else the reversibility test forbids it');
    assert.match(h, /If the deploy cannot be rolled back, it is a hard\s*stop again/i,
      'the exemption must be conditional on a known rollback path');
  });

  it('keeps the always-stop list absolute and above the target', () => {
    const h = HARD_STOPS();
    assert.match(h, /Always hard-stop regardless of target/i,
      'the always-stop list must be explicitly target-independent');
    for (const kind of ['publish/release', 'secret', 'destructive git', 'data migrations', 'external communication']) {
      assert.match(h, new RegExp(kind.replace('/', '\\/'), 'i'),
        `${kind} must be in the always-stop list, not merely mentioned somewhere`);
    }
    assert.match(h, /waited on, never bypassed/i, 'approval gates must not be bypassable');
  });

  it('makes the done-checklist unsatisfiable by a merge under a deploying target', () => {
    assert.match(DONE(), /delivery target reached and verified healthy/i);
    assert.match(DONE(), /cannot be satisfied by a merge alone/i);
  });

  it('requires the goal condition end state to name the target, per target', () => {
    assert.match(PROSE, /end state must name the target explicitly/i,
      'without this the evaluator accepts a merge as completion');
    assert.match(PROSE, /`staging`\s*\|\s*"…merged \*\*and\*\* deployed to staging \*\*and\*\* verified healthy there"/i,
      'the staging end-state mapping must be spelled out');
    assert.match(PROSE, /`production`\s*\|\s*"…\*\*and\*\* promoted to production \*\*and\*\* verified healthy there"/i,
      'the production end-state mapping must be spelled out');
  });

  it('requires disclosing that a deploying target auto-deploys', () => {
    assert.match(PROSE, /will deploy (autonomously|without asking)/i);
    assert.match(PROSE, /must not discover it from a log line after the fact/i,
      'disclosure must be up-front, not after the fact');
  });
});
