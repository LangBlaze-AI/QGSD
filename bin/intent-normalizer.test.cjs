/**
 * Test suite for intent-normalizer.cjs
 * Tests all three input channels and auxiliary features (confidence, ambiguity detection)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeFixIntent } = require('./intent-normalizer.cjs');

test('Intent Normalizer - Channel 1: Constraint Syntax', async (t) => {
  await t.test('parses "if timeout then retry" constraint', () => {
    const input = 'if timeout then retry';
    const { mutations, confidence, ambiguities } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'add_invariant');
    assert.equal(mutations[0].target, 'UserConstraint_0');
    assert(mutations[0].content.includes('timeout'));
    assert(mutations[0].content.includes('retry'));
  });

  await t.test('parses multiple constraints from compound sentence', () => {
    const input = 'if timeout then retry. if retry then reset.';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 2);
    assert.equal(mutations[0].type, 'add_invariant');
    assert.equal(mutations[1].type, 'add_invariant');
  });

  await t.test('parses "when X, Y must hold" syntax', () => {
    const input = 'when error occurs, recovery must complete';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'add_invariant');
  });
});

test('Intent Normalizer - Channel 2: Variable Syntax', async (t) => {
  await t.test('parses "add timeout variable" syntax', () => {
    const input = 'add timeout variable';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'add_state_variable');
    assert.equal(mutations[0].target, 'timeout');
    assert(mutations[0].content.includes('timeout'));
  });

  await t.test('deduplicates variable names', () => {
    const input = 'add timeout variable. Also track timeout.';
    const { mutations } = normalizeFixIntent(input);

    // Should have 1 variable mutation (deduplicated) + any constraint mutations
    const varMutations = mutations.filter(m => m.type === 'add_state_variable');
    assert.equal(varMutations.length, 1);
    assert.equal(varMutations[0].target, 'timeout');
  });

  await t.test('parses "track retryCount" syntax', () => {
    const input = 'track retryCount';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'add_state_variable');
    assert.equal(mutations[0].target, 'retryCount');
  });

  await t.test('parses "set field X" syntax', () => {
    const input = 'set field maxRetries';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'add_state_variable');
    assert.equal(mutations[0].target, 'maxRetries');
  });

  await t.test('parses "initialize variable" syntax', () => {
    const input = 'initialize retryAttempts';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].type, 'add_state_variable');
    assert.equal(mutations[0].target, 'retryAttempts');
  });
});

test('Intent Normalizer - Channel 3: Code Snippets', async (t) => {
  await t.test('parses code block into code_modification', () => {
    const input = 'To fix, add this code: ```if (timeout) { retry(); }```';
    const { mutations } = normalizeFixIntent(input);

    const codeMutations = mutations.filter(m => m.type === 'code_modification');
    assert.equal(codeMutations.length, 1);
    assert(codeMutations[0].content.includes('timeout'));
  });

  await t.test('handles multiple code blocks', () => {
    const input = 'Add this: ```block1();``` and also: ```block2();```';
    const { mutations } = normalizeFixIntent(input);

    const codeMutations = mutations.filter(m => m.type === 'code_modification');
    assert.equal(codeMutations.length, 2);
  });
});

test('Intent Normalizer - Mixed Input', async (t) => {
  await t.test('extracts all three channel types from compound input', () => {
    const input = `
      When timeout occurs, must retry.
      Add retryCount variable.
      Here's the code: \`\`\`if (timeout) { retryCount++; }\`\`\`
    `;
    const { mutations } = normalizeFixIntent(input);

    const constraintMutations = mutations.filter(m => m.type === 'add_invariant');
    const varMutations = mutations.filter(m => m.type === 'add_state_variable');
    const codeMutations = mutations.filter(m => m.type === 'code_modification');

    assert(constraintMutations.length >= 1, 'Should have at least 1 constraint mutation');
    assert(varMutations.length >= 1, 'Should have at least 1 variable mutation');
    assert(codeMutations.length >= 1, 'Should have at least 1 code mutation');
  });
});

test('Intent Normalizer - Ambiguity Detection', async (t) => {
  await t.test('detects hedging language', () => {
    const input = 'maybe add timeout variable';
    const { ambiguities } = normalizeFixIntent(input);

    assert(ambiguities.length > 0);
    assert(ambiguities[0].includes('hedging language'));
  });

  await t.test('detects "might" as hedging language', () => {
    const input = 'might need to track retryCount';
    const { ambiguities } = normalizeFixIntent(input);

    assert(ambiguities.length > 0);
    assert(ambiguities[0].includes('hedging language'));
  });

  await t.test('detects "could" as hedging language', () => {
    const input = 'could be fixed by adding timeout';
    const { ambiguities } = normalizeFixIntent(input);

    assert(ambiguities.length > 0);
    assert(ambiguities[0].includes('hedging language'));
  });

  await t.test('detects "or else" multiple options', () => {
    const input = 'add timeout or else add retry logic';
    const { ambiguities } = normalizeFixIntent(input);

    assert(ambiguities.length > 0);
    assert(ambiguities[0].includes('multiple options'));
  });

  await t.test('detects "or alternatively" multiple options', () => {
    const input = 'track retryCount or alternatively increment counter';
    const { ambiguities } = normalizeFixIntent(input);

    assert(ambiguities.length > 0);
    assert(ambiguities[0].includes('multiple options'));
  });
});

test('Intent Normalizer - Confidence Scoring', async (t) => {
  await t.test('returns confidence 0 for no mutations', () => {
    const input = 'just some random text with no intent';
    const { confidence, mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 0);
    assert.equal(confidence, 0);
  });

  await t.test('returns confidence 0.33 for 1 mutation', () => {
    const input = 'if timeout then retry';
    const { confidence, mutations } = normalizeFixIntent(input);

    assert(mutations.length >= 1);
    assert(confidence > 0 && confidence < 0.5);
  });

  await t.test('returns confidence 0.67 for 2 mutations', () => {
    const input = 'if timeout then retry. Add retryCount variable.';
    const { confidence, mutations } = normalizeFixIntent(input);

    assert(mutations.length >= 2);
    assert(confidence > 0.5 && confidence < 1.0);
  });

  await t.test('returns confidence 1.0 for 3+ mutations', () => {
    const input = `
      if timeout then retry.
      add retryCount variable.
      \`\`\`if (timeout) { retryCount++; }\`\`\`
    `;
    const { confidence, mutations } = normalizeFixIntent(input);

    assert(mutations.length >= 3);
    assert.equal(confidence, 1.0);
  });
});

test('Intent Normalizer - Edge Cases', async (t) => {
  await t.test('handles empty string input', () => {
    const { mutations, confidence, ambiguities } = normalizeFixIntent('');

    assert.equal(mutations.length, 0);
    assert.equal(confidence, 0);
    assert.equal(ambiguities.length, 0);
  });

  await t.test('handles null input gracefully', () => {
    const { mutations, confidence, ambiguities } = normalizeFixIntent(null);

    assert.equal(mutations.length, 0);
    assert.equal(confidence, 0);
    assert.equal(ambiguities.length, 0);
  });

  await t.test('handles undefined input gracefully', () => {
    const { mutations, confidence, ambiguities } = normalizeFixIntent(undefined);

    assert.equal(mutations.length, 0);
    assert.equal(confidence, 0);
    assert.equal(ambiguities.length, 0);
  });

  await t.test('handles non-string input gracefully', () => {
    const { mutations } = normalizeFixIntent(12345);

    assert.equal(mutations.length, 0);
  });
});

test('Intent Normalizer - Context Parameter', async (t) => {
  await t.test('includes bugDescription in mutation reasoning when provided', () => {
    const context = { bugDescription: 'timeout causes deadlock' };
    const input = 'add retryCount variable';
    const { mutations } = normalizeFixIntent(input, context);

    assert.equal(mutations.length, 1);
    assert(mutations[0].reasoning.includes('timeout causes deadlock'));
  });

  await t.test('works without context parameter', () => {
    const input = 'add retryCount variable';
    const { mutations } = normalizeFixIntent(input);

    assert.equal(mutations.length, 1);
    // Should have reasoning, just without bug description
    assert(mutations[0].reasoning.length > 0);
  });
});

test('Intent Normalizer - Context Parameter (hardening)', async (t) => {
  await t.test('handles null context without throwing when a mutation matches', () => {
    const input = 'add timeout variable';
    let result;
    assert.doesNotThrow(() => { result = normalizeFixIntent(input, null); });
    assert.equal(result.mutations.length, 1);
    assert.equal(result.mutations[0].type, 'add_state_variable');
    // falls back to the no-bugDescription reasoning branch
    assert(result.mutations[0].reasoning.includes('timeout'));
  });

  await t.test('handles null context across all three channels', () => {
    const input = 'if timeout then retry. add retryCount variable. ```retryCount++;```';
    let result;
    assert.doesNotThrow(() => { result = normalizeFixIntent(input, null); });
    assert(result.mutations.length >= 3);
  });

  await t.test('handles non-object (number/string/array) context without throwing', () => {
    for (const bad of [12345, 'oops', []]) {
      let result;
      assert.doesNotThrow(() => { result = normalizeFixIntent('add retryCount variable', bad); });
      assert.equal(result.mutations.length, 1);
    }
  });
});

test('Intent Normalizer - Mutation Structure', async (t) => {
  await t.test('each mutation has required fields: type, target, content, reasoning', () => {
    const input = 'if timeout then retry. add retryCount variable.';
    const { mutations } = normalizeFixIntent(input);

    for (const mutation of mutations) {
      assert(typeof mutation.type === 'string', 'type must be string');
      assert(typeof mutation.target === 'string', 'target must be string');
      assert(typeof mutation.content === 'string', 'content must be string');
      assert(typeof mutation.reasoning === 'string', 'reasoning must be string');
    }
  });
});
