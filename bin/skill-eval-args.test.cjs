#!/usr/bin/env node
'use strict';
// bin/skill-eval-args.test.cjs
// Guards against passing CLI args/flags *after* a `node` eval in skill files.
// nForma's eval-guard rewrites `node -e "..."` to a `node << 'NF_EVAL' … NF_EVAL`
// heredoc; any token trailing the eval (e.g. `$FLAGS`, `--force`) then lands
// AFTER the heredoc delimiter, where node treats it as a CLI arg/script-path and
// errors (`node: bad option: --force`). Args must be passed via env vars instead.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CMD = path.join(__dirname, '..', 'commands', 'nf');

describe('solve-classify --force passing (F21)', () => {
  const t = fs.readFileSync(path.join(CMD, 'solve-classify.md'), 'utf8');
  it('passes --force via env (NF_CLASSIFY_FORCE), not a trailing CLI $FLAGS', () => {
    assert.ok(/NF_CLASSIFY_FORCE/.test(t), 'should set/read NF_CLASSIFY_FORCE');
    // The bug was a closing eval line `" $FLAGS` / `NF_EVAL $FLAGS` (a trailing
    // CLI arg). The `[[ "$FLAGS" == … ]]` comparison (no space after the quote)
    // is fine, so require whitespace between the delimiter/quote and $FLAGS.
    assert.ok(!/(?:"|NF_EVAL)\s+\$FLAGS\b/.test(t), 'must not trail a node eval with $FLAGS as a CLI arg');
    assert.ok(!/process\.argv\.includes\('--force'\)/.test(t), 'should read --force from env, not argv');
  });
});
