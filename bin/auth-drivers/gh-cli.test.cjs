'use strict';
// Tests for bin/auth-drivers/gh-cli.cjs
// node --test bin/auth-drivers/gh-cli.test.cjs

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// Capture the real child_process before any mocking.
const realCp    = require('child_process');
const CP_PATH   = require.resolve('child_process');
const GHCLI_PATH = require.resolve('./gh-cli.cjs');

// Inject a mock spawnSync and reload gh-cli.cjs so it picks it up.
function withMockSpawnSync(mockFn, testFn) {
  const savedCp    = require.cache[CP_PATH];
  const savedGhCli = require.cache[GHCLI_PATH];

  require.cache[CP_PATH] = {
    id: CP_PATH, filename: CP_PATH, loaded: true,
    exports: { ...realCp, spawnSync: mockFn },
  };
  delete require.cache[GHCLI_PATH];

  try {
    return testFn(require('./gh-cli.cjs'));
  } finally {
    if (savedCp)    require.cache[CP_PATH]    = savedCp;
    else            delete require.cache[CP_PATH];
    if (savedGhCli) require.cache[GHCLI_PATH] = savedGhCli;
    else            delete require.cache[GHCLI_PATH];
  }
}

// Fake `gh auth status` output: two accounts, alice active.
const TWO_ACCOUNT_OUTPUT = [
  'github.com',
  '  ✓ Logged in to github.com account alice (keyring)',
  '  - Active account: true',
  '  ✓ Logged in to github.com account bob (keyring)',
  '  - Active account: false',
].join('\n');

// Fake output: one account, active.
const ONE_ACCOUNT_OUTPUT = [
  '  ✓ Logged in to github.com account alice (keyring)',
  '  - Active account: true',
].join('\n');

// ─── 1. parseGhStatus() ───────────────────────────────────────────────────────

test('parseGhStatus returns both accounts and identifies the active one', () => {
  withMockSpawnSync(
    (_cmd, _args, _opts) => ({ stdout: TWO_ACCOUNT_OUTPUT, stderr: '', status: 0 }),
    ({ parseGhStatus }) => {
      const { accounts, active } = parseGhStatus();
      assert.deepStrictEqual(accounts, ['alice', 'bob']);
      assert.strictEqual(active, 'alice');
    },
  );
});

test('parseGhStatus handles a single account', () => {
  withMockSpawnSync(
    () => ({ stdout: ONE_ACCOUNT_OUTPUT, stderr: '', status: 0 }),
    ({ parseGhStatus }) => {
      const { accounts, active } = parseGhStatus();
      assert.deepStrictEqual(accounts, ['alice']);
      assert.strictEqual(active, 'alice');
    },
  );
});

test('parseGhStatus merges stdout and stderr streams', () => {
  // gh writes to stderr; ensure both channels are combined.
  withMockSpawnSync(
    () => ({ stdout: '', stderr: TWO_ACCOUNT_OUTPUT, status: 0 }),
    ({ parseGhStatus }) => {
      const { accounts } = parseGhStatus();
      assert.deepStrictEqual(accounts, ['alice', 'bob']);
    },
  );
});

test('parseGhStatus returns empty results when gh outputs nothing', () => {
  withMockSpawnSync(
    () => ({ stdout: '', stderr: '', status: 1 }),
    ({ parseGhStatus }) => {
      const { accounts, active } = parseGhStatus();
      assert.deepStrictEqual(accounts, []);
      assert.strictEqual(active, null);
    },
  );
});

test('parseGhStatus does not duplicate an account seen twice in output', () => {
  const dupOutput = [
    '  ✓ Logged in to github.com account alice (keyring)',
    '  - Active account: true',
    '  ✓ Logged in to github.com account alice (keyring)',
  ].join('\n');

  withMockSpawnSync(
    () => ({ stdout: dupOutput, stderr: '', status: 0 }),
    ({ parseGhStatus }) => {
      const { accounts } = parseGhStatus();
      assert.strictEqual(accounts.length, 1);
    },
  );
});

test('parseGhStatus does not adopt an active account from a different (non-github.com) host', () => {
  const ENTERPRISE_OUTPUT = [
    'ghe.corp.com',
    '  ✓ Logged in to ghe.corp.com account corpuser (keyring)',
    '  - Active account: true',
    'github.com',
    '  ✓ Logged in to github.com account alice (keyring)',
    '  - Active account: false',
  ].join('\n');

  withMockSpawnSync(
    () => ({ stdout: ENTERPRISE_OUTPUT, stderr: '', status: 0 }),
    ({ parseGhStatus }) => {
      const { accounts, active } = parseGhStatus();
      assert.deepStrictEqual(accounts, ['alice']);
      // active must be a listed github.com account (or null), never the enterprise user.
      assert.strictEqual(active, null);
    },
  );
});

// ─── 2. list() ────────────────────────────────────────────────────────────────

test('list converts parseGhStatus output to { name, active } entries', () => {
  withMockSpawnSync(
    () => ({ stdout: TWO_ACCOUNT_OUTPUT, stderr: '', status: 0 }),
    (driver) => {
      const accounts = driver.list({});
      assert.deepStrictEqual(accounts, [
        { name: 'alice', active: true  },
        { name: 'bob',   active: false },
      ]);
    },
  );
});

// ─── 3. switch() ──────────────────────────────────────────────────────────────

test('switch succeeds when gh exits 0', () => {
  let switchCalled = false;

  withMockSpawnSync(
    (_cmd, args) => {
      if (args[0] === 'auth' && args[1] === 'switch') {
        switchCalled = true;
        return { stdout: '', stderr: '', status: 0 };
      }
      return { stdout: TWO_ACCOUNT_OUTPUT, stderr: '', status: 0 };
    },
    (driver) => {
      assert.doesNotThrow(() => driver.switch({}, 'bob'));
      assert.ok(switchCalled, 'gh auth switch should have been called');
    },
  );
});

test('switch throws when gh exits non-zero', () => {
  withMockSpawnSync(
    (_cmd, args) => {
      if (args[0] === 'auth' && args[1] === 'switch') {
        return { stdout: '', stderr: 'no such user: ghost', status: 1 };
      }
      return { stdout: '', stderr: '', status: 0 };
    },
    (driver) => {
      assert.throws(
        () => driver.switch({}, 'ghost'),
        (err) => {
          assert.ok(err.message.includes('no such user: ghost'), `got: ${err.message}`);
          return true;
        },
      );
    },
  );
});

test('switch rejects a non-string account name with a clean error (no raw ERR_INVALID_ARG_TYPE)', () => {
  let switchCalled = false;
  withMockSpawnSync(
    (_cmd, args) => {
      if (args[0] === 'auth' && args[1] === 'switch') switchCalled = true;
      return { stdout: '', stderr: '', status: 0 };
    },
    (driver) => {
      assert.throws(
        () => driver.switch({}, undefined),
        (err) => {
          assert.strictEqual(err.code, undefined, `expected a controlled Error, got code ${err.code}`);
          assert.ok(/account name/i.test(err.message), `got: ${err.message}`);
          return true;
        },
      );
      assert.strictEqual(switchCalled, false, 'spawn must not be attempted for an invalid name');
    },
  );
});

// ─── 4. null-returning methods ────────────────────────────────────────────────

test('addCredentialFile returns null (gh uses keychain, no file to poll)', () => {
  withMockSpawnSync(
    () => ({ stdout: '', stderr: '', status: 0 }),
    (driver) => {
      assert.strictEqual(driver.addCredentialFile({}), null);
    },
  );
});

test('extractAccountName returns null (gh manages identity internally)', () => {
  withMockSpawnSync(
    () => ({ stdout: '', stderr: '', status: 0 }),
    (driver) => {
      assert.strictEqual(driver.extractAccountName({}), null);
    },
  );
});

// ─── 5. add() ─────────────────────────────────────────────────────────────────

test('add resolves without error (gh auth login handles everything internally)', async () => {
  // add() is a no-op; just verify it returns a resolved Promise.
  const savedGhCli = require.cache[GHCLI_PATH];
  delete require.cache[GHCLI_PATH];

  // No need to mock spawnSync — add() doesn't call it.
  const driver = require('./gh-cli.cjs');

  try {
    await assert.doesNotReject(() => driver.add({}, 'alice'));
  } finally {
    if (savedGhCli) require.cache[GHCLI_PATH] = savedGhCli;
    else            delete require.cache[GHCLI_PATH];
  }
});
