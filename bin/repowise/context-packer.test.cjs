#!/usr/bin/env node
'use strict';
// bin/repowise/context-packer.test.cjs
// Tests for bin/repowise/context-packer.cjs — Repowise context packing entry point

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { packContext } = require('./context-packer.cjs');

// ---------------------------------------------------------------------------
// packContext — XML output
// ---------------------------------------------------------------------------

describe('packContext — XML output', () => {
  it('produces <repowise> root with placeholder sections and files', () => {
    const { xml } = packContext({
      files: [{ filePath: 'src/a.js', content: 'const x = 1;' }],
      projectRoot: '/tmp',
    });
    assert.ok(xml.includes('<repowise>'), 'should contain <repowise> root');
    assert.ok(xml.includes('<skeleton available="false"/>'), 'should contain skeleton placeholder');
    assert.ok(xml.includes('<hotspot available="false"/>'), 'should contain hotspot placeholder');
    assert.ok(xml.includes('<cochange available="false"/>'), 'should contain cochange placeholder');
    assert.ok(xml.includes('<file path="src/a.js" lang="js">const x = 1;</file>'), 'should contain packed file');
  });

  it('packs multiple files into the <files> section', () => {
    const { xml } = packContext({
      files: [
        { filePath: 'src/a.js', content: 'const x = 1;' },
        { filePath: 'src/b.ts', content: 'export {}' },
      ],
      projectRoot: '/tmp',
    });
    assert.ok(xml.includes('<file path="src/a.js" lang="js">'), 'should contain first file');
    assert.ok(xml.includes('<file path="src/b.ts" lang="ts">'), 'should contain second file');
  });

  it('escapes XML special characters in content', () => {
    const { xml } = packContext({
      files: [{ filePath: 'tag.js', content: 'if (a < b && c > d)' }],
      projectRoot: '/tmp',
    });
    assert.ok(xml.includes('&lt;'), 'should escape <');
    assert.ok(xml.includes('&amp;'), 'should escape &');
    assert.ok(xml.includes('&gt;'), 'should escape >');
  });

  it('replaces placeholder with signal content when provided', () => {
    const { xml } = packContext({
      files: [{ filePath: 'src/a.js', content: 'const x = 1;' }],
      projectRoot: '/tmp',
      signals: { skeleton: '<class name="Foo"/>' },
    });
    assert.ok(xml.includes('<skeleton available="true"><class name="Foo"/></skeleton>'), 'should contain signal content');
    assert.ok(xml.includes('<hotspot available="false"/>'), 'non-provided signals remain placeholders');
  });
});

// ---------------------------------------------------------------------------
// packContext — JSON output
// ---------------------------------------------------------------------------

describe('packContext — JSON output', () => {
  it('produces JSON with repowise structure', () => {
    const { json } = packContext({
      files: [{ filePath: 'src/a.js', content: 'const x = 1;' }],
      projectRoot: '/tmp',
    });
    assert.ok(json.repowise, 'should have repowise key');
    assert.ok(json.repowise.skeleton, 'should have skeleton key');
    assert.ok(json.repowise.hotspot, 'should have hotspot key');
    assert.ok(json.repowise.cochange, 'should have cochange key');
    assert.ok(Array.isArray(json.repowise.files), 'should have files array');
  });

  it('contains unescaped content in JSON', () => {
    const { json } = packContext({
      files: [{ filePath: 'tag.js', content: 'if (a < b && c > d)' }],
      projectRoot: '/tmp',
    });
    assert.equal(json.repowise.files[0].content, 'if (a < b && c > d)', 'JSON content should be unescaped');
  });
});

// ---------------------------------------------------------------------------
// packContext — edge cases
// ---------------------------------------------------------------------------

describe('packContext — edge cases', () => {
  it('handles empty files array with self-closing <files/>', () => {
    const { xml } = packContext({ files: [], projectRoot: '/tmp' });
    assert.ok(xml.includes('<files/>'), 'should have self-closing <files/>');
    assert.ok(xml.includes('<skeleton available="false"/>'), 'should still have placeholders');
  });

  it('handles file with unknown extension (no lang attribute)', () => {
    const { xml } = packContext({
      files: [{ filePath: 'Makefile', content: 'all:' }],
      projectRoot: '/tmp',
    });
    assert.ok(xml.includes('<file path="Makefile">all:</file>'), 'should omit lang for unknown extension');
  });

  it('handles all three signals provided simultaneously', () => {
    const { xml } = packContext({
      files: [],
      projectRoot: '/tmp',
      signals: {
        skeleton: '<class name="A"/>',
        hotspot: '<hot>data</hot>',
        cochange: '<group files="a,b"/>',
      },
    });
    assert.ok(xml.includes('<skeleton available="true">'), 'skeleton should be available');
    assert.ok(xml.includes('<hotspot available="true">'), 'hotspot should be available');
    assert.ok(xml.includes('<cochange available="true">'), 'cochange should be available');
  });

  it('hotspot signal with _hotspotData enriches JSON output', () => {
    const { json } = packContext({
      files: [],
      projectRoot: '/tmp',
      signals: {
        hotspot: '<files><file path="a.js"/></files>',
        _hotspotData: { files: [{ path: 'a.js', churn: 5 }], summary: { total_files: 1 } },
      },
    });
    assert.ok(json.repowise.hotspot.available, 'hotspot should be available');
    assert.ok(json.repowise.hotspot.summary, 'should include summary from _hotspotData');
  });
});

// ---------------------------------------------------------------------------
// packContext — adversarial file inputs
// ---------------------------------------------------------------------------

describe('packContext — adversarial file inputs', () => {
  it('treats a missing files key as empty without throwing', () => {
    let result;
    assert.doesNotThrow(() => { result = packContext({ projectRoot: '/tmp' }); });
    assert.ok(result.xml.includes('<files/>'), 'should emit self-closing <files/>');
    assert.deepEqual(result.json.repowise.files, [], 'json files should be empty array');
  });

  it('skips null entries in the files array without throwing', () => {
    let result;
    assert.doesNotThrow(() => {
      result = packContext({ files: [null, { filePath: 'a.js', content: 'x' }], projectRoot: '/tmp' });
    });
    assert.ok(result.xml.includes('<file path="a.js"'), 'valid file should still be packed');
    assert.equal(result.json.repowise.files.length, 1, 'null entry should be dropped from json');
  });

  it('handles a file entry missing filePath without ERR_INVALID_ARG_TYPE', () => {
    let result;
    assert.doesNotThrow(() => {
      result = packContext({ files: [{ content: 'x = 1' }], projectRoot: '/tmp' });
    });
    assert.ok(result.xml.includes('x = 1'), 'content should still be packed');
    assert.equal(typeof result.json.repowise.files[0].path, 'string', 'path should be a string, not undefined');
  });
});
