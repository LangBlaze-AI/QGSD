'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  buildWorkerArgs, parseWorkerResult, parseCodexJsonl, parseClaudeJson, runWorkerStep, WORKER_FAMILIES,
} = require('./delegate-session.cjs');

describe('buildWorkerArgs — codex', () => {
  it('fresh call (no session) uses `exec` with workspace-write config + json', () => {
    const { bin, args, resumed } = buildWorkerArgs('codex', { prompt: 'do X', cwd: '/repo' });
    assert.equal(bin, 'codex');
    assert.equal(resumed, false);
    assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', 'do X']);
  });
  it('with a session id uses `exec resume <id>` and carries the prompt last', () => {
    const { args, resumed } = buildWorkerArgs('codex', { prompt: 'next step', cwd: '/repo', sessionId: 'uuid-1' });
    assert.equal(resumed, true);
    assert.deepEqual(args, ['exec', 'resume', 'uuid-1', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', 'next step']);
  });
  it('does not use the -C flag (rejected by `exec resume`; cwd comes from spawn)', () => {
    assert.ok(!buildWorkerArgs('codex', { prompt: 'p', cwd: '/repo' }).args.includes('-C'));
    assert.ok(!buildWorkerArgs('codex', { prompt: 'p', cwd: '/repo', sessionId: 'x' }).args.includes('-C'));
  });
});

describe('buildWorkerArgs — claude', () => {
  it('fresh call uses -p --output-format json', () => {
    const { args, resumed } = buildWorkerArgs('claude', { prompt: 'p' });
    assert.equal(resumed, false);
    assert.deepEqual(args, ['-p', '--output-format', 'json', 'p']);
  });
  it('with a session id uses --resume <id>', () => {
    const { args, resumed } = buildWorkerArgs('claude', { prompt: 'p', sessionId: 'sess-9' });
    assert.equal(resumed, true);
    assert.deepEqual(args, ['-p', '--resume', 'sess-9', '--output-format', 'json', 'p']);
  });
});

describe('buildWorkerArgs — guards', () => {
  it('unknown family throws', () => {
    assert.throws(() => buildWorkerArgs('nope', { prompt: 'p' }), /unknown worker family/);
  });
});

describe('parseCodexJsonl', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"019f-abc"}',
    'noise line that is not json',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"FINAL answer"}}',
  ].join('\n');
  it('captures thread_id as session_id and the LAST agent_message as text', () => {
    const r = parseCodexJsonl(jsonl);
    assert.equal(r.session_id, '019f-abc');
    assert.equal(r.text, 'FINAL answer');
  });
  it('tolerates empty/garbage input without throwing', () => {
    assert.deepEqual(parseCodexJsonl('').session_id, null);
    assert.equal(parseCodexJsonl('not json at all').text, '');
  });
});

describe('parseClaudeJson', () => {
  it('reads session_id and result from the JSON object', () => {
    const r = parseClaudeJson('{"session_id":"sess-9","result":"the answer","type":"result"}');
    assert.equal(r.session_id, 'sess-9');
    assert.equal(r.text, 'the answer');
  });
  it('falls back to raw text on non-JSON', () => {
    const r = parseClaudeJson('plain text output');
    assert.equal(r.session_id, null);
    assert.equal(r.text, 'plain text output');
  });
});

// ── runWorkerStep with an injected fake spawn ──────────────────────────────────
function fakeSpawn(stdout, { code = 0, stderr = '' } = {}) {
  return function (bin, args) {
    fakeSpawn.last = { bin, args };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

describe('runWorkerStep (injected spawn)', () => {
  it('first step captures the session id from codex JSONL', async () => {
    const spawnFn = fakeSpawn('{"type":"thread.started","thread_id":"T-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done step 1"}}');
    const r = await runWorkerStep({ family: 'codex', prompt: 'step 1', cwd: '/repo', spawnFn });
    assert.equal(r.status, 'ok');
    assert.equal(r.session_id, 'T-1');
    assert.equal(r.text, 'done step 1');
    assert.equal(r.resumed, false);
    assert.equal(fakeSpawn.last.args[0], 'exec');
    assert.ok(!fakeSpawn.last.args.includes('resume'));
  });

  it('a follow-up step resumes the captured session id', async () => {
    const spawnFn = fakeSpawn('{"type":"thread.started","thread_id":"T-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done step 2"}}');
    const r = await runWorkerStep({ family: 'codex', prompt: 'step 2', cwd: '/repo', sessionId: 'T-1', spawnFn });
    assert.equal(r.resumed, true);
    assert.deepEqual(fakeSpawn.last.args.slice(0, 3), ['exec', 'resume', 'T-1']);
    assert.equal(r.session_id, 'T-1');
  });

  it('non-zero exit → status error, keeps the resumed session id', async () => {
    const spawnFn = fakeSpawn('', { code: 1, stderr: 'boom' });
    const r = await runWorkerStep({ family: 'codex', prompt: 'p', sessionId: 'T-9', spawnFn });
    assert.equal(r.status, 'error');
    assert.equal(r.session_id, 'T-9');
    assert.match(r.error, /boom/);
  });

  it('unknown family fails cleanly (no throw)', async () => {
    const r = await runWorkerStep({ family: 'nope', prompt: 'p' });
    assert.equal(r.status, 'error');
    assert.match(r.error, /unknown worker family/);
  });

  it('a synchronously-throwing spawnFn returns an error result (no ReferenceError from the TDZ)', async () => {
    const spawnFn = () => { throw new Error('ENOENT'); };
    const r = await runWorkerStep({ family: 'codex', prompt: 'p', spawnFn });
    assert.equal(r.status, 'error');
    assert.match(r.error, /spawn: ENOENT/);
    assert.equal(r.session_id, null);
  });
});
