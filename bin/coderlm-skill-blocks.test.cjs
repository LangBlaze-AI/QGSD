'use strict';

// Dogfood Batch 6: /nf:coderlm's 4 query blocks did
//   const adapter = require(adapterPath).createAdapter();
// where `require(adapterPath)` throws MODULE_NOT_FOUND *synchronously* — before the
// promise `.catch` — when the adapter is installed in neither ~/.claude/nf-bin nor
// ./bin, crashing the whole NF_EVAL block with a raw stack trace. Each require is now
// wrapped so a missing adapter degrades to a clean {error} JSON.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MD = fs.readFileSync(path.join(__dirname, '../commands/nf/coderlm.md'), 'utf8');

function heredocBodies(md) {
  const re = /node << 'NF_EVAL'\r?\n([\s\S]*?)\r?\nNF_EVAL/g;
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}

const BLOCKS = heredocBodies(MD).filter((b) => b.includes('adapterPath') && b.includes('createAdapter'));

describe('coderlm skill blocks degrade gracefully when the adapter is missing', () => {
  it('extracted all four adapter query blocks', () => {
    assert.equal(BLOCKS.length, 4, 'coderlm.md should expose 4 adapter query blocks');
  });

  it('each block guards require() and emits {error} JSON (no raw MODULE_NOT_FOUND crash)', () => {
    assert.ok(BLOCKS.length > 0, 'need at least one block');
    for (const body of BLOCKS) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-coderlm-'));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-coderlm-cwd-')); // no ./bin/coderlm-adapter.cjs
      const file = path.join(home, 'block.cjs');
      fs.writeFileSync(file, body);
      try {
        const out = execFileSync(process.execPath, [file], {
          cwd, env: { ...process.env, HOME: home, NF_CODERLM_SYMBOL: 'x', NF_CODERLM_FILE: 'y', NF_CODERLM_START: '1', NF_CODERLM_END: '2' },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const parsed = JSON.parse(out.trim());
        assert.ok('error' in parsed, 'a missing adapter must surface as {error}, not crash');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});
