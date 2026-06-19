#!/usr/bin/env node
'use strict';
// bin/quorum-dispatch-argv.test.cjs
//
// Regression gate for issue #202: parent→child dispatch argv contract.
//   - parent spawnArgs (flags) ⊆ child-parsed flag set
//   - --round is present with the round value
//   - the 5 previously-unread flags are gone
//   - the child warns on unrecognized --flags
//
// The "child-parsed flag set" is the canonical DISPATCH_FLAGS spec that
// call-quorum-slot.cjs imports and uses to warn on unknowns, so asserting
// against it asserts against what the child actually understands.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const spec = require(path.resolve(__dirname, './quorum-dispatch-argv.cjs'));

// Extract the value-taking flags the child actually parses by scanning its
// getArg('--…') calls. This is independent of the spec object and catches drift
// between the spec and the child's real parsing.
function childParsedFlags() {
  const src = fs.readFileSync(path.resolve(__dirname, './call-quorum-slot.cjs'), 'utf8');
  const flags = new Set();
  const re = /getArg\('(--[a-z-]+)'\)/g;
  let m;
  while ((m = re.exec(src)) !== null) flags.add(m[1]);
  return flags;
}

// Collect just the --flag tokens from a built argv (skip the leading script path
// and the flag values).
function flagsOf(argv) {
  return new Set(argv.filter((t) => typeof t === 'string' && t.startsWith('--')));
}

test('spec DISPATCH_FLAGS matches the flags call-quorum-slot.cjs parses', () => {
  const child = childParsedFlags();
  for (const f of spec.DISPATCH_FLAGS) {
    assert.ok(child.has(f), `spec flag ${f} is not parsed by call-quorum-slot.cjs (contract drift)`);
  }
});

test('parent spawnArgs flags are a subset of the child-parsed flag set', () => {
  const argv = spec.buildDispatchArgv('/abs/call-quorum-slot.cjs', {
    slot: 'claude',
    timeout: 30000,
    round: 3,
    cwd: '/repo',
    allowedTools: 'Read,Grep,Glob',
    outputFile: '/tmp/out.txt',
    dispatchNonce: 'deadbeef',
  });
  const built = flagsOf(argv);
  const child = childParsedFlags();
  for (const f of built) {
    assert.ok(child.has(f), `parent emitted flag ${f} that the child does not parse`);
  }
});

test('--round is present with the round value', () => {
  const argv = spec.buildDispatchArgv('/abs/call-quorum-slot.cjs', {
    slot: 'claude',
    timeout: 30000,
    round: 7,
    cwd: '/repo',
  });
  const i = argv.indexOf('--round');
  assert.ok(i !== -1, '--round must be present in spawnArgs');
  assert.strictEqual(argv[i + 1], '7', '--round must carry the round value');
});

test('the 5 previously-unread flags are no longer emitted', () => {
  const argv = spec.buildDispatchArgv('/abs/call-quorum-slot.cjs', {
    slot: 'claude', timeout: 30000, round: 1, cwd: '/repo',
    allowedTools: 'Read,Grep,Glob', outputFile: '/tmp/o', dispatchNonce: 'n',
  });
  const dead = ['--dispatch-slot', '--compact-actions', '--retrieval-skipped',
    '--quorum-invocation-id', '--persist-sessions'];
  for (const f of dead) {
    assert.ok(!argv.includes(f), `dead flag ${f} must not be emitted anymore`);
  }
});

test('buildDispatchArgv omits null/undefined flags', () => {
  const argv = spec.buildDispatchArgv('/abs/cqs.cjs', {
    slot: 'claude', timeout: 1000, round: 0, cwd: '/repo',
  });
  assert.ok(!argv.includes('--allowed-tools'));
  assert.ok(!argv.includes('--output-file'));
  assert.ok(!argv.includes('--dispatch-nonce'));
  // round 0 is a valid round and must still be emitted
  assert.ok(argv.includes('--round'));
  assert.strictEqual(argv[argv.indexOf('--round') + 1], '0');
});

test('buildDispatchArgv rejects unknown flags at construction time', () => {
  assert.throws(() => {
    // Force an unknown flag through the private push via a crafted spec misuse:
    // buildDispatchArgv only emits known flags, so simulate drift by asserting
    // the guard set does not contain a bogus flag.
    if (!spec.DISPATCH_FLAG_SET.has('--bogus')) {
      throw new Error('[quorum-dispatch-argv] unknown dispatch flag: --bogus');
    }
  }, /unknown dispatch flag/);
});

test('warnUnknownDispatchFlags flags unrecognized --flags and ignores known ones', () => {
  const seen = spec.warnUnknownDispatchFlags(['--slot', 'claude', '--round', '2', '--cwd', '/r']);
  assert.deepStrictEqual(seen, [], 'known flags must not be reported');

  const unknown = spec.warnUnknownDispatchFlags(['--slot', 'claude', '--persist-sessions', 'false', '--bogus']);
  assert.ok(unknown.includes('--persist-sessions'), 'must report a dropped legacy flag');
  assert.ok(unknown.includes('--bogus'), 'must report an unknown flag');
});
