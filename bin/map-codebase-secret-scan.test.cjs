'use strict';

// Dogfood Batch 9 (SECURITY): /nf:map-codebase's pre-commit secret scan used
// `sk-[a-zA-Z0-9]{20,}`, whose char class excludes `-`, so a modern OpenAI
// `sk-proj-…` or Anthropic `sk-ant-api03-…` key (both contain hyphens right after
// the `sk-` prefix) was NOT matched → a leaked live key could slip into a committed
// codebase document. The class is widened to `[a-zA-Z0-9_-]`.
//
// NOTE: the synthetic keys here are built at runtime so no literal key-shaped string
// lands in this file (which would itself trip the repo's detect-secrets gate).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MD = fs.readFileSync(path.join(__dirname, '..', 'core', 'workflows', 'map-codebase.md'), 'utf8');

// Pull the grep -E '(...)' alternation out of the scan_for_secrets step.
function extractScanRegex(md) {
  const m = md.match(/grep -E '\(([^']*?)\)' \.planning\/codebase/);
  assert.ok(m, 'could not find the secret-scan grep -E pattern in map-codebase.md');
  return new RegExp('(' + m[1] + ')');
}

describe('map-codebase secret scan catches modern sk- key formats', () => {
  const re = extractScanRegex(MD);
  const long = (c, n) => c.repeat(n);

  it('matches an OpenAI project key (sk-proj-…)', () => {
    const key = 'sk-proj-' + long('A', 24) + '_' + long('B', 24);
    assert.match(key, re, 'sk-proj- key with hyphen/underscore must be caught');
  });

  it('matches an Anthropic key (sk-ant-api03-…)', () => {
    const key = 'sk-ant-api03-' + long('C', 40);
    assert.match(key, re, 'sk-ant-api03- key must be caught');
  });

  it('still matches a classic sk- key (no regression)', () => {
    const key = 'sk-' + long('D', 30);
    assert.match(key, re);
  });

  it('does not match ordinary prose', () => {
    assert.doesNotMatch('the sk- prefix is short', re);
  });
});
