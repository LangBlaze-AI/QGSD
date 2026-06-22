'use strict';
// bin/skill-command-correctness.test.cjs
// Guards two thin-wrapper command bugs found by dogfooding:
//   F29 — commands/nf/update.md passed `--project-root=` to migrate-planning.cjs,
//         which only parses `--root <dir>` → migration silently ran on the wrong root.
//   F46 — commands/nf/queue.md wrote the task via `printf '%s' '$ARGUMENTS'`; any task
//         text containing a single quote broke the shell quoting (injection / mangle).
//
// The F46 test is behavioral: it extracts the implementation bash block, substitutes
// $ARGUMENTS the way Claude does (literal text replacement) with a quote-containing
// task, runs it in a temp dir, and asserts the written file round-trips exactly.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');

// ─── F29: update.md migrate-planning flag matches what the script accepts ───

describe('F29 — update.md migrate-planning flag', () => {
  const updateMd = fs.readFileSync(path.join(REPO, 'commands/nf/update.md'), 'utf8');
  const migrateSrc = fs.readFileSync(path.join(REPO, 'bin/migrate-planning.cjs'), 'utf8');

  it('migrate-planning.cjs parses --root (and not --project-root)', () => {
    assert.ok(/indexOf\(['"]--root['"]\)/.test(migrateSrc), 'script should look up --root');
    assert.ok(!/--project-root/.test(migrateSrc), 'script does not accept --project-root');
  });

  it('update.md invokes migrate-planning.cjs with --root, never --project-root', () => {
    const line = updateMd.split('\n').find(l => l.includes('migrate-planning.cjs'));
    assert.ok(line, 'update.md should reference migrate-planning.cjs');
    assert.ok(!/--project-root/.test(updateMd), 'update.md must not use the unrecognized --project-root flag');
    assert.ok(/migrate-planning\.cjs\s+--root\b/.test(updateMd), 'update.md must pass --root');
  });
});

// ─── F46: queue.md writes the task safely even with single quotes ───

// Pull the first ```bash fenced block inside the <implementation> section.
function extractImplBash(md) {
  const impl = md.slice(md.indexOf('<implementation>'));
  const m = impl.match(/```bash\n([\s\S]*?)```/);
  return m ? m[1] : null;
}

describe('F46 — queue.md task write survives single quotes', () => {
  const queueMd = fs.readFileSync(path.join(REPO, 'commands/nf/queue.md'), 'utf8');

  it('no longer inlines $ARGUMENTS into a single-quoted printf (the injection pattern)', () => {
    assert.ok(!queueMd.includes("printf '%s' '$ARGUMENTS'"),
      'the single-quote-wrapped printf is injectable — must be replaced');
  });

  it('writes a quote-containing task verbatim (round-trip)', () => {
    const bash = extractImplBash(queueMd);
    assert.ok(bash, 'implementation bash block must exist');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-queue-'));
    try {
      // Claude substitutes $ARGUMENTS literally before the shell runs it.
      const task = `/nf:quick "it's a test" && echo $(whoami)`;
      const script = bash.replace(/\$ARGUMENTS/g, task);

      // Run with no session id so it uses the generic pending-task.txt path.
      execFileSync('bash', ['-c', script], {
        cwd: tmp,
        env: { ...process.env, CLAUDE_SESSION_ID: '', CLAUDE_INSTANCE_ID: '' },
        encoding: 'utf8',
      });

      const written = fs.readFileSync(path.join(tmp, '.claude/pending-task.txt'), 'utf8');
      // Consumers (.trim()) the content, so a trailing newline is irrelevant.
      assert.equal(written.trim(), task, 'task must round-trip byte-for-byte after trim');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
