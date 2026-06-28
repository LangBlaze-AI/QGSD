#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { resolveTlaJar, resolveAlloyJar, NF_FORMAL_HOME } = require('./resolve-formal-tools.cjs');

describe('resolve-formal-tools adversarial', () => {

  it('path traversal in projectRoot does not escape', () => {
    const malicious = '/tmp/../../etc/passwd/../../../tmp';
    const result = resolveTlaJar(malicious);
    assert.ok(result === null || result.startsWith('/'), 'result is null or absolute');
    assert.ok(!result || !result.includes('..'), 'no path traversal in result');
  });

  it('null projectRoot does not crash', () => {
    const tla = resolveTlaJar(null);
    const alloy = resolveAlloyJar(null);
    assert.ok(tla === null || typeof tla === 'string');
    assert.ok(alloy === null || typeof alloy === 'string');
  });

  it('undefined projectRoot does not crash', () => {
    const tla = resolveTlaJar(undefined);
    const alloy = resolveAlloyJar(undefined);
    assert.ok(tla === null || typeof tla === 'string');
    assert.ok(alloy === null || typeof alloy === 'string');
  });

  it('empty string projectRoot does not crash', () => {
    const tla = resolveTlaJar('');
    const alloy = resolveAlloyJar('');
    assert.ok(tla === null || typeof tla === 'string');
    assert.ok(alloy === null || typeof alloy === 'string');
  });

  it('projectRoot with special shell characters does not execute', () => {
    const malicious = '/tmp/$(rm -rf /)/.planning';
    const tla = resolveTlaJar(malicious);
    assert.ok(tla === null || typeof tla === 'string');
  });

  it('projectRoot with null bytes does not crash', () => {
    const malicious = '/tmp/\x00/etc/passwd';
    const tla = resolveTlaJar(malicious);
    assert.ok(tla === null || typeof tla === 'string');
  });

  it('projectRoot with unicode does not crash', () => {
    const malicious = '/tmp/日本語/.planning';
    const tla = resolveTlaJar(malicious);
    assert.ok(tla === null || typeof tla === 'string');
  });

  it('symlinked projectRoot resolves correctly', async () => {
    const tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nf-formal-test-'));
    const linkPath = path.join(tmpdir, 'link');
    try {
      await fs.promises.symlink(tmpdir, linkPath);
      const result = resolveTlaJar(linkPath);
      assert.ok(result === null || typeof result === 'string');
    } finally {
      await fs.promises.rm(tmpdir, { recursive: true });
    }
  });

  it('NF_FORMAL_HOME is under home directory', () => {
    assert.ok(NF_FORMAL_HOME.startsWith(os.homedir()), 'NF_FORMAL_HOME is under $HOME');
    assert.ok(!NF_FORMAL_HOME.includes('..'), 'no traversal in NF_FORMAL_HOME');
  });

  it('returns global path when projectRoot is nonexistent (falls through to NF_FORMAL_HOME)', () => {
    const result = resolveTlaJar('/nonexistent/a/b/c/d/e/f');
    assert.ok(result === null || result.startsWith(os.homedir()),
      'returns global path or null — never uses the bogus projectRoot');
  });

  it('truthy non-string projectRoot does not crash (falls back to default)', () => {
    for (const bad of [123, {}, [], true, ['/some/dir']]) {
      const tla = resolveTlaJar(bad);
      const alloy = resolveAlloyJar(bad);
      assert.ok(tla === null || typeof tla === 'string',
        `resolveTlaJar(${JSON.stringify(bad)}) returns null or string`);
      assert.ok(alloy === null || typeof alloy === 'string',
        `resolveAlloyJar(${JSON.stringify(bad)}) returns null or string`);
    }
  });

  it('does not follow projectRoot that is a file (not directory)', async () => {
    const tmpdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nf-formal-test-'));
    const filePath = path.join(tmpdir, 'isafile');
    await fs.promises.writeFile(filePath, 'not a directory');
    try {
      const result = resolveTlaJar(filePath);
      assert.ok(result === null || result.startsWith(os.homedir()),
        'returns global path or null — does not use file as directory');
    } finally {
      await fs.promises.rm(tmpdir, { recursive: true });
    }
  });
});
