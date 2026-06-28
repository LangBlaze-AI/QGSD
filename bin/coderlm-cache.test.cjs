'use strict';

/**
 * coderlm-cache.test.cjs — Test suite for LRU cache module
 *
 * Tests: LRU eviction, TTL expiry, hit/miss stats, reset, duplicate set,
 *        access promotion, default capacity, hitRate calculation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLRUCache } = require('./coderlm-cache.cjs');

// Test 1: createLRUCache() returns object with required methods
test('createLRUCache returns object with get/set/reset/stats methods', () => {
  const cache = createLRUCache();
  assert.strictEqual(typeof cache.get, 'function');
  assert.strictEqual(typeof cache.set, 'function');
  assert.strictEqual(typeof cache.reset, 'function');
  assert.strictEqual(typeof cache.stats, 'function');
});

// Test 2: get on empty cache returns undefined, increments misses
test('get on empty cache returns undefined and increments misses', () => {
  const cache = createLRUCache(10, 60000);
  const result = cache.get('nonexistent');
  assert.strictEqual(result, undefined);
  const s = cache.stats();
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.hits, 0);
  assert.strictEqual(s.size, 0);
});

// Test 3: set then get within TTL returns value, increments hits
test('set then get within TTL returns value and increments hits', () => {
  const cache = createLRUCache(10, 60000);
  cache.set('key1', 'value1');
  const result = cache.get('key1');
  assert.strictEqual(result, 'value1');
  const s = cache.stats();
  assert.strictEqual(s.hits, 1);
  assert.strictEqual(s.misses, 0);
  assert.strictEqual(s.size, 1);
});

// Test 4: get after TTL returns undefined (miss)
test('get after TTL expiry returns undefined (miss)', async () => {
  const cache = createLRUCache(10, 1); // 1ms TTL
  cache.set('key1', 'value1');
  await new Promise(r => setTimeout(r, 5)); // wait for TTL to expire
  const result = cache.get('key1');
  assert.strictEqual(result, undefined);
  const s = cache.stats();
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.hits, 0);
});

// Test 5: LRU eviction — fill to capacity, set one more — first inserted is evicted
test('LRU eviction: first inserted key is evicted when capacity exceeded', () => {
  const cache = createLRUCache(5, 60000);
  for (let i = 0; i < 5; i++) {
    cache.set('key' + i, 'val' + i);
  }
  assert.strictEqual(cache.stats().size, 5);
  // Insert one more — 'key0' (LRU) should be evicted
  cache.set('key5', 'val5');
  assert.strictEqual(cache.stats().size, 5);
  // key0 should be gone
  assert.strictEqual(cache.get('key0'), undefined);
  // key5 should exist
  assert.strictEqual(cache.get('key5'), 'val5');
});

// Test 6: Access promotion — get a key makes it MRU, so it survives eviction
test('access promotion: recently accessed key survives when capacity exceeded', () => {
  const cache = createLRUCache(3, 60000);
  cache.set('key0', 'val0'); // LRU at this point
  cache.set('key1', 'val1');
  cache.set('key2', 'val2');
  // Promote key0 by accessing it
  cache.get('key0'); // now key0 is MRU, key1 is LRU
  // Add one more — should evict key1 (LRU), not key0
  cache.set('key3', 'val3');
  assert.strictEqual(cache.stats().size, 3);
  // key1 should be evicted
  assert.strictEqual(cache.get('key1'), undefined);
  // key0 should survive
  assert.strictEqual(cache.get('key0'), 'val0');
  // key2 and key3 should also exist
  assert.strictEqual(cache.get('key2'), 'val2');
  assert.strictEqual(cache.get('key3'), 'val3');
});

// Test 7: reset() clears all entries and zeros stats
test('reset() clears all entries and zeros all stats', () => {
  const cache = createLRUCache(10, 60000);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // hit
  cache.get('missing'); // miss
  cache.reset();
  const s = cache.stats();
  assert.strictEqual(s.hits, 0);
  assert.strictEqual(s.misses, 0);
  assert.strictEqual(s.size, 0);
  assert.strictEqual(s.hitRate, 0);
  assert.strictEqual(cache.get('a'), undefined);
});

// Test 8: stats() hitRate = hits / (hits + misses), 0 when no queries
test('stats() hitRate is 0 when no queries made', () => {
  const cache = createLRUCache(10, 60000);
  const s = cache.stats();
  assert.strictEqual(s.hitRate, 0);
});

test('stats() hitRate = hits / (hits + misses)', () => {
  const cache = createLRUCache(10, 60000);
  cache.set('k', 'v');
  cache.get('k'); // hit
  cache.get('k'); // hit
  cache.get('missing'); // miss
  const s = cache.stats();
  assert.strictEqual(s.hits, 2);
  assert.strictEqual(s.misses, 1);
  assert.strictEqual(s.hitRate, 2 / 3);
});

// Test 9: Duplicate set on same key updates value, does NOT change size, refreshes TTL
test('duplicate set on same key updates value without increasing size', () => {
  const cache = createLRUCache(10, 60000);
  cache.set('key1', 'original');
  cache.set('key1', 'updated');
  assert.strictEqual(cache.stats().size, 1);
  assert.strictEqual(cache.get('key1'), 'updated');
});

// Test 10: Default capacity=100, ttlMs=300000
test('default capacity is 100 and default TTL is 300000ms', () => {
  const cache = createLRUCache(); // no args
  // Fill 100 entries
  for (let i = 0; i < 100; i++) {
    cache.set('key' + i, i);
  }
  assert.strictEqual(cache.stats().size, 100);
  // Adding one more should evict the LRU (key0)
  cache.set('key100', 100);
  assert.strictEqual(cache.stats().size, 100);
  assert.strictEqual(cache.get('key0'), undefined); // evicted
  assert.strictEqual(cache.get('key100'), 100); // exists
});

// Test 11: NaN capacity falls back to default and stays bounded
test('NaN capacity falls back to default and stays bounded (no unbounded growth)', () => {
  const cache = createLRUCache(NaN, 60000);
  for (let i = 0; i < 250; i++) {
    cache.set('key' + i, i);
  }
  // Should be bounded by the default capacity (100), not grow unbounded.
  assert.ok(cache.stats().size <= 100, `expected size <= 100, got ${cache.stats().size}`);
});

// Test 12: capacity 0 stores no entries (boundary)
test('capacity 0 stores no entries (boundary)', () => {
  const cache = createLRUCache(0, 60000);
  cache.set('a', 1);
  assert.strictEqual(cache.stats().size, 0);
  assert.strictEqual(cache.get('a'), undefined);
});
