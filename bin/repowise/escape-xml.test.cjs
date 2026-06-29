#!/usr/bin/env node
'use strict';
// bin/repowise/escape-xml.test.cjs
// Tests for bin/repowise/escape-xml.cjs — XML character escaping for Repowise

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { escapeXml } = require('./escape-xml.cjs');

// ---------------------------------------------------------------------------
// Basic replacements
// ---------------------------------------------------------------------------

describe('escapeXml — basic replacements', () => {
  it('replaces ampersand', () => {
    assert.equal(escapeXml('a & b'), 'a &amp; b');
  });

  it('replaces less-than', () => {
    assert.equal(escapeXml('a < b'), 'a &lt; b');
  });

  it('replaces greater-than', () => {
    assert.equal(escapeXml('a > b'), 'a &gt; b');
  });

  it('replaces double-quote', () => {
    assert.equal(escapeXml('say "hello"'), 'say &quot;hello&quot;');
  });

  it('replaces single-quote', () => {
    assert.equal(escapeXml("it's fine"), 'it&apos;s fine');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('escapeXml — edge cases', () => {
  it('handles all special chars in one string', () => {
    assert.equal(
      escapeXml('<div class="x">&\'y\'</div>'),
      '&lt;div class=&quot;x&quot;&gt;&amp;&apos;y&apos;&lt;/div&gt;'
    );
  });

  it('does not double-encode (proves & is replaced first)', () => {
    // Input '&lt;' has & which must become &amp; first, yielding &amp;lt;
    assert.equal(escapeXml('&lt;'), '&amp;lt;');
  });

  it('returns empty string for empty string input', () => {
    assert.equal(escapeXml(''), '');
  });

  it('returns empty string for non-string inputs', () => {
    assert.equal(escapeXml(42), '');
    assert.equal(escapeXml(null), '');
    assert.equal(escapeXml(undefined), '');
  });

  it('returns input unchanged when no special characters present', () => {
    assert.equal(escapeXml('hello world'), 'hello world');
  });
});

// ---------------------------------------------------------------------------
// Illegal XML 1.0 control characters
// ---------------------------------------------------------------------------

describe('escapeXml — illegal XML control characters', () => {
  it('strips C0 control chars that are illegal in XML 1.0', () => {
    // NUL, backspace, vertical tab are forbidden in XML 1.0 char data
    assert.equal(escapeXml('a\x00b\x08c\x0Bd'), 'abcd');
  });

  it('preserves the XML-legal whitespace controls (tab, newline, CR)', () => {
    assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd');
  });

  it('produced output never contains a raw NUL byte', () => {
    assert.ok(!escapeXml('x\x00y').includes('\x00'));
  });
});
