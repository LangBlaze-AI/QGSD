'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFrontmatter, validateDebate } = require('./debate-formatter.cjs');

// Test 1: extractFrontmatter returns parsed frontmatter
test('extractFrontmatter returns parsed frontmatter with all fields', () => {
  const content = `---
date: 2026-03-08
question: "Should we use TypeScript?"
consensus: PENDING
rounds: 3
participants: [claude, gemini, codex]
tags: [architecture, dx]
---

# Test`;

  const fm = extractFrontmatter(content);
  assert.ok(fm, 'should return an object');
  assert.equal(fm.date, '2026-03-08');
  assert.equal(fm.question, 'Should we use TypeScript?');
  assert.equal(fm.consensus, 'PENDING');
  assert.equal(fm.rounds, 3);
  assert.deepEqual(fm.participants, ['claude', 'gemini', 'codex']);
  assert.deepEqual(fm.tags, ['architecture', 'dx']);
});

// Test 2: extractFrontmatter returns null for no frontmatter
test('extractFrontmatter returns null for no frontmatter', () => {
  const content = '# Just a heading\n\nSome text.';
  const fm = extractFrontmatter(content);
  assert.equal(fm, null);
});

// Test 3: extractFrontmatter handles partial frontmatter
test('extractFrontmatter handles partial frontmatter (only date and question)', () => {
  const content = `---
date: 2026-03-08
question: "Minimal debate"
---

# Test`;

  const fm = extractFrontmatter(content);
  assert.ok(fm);
  assert.equal(fm.date, '2026-03-08');
  assert.equal(fm.question, 'Minimal debate');
  assert.equal(fm.consensus, undefined);
});

// Test 4: extractFrontmatter handles quoted values
test('extractFrontmatter handles quoted values', () => {
  const content = `---
date: 2026-03-08
question: "foo bar"
---`;

  const fm = extractFrontmatter(content);
  assert.equal(fm.question, 'foo bar');
});

// Test 5: validateDebate returns valid for complete debate
test('validateDebate returns valid for complete debate', () => {
  const content = `---
date: 2026-03-08
question: "Should we refactor?"
consensus: APPROVED
rounds: 2
participants: [claude, gemini]
tags: [refactoring]
---

# Quorum Debate: Refactoring

## Context
Background.

## Question
Should we refactor?

## Positions
...

## Decision
APPROVED.

## Consequences
- Impact 1`;

  const result = validateDebate(content);
  assert.equal(result.valid, true);
  assert.ok(result.frontmatter);
  assert.equal(result.frontmatter.date, '2026-03-08');
});

// Test 6: validateDebate returns invalid for missing date
test('validateDebate returns invalid for missing date', () => {
  const content = `---
question: "No date here"
---`;

  const result = validateDebate(content);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('date')));
});

// Test 7: validateDebate returns invalid for missing question
test('validateDebate returns invalid for missing question', () => {
  const content = `---
date: 2026-03-08
---`;

  const result = validateDebate(content);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('question')));
});

// Test 8: validateDebate returns invalid for no frontmatter
test('validateDebate returns invalid for no frontmatter', () => {
  const content = '# Just markdown\n\nNo frontmatter here.';
  const result = validateDebate(content);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('frontmatter')));
});

// Test 9: extractFrontmatter does not corrupt prototype via __proto__ key
test('extractFrontmatter ignores dangerous keys and keeps a clean prototype', () => {
  const content = `---\ndate: 2026-01-01\nquestion: hi\n__proto__: [polluted]\n---`;
  const fm = extractFrontmatter(content);
  assert.ok(fm);
  // returned object's prototype must remain Object.prototype (not the injected array)
  assert.equal(Object.getPrototypeOf(fm), Object.prototype);
  // global prototype must not be polluted
  assert.equal({}.polluted, undefined);
  // legitimate fields still parse
  assert.equal(fm.date, '2026-01-01');
  assert.equal(fm.question, 'hi');
});
