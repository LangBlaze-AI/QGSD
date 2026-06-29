'use strict';
// bin/learning-extractor.test.cjs
// Tests for transcript extraction logic (LRNG-01/02).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractErrorPatterns,
  extractCorrections,
  readLastLines,
  extractTextFromEntry,
} = require('./learning-extractor.cjs');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeUserToolResult(toolUseId, content, isError = false) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: isError,
        content: content,
      }],
    },
  });
}

function makeAssistantText(text) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function makeUserText(text) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('extractErrorPatterns', () => {

  it('extracts pattern from is_error:true followed by successful tool_result', () => {
    const lines = [
      makeUserToolResult('tu_1', 'Error: ENOENT: no such file or directory, open config.json', true),
      makeUserToolResult('tu_2', 'File created successfully'),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].type, 'error_resolution');
    assert.ok(patterns[0].symptom.includes('ENOENT'));
    assert.ok(patterns[0].fix.includes('File created successfully'));
    assert.ok(patterns[0].ts);
  });

  it('extracts pattern from error content text followed by assistant "fixed"', () => {
    const lines = [
      makeUserToolResult('tu_1', 'TypeError: Cannot read properties of undefined', false),
      makeAssistantText('I fixed the issue by adding a null check before accessing the property'),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 1);
    assert.ok(patterns[0].symptom.includes('TypeError'));
    assert.ok(patterns[0].fix.includes('fixed'));
  });

  it('returns empty array when no errors present', () => {
    const lines = [
      makeUserToolResult('tu_1', 'Command executed successfully'),
      makeAssistantText('The operation completed without issues.'),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 0);
  });

  it('respects maxPatterns cap', () => {
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push(makeUserToolResult(`tu_err_${i}`, `Error: failure number ${i}`, true));
      lines.push(makeUserToolResult(`tu_fix_${i}`, `Fixed issue ${i}`));
    }
    const patterns = extractErrorPatterns(lines, 10);
    assert.equal(patterns.length, 10);
  });

  it('skips malformed lines gracefully', () => {
    const lines = [
      'not valid json at all',
      '{malformed',
      makeUserToolResult('tu_1', 'Error: something broke', true),
      'another bad line',
      makeUserToolResult('tu_2', 'Fixed it'),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 1);
  });

  it('detects stack trace pattern as error', () => {
    const lines = [
      makeUserToolResult('tu_1', 'at Module._compile (node:internal/modules/cjs/loader:1234:14)', false),
      makeAssistantText('The issue was a missing module import. I resolved it.'),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 1);
  });

  it('does not extract when no resolution found within 20 lines', () => {
    const lines = [makeUserToolResult('tu_1', 'Error: something broke', true)];
    // Add 25 unrelated lines
    for (let i = 0; i < 25; i++) {
      lines.push(makeAssistantText('Unrelated discussion about architecture'));
    }
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 0);
  });

  it('skips null blocks inside a content array without crashing', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            null,
            { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'Error: boom' },
          ],
        },
      }),
      makeUserToolResult('tu_2', 'Fixed it'),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 1);
    assert.ok(patterns[0].symptom.includes('boom'));
  });

  it('does not crash when a forward resolution entry has a null content block', () => {
    const lines = [
      makeUserToolResult('tu_1', 'Error: boom', true),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            null,
            { type: 'tool_result', tool_use_id: 'tu_2', is_error: false, content: 'Fixed it' },
          ],
        },
      }),
    ];
    const patterns = extractErrorPatterns(lines);
    assert.equal(patterns.length, 1);
    assert.ok(patterns[0].fix.includes('Fixed it'));
  });
});

describe('extractCorrections', () => {

  it('extracts correction when user message matches 3 indicators', () => {
    const lines = [
      makeAssistantText('I will use var for all variable declarations in this module.'),
      makeUserText("Don't use var, you should use const instead for all declarations in this codebase."),
    ];
    const corrections = extractCorrections(lines);
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].type, 'correction');
    assert.ok(corrections[0].wrong_approach.includes('var'));
    assert.ok(corrections[0].correct_approach.includes('const instead'));
  });

  it('does NOT extract when only 1 indicator matches', () => {
    const lines = [
      makeAssistantText('I implemented the feature using the standard approach.'),
      makeUserText('Actually that looks good to me, great work on it.'),
    ];
    const corrections = extractCorrections(lines);
    assert.equal(corrections.length, 0);
  });

  it('does NOT extract short user messages (< 20 chars)', () => {
    const lines = [
      makeAssistantText('I used spawnSync for the hook implementation.'),
      makeUserText("Don't, not that"),
    ];
    const corrections = extractCorrections(lines);
    assert.equal(corrections.length, 0);
  });

  it('respects maxCorrections cap', () => {
    const lines = [];
    for (let i = 0; i < 8; i++) {
      lines.push(makeAssistantText(`I will do approach ${i} with the old pattern.`));
      lines.push(makeUserText(`Don't do that wrong approach, you should use the new pattern instead of the old one.`));
    }
    const corrections = extractCorrections(lines, 5);
    assert.equal(corrections.length, 5);
  });

  it('does NOT extract when user message is not preceded by assistant', () => {
    const lines = [
      makeUserText("Don't use that wrong approach, you should use something else instead."),
      makeUserText("Actually I prefer the other pattern over this one, not this."),
    ];
    const corrections = extractCorrections(lines);
    assert.equal(corrections.length, 0);
  });

  it('extracts correction with "prefer X over Y" pattern', () => {
    const lines = [
      makeAssistantText('I will implement this using ESM imports throughout the project.'),
      makeUserText("I prefer CommonJS over ESM for hooks, you should not use ESM imports in any hook files."),
    ];
    const corrections = extractCorrections(lines);
    assert.equal(corrections.length, 1);
  });
});

describe('readLastLines', () => {

  it('reads last N lines from a file', () => {
    const tmpFile = path.join(os.tmpdir(), `readlast-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
    const result = readLastLines(tmpFile, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0], 'line3');
    assert.equal(result[1], 'line4');
    assert.equal(result[2], 'line5');
    fs.unlinkSync(tmpFile);
  });

  it('returns empty array for nonexistent file', () => {
    const result = readLastLines('/tmp/nonexistent-file-' + Date.now() + '.txt', 5);
    assert.deepStrictEqual(result, []);
  });

  it('filters empty lines', () => {
    const tmpFile = path.join(os.tmpdir(), `readlast-empty-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'line1\n\n\nline2\n\nline3\n', 'utf8');
    const result = readLastLines(tmpFile, 10);
    assert.equal(result.length, 3);
    assert.equal(result[0], 'line1');
    assert.equal(result[1], 'line2');
    assert.equal(result[2], 'line3');
    fs.unlinkSync(tmpFile);
  });
});

describe('extractTextFromEntry', () => {

  it('returns string content directly', () => {
    const entry = { message: { content: 'Hello world' } };
    assert.equal(extractTextFromEntry(entry), 'Hello world');
  });

  it('returns first text block from array content', () => {
    const entry = {
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1' },
          { type: 'text', text: 'The result is ready' },
        ],
      },
    };
    assert.equal(extractTextFromEntry(entry), 'The result is ready');
  });

  it('returns empty string for missing content', () => {
    assert.equal(extractTextFromEntry({}), '');
    assert.equal(extractTextFromEntry(null), '');
    assert.equal(extractTextFromEntry({ message: {} }), '');
  });

  it('returns empty string when no text block in array', () => {
    const entry = {
      message: {
        content: [{ type: 'tool_use', id: 'tu_1' }],
      },
    };
    assert.equal(extractTextFromEntry(entry), '');
  });

  it('returns text and ignores null/non-object blocks in array content', () => {
    const entry = {
      message: {
        content: [null, 'junk', { type: 'text', text: 'The result is ready' }],
      },
    };
    assert.equal(extractTextFromEntry(entry), 'The result is ready');
  });

  it('returns empty string when array content has only a null block', () => {
    assert.equal(extractTextFromEntry({ message: { content: [null] } }), '');
  });
});
