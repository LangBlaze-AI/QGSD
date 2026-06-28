'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  computeCacheKey,
  readCache,
  writeCache,
  getGitHead,
  isCacheValid,
} = require('./quorum-cache.cjs');

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir;

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcache-test-'));
  return tmpDir;
}

function cleanTmpDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

function makeEntry(overrides = {}) {
  return {
    version: 1,
    created: new Date().toISOString(),
    ttl_ms: 60_000,
    git_head: 'abc123',
    quorum_active: ['codex-1', 'gemini-1'],
    completed: true,
    results: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('computeCacheKey', () => {
  it('determinism: same inputs produce same hash', () => {
    const slots = [{ slot: 'codex-1' }, { slot: 'gemini-1' }];
    const cfg = ['codex-1', 'gemini-1'];
    const a = computeCacheKey('prompt', 'ctx', slots, cfg, 'HEAD1');
    const b = computeCacheKey('prompt', 'ctx', slots, cfg, 'HEAD1');
    assert.equal(a, b);
  });

  it('different inputs produce different hash', () => {
    const slots = [{ slot: 'codex-1' }];
    const a = computeCacheKey('prompt-A', 'ctx', slots, [], 'HEAD1');
    const b = computeCacheKey('prompt-B', 'ctx', slots, [], 'HEAD1');
    assert.notEqual(a, b);
  });

  it('slot ordering does not affect key', () => {
    const slotsA = [{ slot: 'gemini-1' }, { slot: 'codex-1' }];
    const slotsB = [{ slot: 'codex-1' }, { slot: 'gemini-1' }];
    const a = computeCacheKey('p', 'c', slotsA, [], 'H');
    const b = computeCacheKey('p', 'c', slotsB, [], 'H');
    assert.equal(a, b);
  });

  it('null-byte separator prevents cross-field collisions', () => {
    // "ab" in prompt + "c" in context vs "a" in prompt + "bc" in context
    const slots = [{ slot: 's1' }];
    const a = computeCacheKey('ab', 'c', slots, [], 'H');
    const b = computeCacheKey('a', 'bc', slots, [], 'H');
    assert.notEqual(a, b);
  });

  it('returns 64-char hex string', () => {
    const key = computeCacheKey('p', 'c', [], [], 'H');
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });
});

describe('getGitHead', () => {
  it('returns non-empty string in a git repo', () => {
    const head = getGitHead();
    assert.ok(head.length > 0, 'Expected non-empty git HEAD');
    assert.match(head, /^[0-9a-f]+$/);
  });
});

describe('writeCache + readCache', () => {
  beforeEach(() => makeTmpDir());
  afterEach(() => cleanTmpDir());

  it('roundtrip: write then read returns matching entry', () => {
    const entry = makeEntry();
    const key = 'testkey123';
    writeCache(key, entry, tmpDir);
    const result = readCache(key, tmpDir);
    assert.deepStrictEqual(result.version, 1);
    assert.deepStrictEqual(result.quorum_active, entry.quorum_active);
    assert.equal(result.completed, true);
  });

  it('readCache returns null when TTL expired', async () => {
    const entry = makeEntry({ ttl_ms: 1 });
    const key = 'expired';
    writeCache(key, entry, tmpDir);
    // Wait just enough for TTL to expire
    await new Promise(r => setTimeout(r, 5));
    const result = readCache(key, tmpDir);
    assert.equal(result, null);
  });

  it('readCache returns null when completed field is missing', () => {
    const entry = makeEntry();
    delete entry.completed;
    const key = 'pending';
    writeCache(key, entry, tmpDir);
    const result = readCache(key, tmpDir);
    assert.equal(result, null);
  });

  it('readCache returns null when version is wrong', () => {
    const entry = makeEntry({ version: 2 });
    const key = 'wrongver';
    writeCache(key, entry, tmpDir);
    const result = readCache(key, tmpDir);
    assert.equal(result, null);
  });

  it('readCache returns null for missing file', () => {
    const result = readCache('nonexistent', tmpDir);
    assert.equal(result, null);
  });

  it('readCache returns null when created is missing or invalid', () => {
    const entry = makeEntry({ created: 'not-a-date' });
    const key = 'badcreated';
    writeCache(key, entry, tmpDir);
    assert.equal(readCache(key, tmpDir), null);
  });

  it('readCache returns null when ttl_ms is missing', () => {
    const entry = makeEntry();
    delete entry.ttl_ms;
    const key = 'nottl';
    writeCache(key, entry, tmpDir);
    assert.equal(readCache(key, tmpDir), null);
  });
});

describe('isCacheValid', () => {
  it('returns true when all conditions match', () => {
    const entry = makeEntry({ git_head: 'abc', quorum_active: ['a'] });
    assert.equal(isCacheValid(entry, 'abc', ['a']), true);
  });

  it('returns false when git_head differs', () => {
    const entry = makeEntry({ git_head: 'abc' });
    assert.equal(isCacheValid(entry, 'def', entry.quorum_active), false);
  });

  it('returns false when quorum_active differs', () => {
    const entry = makeEntry({ git_head: 'abc', quorum_active: ['a'] });
    assert.equal(isCacheValid(entry, 'abc', ['a', 'b']), false);
  });

  it('returns false when TTL expired', () => {
    const entry = makeEntry({
      git_head: 'abc',
      quorum_active: ['a'],
      created: new Date(Date.now() - 120_000).toISOString(),
      ttl_ms: 60_000,
    });
    assert.equal(isCacheValid(entry, 'abc', ['a']), false);
  });

  it('returns false for null entry', () => {
    assert.equal(isCacheValid(null, 'abc', []), false);
  });
});

// ADVERSARIAL: computeCacheKey with oversized prompt (1MB) should not crash or hang
// If the function uses a streaming hash or doesn't limit input size, it could cause issues.
describe('computeCacheKey adversarial', () => {
  it('handles oversized prompt (1MB string) without crashing', () => {
    const largePrompt = 'x'.repeat(1024 * 1024); // 1MB string
    const slots = [{ slot: 'codex-1' }];
    const cfg = ['codex-1'];
    let key;
    assert.doesNotThrow(() => {
      key = computeCacheKey(largePrompt, 'ctx', slots, cfg, 'HEAD1');
    }, 'computeCacheKey must not throw on 1MB input');
    assert.ok(typeof key === 'string' && key.length === 64, 'key should still be a 64-char hex string');
  });

  it('handles oversized context_yaml (500KB) without crashing', () => {
    const largeCtx = 'y'.repeat(500 * 1024); // 500KB string
    const slots = [{ slot: 'gemini-1' }];
    let key;
    assert.doesNotThrow(() => {
      key = computeCacheKey('prompt', largeCtx, slots, [], 'HEAD1');
    }, 'computeCacheKey must not throw on 500KB context');
    assert.ok(typeof key === 'string' && key.length === 64, 'key should still be a 64-char hex string');
  });

  it('produces different keys for significantly different large inputs', () => {
    const prompt1 = 'a'.repeat(10000);
    const prompt2 = 'b'.repeat(10000);
    const slots = [{ slot: 'codex-1' }];
    const key1 = computeCacheKey(prompt1, '', slots, [], 'HEAD1');
    const key2 = computeCacheKey(prompt2, '', slots, [], 'HEAD1');
    assert.notEqual(key1, key2, 'different large inputs must produce different keys');
  });
});

describe('computeCacheKey null-slot hardening', () => {
  it('does not throw when slots contains a null entry', () => {
    const slots = [{ slot: 'codex-1' }, null];
    let key;
    assert.doesNotThrow(() => {
      key = computeCacheKey('p', 'c', slots, [], 'H');
    }, 'computeCacheKey must not throw on a null slot element');
    assert.ok(typeof key === 'string' && key.length === 64, 'key should still be a 64-char hex string');
  });

  it('does not throw when slots is a non-array truthy value', () => {
    let key;
    assert.doesNotThrow(() => {
      key = computeCacheKey('p', 'c', { slot: 'x' }, [], 'H');
    });
    assert.ok(typeof key === 'string' && key.length === 64);
  });
});
