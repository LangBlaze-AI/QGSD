#!/usr/bin/env node
'use strict';
// bin/repowise/pack-file.test.cjs
// Tests for bin/repowise/pack-file.cjs — XML <file> tag packing for Repowise

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { packFile, detectLang, LANG_MAP } = require('./pack-file.cjs');

// ---------------------------------------------------------------------------
// detectLang
// ---------------------------------------------------------------------------

describe('detectLang', () => {
  it('maps .js to "js"', () => {
    assert.equal(detectLang('src/foo.js'), 'js');
  });

  it('maps .ts to "ts"', () => {
    assert.equal(detectLang('src/bar.ts'), 'ts');
  });

  it('maps .py to "py"', () => {
    assert.equal(detectLang('script.py'), 'py');
  });

  it('maps .tla to "tla"', () => {
    assert.equal(detectLang('spec.tla'), 'tla');
  });

  it('returns null for unknown extension', () => {
    assert.equal(detectLang('file.xyz'), null);
  });

  it('returns null for no extension', () => {
    assert.equal(detectLang('Makefile'), null);
  });
});

// ---------------------------------------------------------------------------
// packFile — basic
// ---------------------------------------------------------------------------

describe('packFile — basic', () => {
  it('packs file with auto-detected language', () => {
    assert.equal(
      packFile({ filePath: 'src/foo.js', content: 'const x = 1;' }),
      '<file path="src/foo.js" lang="js">const x = 1;</file>'
    );
  });

  it('uses explicit lang override when provided', () => {
    const result = packFile({ filePath: 'src/foo.js', content: '// js', lang: 'typescript' });
    assert.ok(result.includes('lang="typescript"'));
  });

  it('omits lang attribute for unknown extension', () => {
    assert.equal(
      packFile({ filePath: 'Makefile', content: 'all:' }),
      '<file path="Makefile">all:</file>'
    );
  });

  it('handles empty content', () => {
    assert.equal(
      packFile({ filePath: 'empty.py', content: '' }),
      '<file path="empty.py" lang="py"></file>'
    );
  });

  it('preserves path with directory separators', () => {
    const result = packFile({ filePath: 'deep/nested/dir/file.ts', content: 'export {}' });
    assert.ok(result.startsWith('<file path="deep/nested/dir/file.ts"'));
  });

  it('detects .cjs as js', () => {
    assert.equal(
      packFile({ filePath: 'mod.cjs', content: 'module.exports = {};' }),
      '<file path="mod.cjs" lang="js">module.exports = {};</file>'
    );
  });

  it('detects .mjs as js', () => {
    const result = packFile({ filePath: 'mod.mjs', content: 'export default {};' });
    assert.ok(result.includes('lang="js"'));
  });
});

// ---------------------------------------------------------------------------
// packFile — content escaping
// ---------------------------------------------------------------------------

describe('packFile — content escaping', () => {
  it('escapes XML special characters in content', () => {
    const result = packFile({ filePath: 'tag.js', content: 'if (a < b && c > d) { return "ok"; }' });
    assert.ok(result.includes('&lt;'), 'should contain &lt;');
    assert.ok(result.includes('&amp;'), 'should contain &amp;');
    assert.ok(result.includes('&gt;'), 'should contain &gt;');
    assert.ok(result.includes('&quot;'), 'should contain &quot;');
  });

  it('escapes single quotes in content', () => {
    const result = packFile({ filePath: 'a.js', content: "it's fine" });
    assert.ok(result.includes('&apos;'), 'should contain &apos;');
  });

  it('does not escape the path attribute', () => {
    const result = packFile({ filePath: 'src/foo.js', content: 'hello' });
    // Path should be preserved as-is, not XML-escaped
    assert.ok(result.includes('path="src/foo.js"'));
  });

  it('preserves content without special characters unchanged', () => {
    const result = packFile({ filePath: 'plain.py', content: 'def hello(): pass' });
    assert.equal(result, '<file path="plain.py" lang="py">def hello(): pass</file>');
  });
});

// ---------------------------------------------------------------------------
// packFile — path attribute safety (pf-1)
// ---------------------------------------------------------------------------

describe('packFile — path attribute safety', () => {
  it('escapes a double-quote in filePath so the XML attribute cannot be broken out of', () => {
    const result = packFile({ filePath: 'a".js', content: 'x' });
    assert.ok(result.includes('&quot;'), 'double-quote in path should be escaped');
    assert.ok(!result.includes('path="a".js"'), 'raw quote must not terminate the attribute');
  });

  it('escapes angle brackets in filePath so markup cannot be injected', () => {
    const result = packFile({ filePath: '<x>.js', content: 'y' });
    assert.ok(result.includes('&lt;x&gt;.js'), 'angle brackets in path should be escaped');
  });

  it('leaves a normal path unchanged', () => {
    const result = packFile({ filePath: 'src/foo.js', content: 'hello' });
    assert.ok(result.includes('path="src/foo.js"'));
  });
});

// ---------------------------------------------------------------------------
// detectLang — non-string input (pf-2)
// ---------------------------------------------------------------------------

describe('detectLang — non-string input', () => {
  it('returns null for null instead of throwing', () => {
    assert.equal(detectLang(null), null);
  });

  it('returns null for undefined instead of throwing', () => {
    assert.equal(detectLang(undefined), null);
  });

  it('returns null for a number instead of throwing', () => {
    assert.equal(detectLang(42), null);
  });
});

// ---------------------------------------------------------------------------
// packFile — missing options (pf-3)
// ---------------------------------------------------------------------------

describe('packFile — missing options', () => {
  it('does not throw when called with no arguments', () => {
    let result;
    assert.doesNotThrow(() => { result = packFile(); });
    assert.equal(typeof result, 'string');
    assert.ok(result.startsWith('<file'));
  });
});
