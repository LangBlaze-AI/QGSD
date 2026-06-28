'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { FORBIDDEN_SDKS, buildImportPatterns, isInScope, scanFile } = require('./check-bundled-sdks.cjs');

// ---------------------------------------------------------------------------
// Temp fixture helpers
// ---------------------------------------------------------------------------

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-lint-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name, content) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ---------------------------------------------------------------------------
// SDK detection tests
// ---------------------------------------------------------------------------

describe('SDK detection', () => {
  it('detects require(@anthropic-ai/sdk)', () => {
    const file = writeFixture('a.cjs', "const Anthropic = require('@anthropic-ai/sdk');");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, '@anthropic-ai/sdk');
  });

  it('detects require.resolve(@anthropic-ai/sdk)', () => {
    const file = writeFixture('b.cjs', "require.resolve('@anthropic-ai/sdk');");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, '@anthropic-ai/sdk');
  });

  it('detects import from openai', () => {
    const file = writeFixture('c.mjs', "import OpenAI from 'openai';");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, 'openai');
  });

  it('detects require(openai)', () => {
    const file = writeFixture('d.cjs', "const OpenAI = require('openai');");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, 'openai');
  });

  it('detects require(@google/generative-ai)', () => {
    const file = writeFixture('e.cjs', "const g = require('@google/generative-ai');");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, '@google/generative-ai');
  });

  it('detects multiple SDKs in one file', () => {
    const file = writeFixture('f.cjs', [
      "const A = require('@anthropic-ai/sdk');",
      "const O = require('openai');",
    ].join('\n'));
    const violations = scanFile(file);
    assert.equal(violations.length, 2);
    const sdks = violations.map(v => v.sdk).sort();
    assert.deepEqual(sdks, ['@anthropic-ai/sdk', 'openai']);
  });
});

// ---------------------------------------------------------------------------
// False-positive filtering tests
// ---------------------------------------------------------------------------

describe('false-positive filtering', () => {
  it('ignores SDK name in single-line comment', () => {
    const file = writeFixture('g.cjs', "// Use Agent tool instead of @anthropic-ai/sdk");
    const violations = scanFile(file);
    assert.equal(violations.length, 0);
  });

  it('ignores SDK name in plain string (not require)', () => {
    const file = writeFixture('h.cjs', "const msg = 'The @anthropic-ai/sdk is deprecated';");
    const violations = scanFile(file);
    assert.equal(violations.length, 0);
  });

  it('clean file returns 0 violations', () => {
    const file = writeFixture('i.cjs', [
      "'use strict';",
      "const fs = require('fs');",
      "const path = require('path');",
      "console.log('hello');",
    ].join('\n'));
    const violations = scanFile(file);
    assert.equal(violations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Scope filtering tests
// ---------------------------------------------------------------------------

describe('scope filtering', () => {
  it('includes bin/*.cjs files', () => {
    assert.equal(isInScope('bin/something.cjs'), true);
  });

  it('includes hooks/*.js files', () => {
    assert.equal(isInScope('hooks/something.js'), true);
  });

  it('excludes test files', () => {
    assert.equal(isInScope('bin/something.test.cjs'), false);
  });

  it('excludes node_modules', () => {
    assert.equal(isInScope('node_modules/@anthropic-ai/sdk/index.js'), false);
  });

  it('excludes docs/', () => {
    assert.equal(isInScope('docs/example.js'), false);
  });

  it('excludes .planning/formal/', () => {
    assert.equal(isInScope('.planning/formal/some-tool.cjs'), false);
  });
});

// ---------------------------------------------------------------------------
// Error handling test
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('scanFile handles missing file gracefully', () => {
    const violations = scanFile('/nonexistent/path.cjs');
    assert.deepEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe('integration', () => {
  it('linter exits 0 on clean codebase', () => {
    const stdout = execFileSync('node', ['bin/check-bundled-sdks.cjs'], {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '..'),
    });
    assert.ok(stdout.includes('Found 0 violations'));
  });
});

// ---------------------------------------------------------------------------
// ESM dynamic and side-effect import detection (DP-1)
// ---------------------------------------------------------------------------

describe('ESM dynamic and side-effect import detection', () => {
  it('detects dynamic import() of openai', () => {
    const file = writeFixture('dyn.mjs', "const O = await import('openai');");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, 'openai');
  });

  it('detects side-effect import of openai', () => {
    const file = writeFixture('side.mjs', "import 'openai';");
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, 'openai');
  });
});

// ---------------------------------------------------------------------------
// Template-literal require detection (DP-2)
// ---------------------------------------------------------------------------

describe('template-literal require detection', () => {
  it('detects require with backtick quotes', () => {
    const file = writeFixture('tmpl.cjs', 'const O = require(`openai`);');
    const violations = scanFile(file);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].sdk, 'openai');
  });
});

// ---------------------------------------------------------------------------
// isInScope type safety (DP-3)
// ---------------------------------------------------------------------------

describe('isInScope type safety', () => {
  it('returns false for non-string input instead of throwing', () => {
    assert.equal(isInScope(null), false);
    assert.equal(isInScope(undefined), false);
    assert.equal(isInScope(42), false);
  });
});
