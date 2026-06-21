'use strict';
// hooks/nf-node-eval-guard.test.js
// Tests for the node -e → heredoc rewriter (PreToolUse hook).
//
// Pure function tests run directly; integration tests use spawnSync.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, 'nf-node-eval-guard.js');
const { rewriteCommand, findClosingQuote, isInsideQuotes } = require('./nf-node-eval-guard');

// ─── findClosingQuote ───────────────────────────────────────

describe('findClosingQuote', () => {
  it('finds single quote', () => {
    assert.equal(findClosingQuote("hello' world", 0, "'"), 5);
  });

  it('single quote has no escape handling', () => {
    assert.equal(findClosingQuote("he\\'llo' world", 0, "'"), 3);
  });

  it('finds double quote', () => {
    assert.equal(findClosingQuote('hello" world', 0, '"'), 5);
  });

  it('skips escaped double quotes', () => {
    assert.equal(findClosingQuote('he\\"llo" world', 0, '"'), 7);
  });

  it('returns null for unterminated double quote', () => {
    assert.equal(findClosingQuote('hello world', 0, '"'), null);
  });

  it('returns null for unterminated single quote', () => {
    assert.equal(findClosingQuote('hello world', 0, "'"), null);
  });
});

// ─── rewriteCommand: basic rewrites ────────────────────────

describe('rewriteCommand basic', () => {
  it('rewrites double-quoted node -e', () => {
    const input = 'node -e "console.log(1)"';
    const expected = "node << 'NF_EVAL'\nconsole.log(1)\nNF_EVAL";
    assert.equal(rewriteCommand(input), expected);
  });

  it('rewrites single-quoted node -e', () => {
    const input = "node -e 'console.log(1)'";
    const expected = "node << 'NF_EVAL'\nconsole.log(1)\nNF_EVAL";
    assert.equal(rewriteCommand(input), expected);
  });

  it('rewrites node -e with !== (the original bug)', () => {
    const input = 'node -e "if (x !== 1) console.log(x)"';
    const expected = "node << 'NF_EVAL'\nif (x !== 1) console.log(x)\nNF_EVAL";
    assert.equal(rewriteCommand(input), expected);
  });

  it('rewrites node -e with !var (negation)', () => {
    const input = 'node -e "if (!found) process.exit(1)"';
    const expected = "node << 'NF_EVAL'\nif (!found) process.exit(1)\nNF_EVAL";
    assert.equal(rewriteCommand(input), expected);
  });
});

// ─── rewriteCommand: preserves context ─────────────────────

describe('rewriteCommand context preservation', () => {
  it('preserves variable capture prefix', () => {
    const input = 'VAR=$(node -e "console.log(42)")';
    const expected = "VAR=$(node << 'NF_EVAL'\nconsole.log(42)\nNF_EVAL)";
    assert.equal(rewriteCommand(input), expected);
  });

  it('preserves env var prefix', () => {
    const input = 'AGENT="foo" node -e "console.log(1)"';
    const expected = "AGENT=\"foo\" node << 'NF_EVAL'\nconsole.log(1)\nNF_EVAL";
    assert.equal(rewriteCommand(input), expected);
  });

  it('preserves redirect suffix', () => {
    const input = 'node -e "console.log(1)" 2>/dev/null';
    const expected = "node << 'NF_EVAL'\nconsole.log(1)\nNF_EVAL 2>/dev/null";
    assert.equal(rewriteCommand(input), expected);
  });

  it('preserves fallback chain', () => {
    const input = 'node -e "console.log(1)" 2>/dev/null || echo "default"';
    const expected = "node << 'NF_EVAL'\nconsole.log(1)\nNF_EVAL 2>/dev/null || echo \"default\"";
    assert.equal(rewriteCommand(input), expected);
  });

  it('handles multi-line JS code', () => {
    const js = 'var x = 1;\nif (x !== 2) {\n  console.log(x);\n}';
    const input = `node -e "${js}"`;
    const expected = `node << 'NF_EVAL'\n${js}\nNF_EVAL`;
    assert.equal(rewriteCommand(input), expected);
  });
});

// ─── rewriteCommand: multiple node -e ──────────────────────

describe('rewriteCommand multiple', () => {
  it('rewrites multiple node -e with unique delimiters', () => {
    const input = 'node -e "console.log(1)" && node -e "console.log(2)"';
    const result = rewriteCommand(input);
    assert.ok(result.includes('NF_EVAL_0'));
    assert.ok(result.includes('NF_EVAL_1'));
    assert.ok(result.includes('console.log(1)'));
    assert.ok(result.includes('console.log(2)'));
  });
});

// ─── rewriteCommand: skip cases ────────────────────────────

describe('rewriteCommand skip cases', () => {
  it('returns null for commands without node -e', () => {
    assert.equal(rewriteCommand('ls -la'), null);
  });

  it('returns null for node without -e', () => {
    assert.equal(rewriteCommand('node script.js'), null);
  });

  it('returns null for already-rewritten heredoc', () => {
    assert.equal(rewriteCommand("node << 'NF_EVAL'\nconsole.log(1)\nNF_EVAL"), null);
  });

  it('returns null for cat heredoc piped to node', () => {
    assert.equal(rewriteCommand("cat << 'SCRIPT' | node\nconsole.log(1)\nSCRIPT"), null);
  });

  it('returns null for empty command', () => {
    assert.equal(rewriteCommand(''), null);
  });

  it('skips unterminated quotes gracefully', () => {
    assert.equal(rewriteCommand('node -e "console.log(1)'), null);
  });
});

// ─── isInsideQuotes ────────────────────────────────────────

describe('isInsideQuotes', () => {
  it('is false at start of command', () => {
    assert.equal(isInsideQuotes('node -e "x"', 0), false);
  });

  it('is true inside an open single quote', () => {
    // index of "node" inside grep 'node -e "x"'
    const cmd = "grep 'node -e \"x\"' src";
    assert.equal(isInsideQuotes(cmd, cmd.indexOf('node')), true);
  });

  it('is true inside an open double quote', () => {
    const cmd = 'echo "run node -e foo"';
    assert.equal(isInsideQuotes(cmd, cmd.indexOf('node')), true);
  });

  it('is false after a balanced quote closes', () => {
    const cmd = 'AGENT="foo" node -e "x"';
    assert.equal(isInsideQuotes(cmd, cmd.indexOf('node')), false);
  });

  it('single quotes do not honor backslash escapes', () => {
    // Backslash is literal inside single quotes, so the next ' DOES close the
    // quote (it is not escaped) — leaving `b node` unquoted, hence outside.
    const cmd = "echo 'a\\'b node";
    assert.equal(isInsideQuotes(cmd, cmd.indexOf('node')), false);
  });
});

// ─── rewriteCommand: quoted-substring false positives ──────

describe('rewriteCommand quoted-substring guard', () => {
  it('does NOT rewrite node -e inside a single-quoted grep pattern (the repro)', () => {
    const input = "grep -rl 'node -e \"' get-shit-done core 2>/dev/null";
    assert.equal(rewriteCommand(input), null);
  });

  it('does NOT rewrite node -e inside a double-quoted echo string', () => {
    const input = 'echo "always rewrite node -e \'code\' to heredoc"';
    assert.equal(rewriteCommand(input), null);
  });

  it('still rewrites a real node -e even when a quoted mention precedes it', () => {
    const input = "echo 'use node -e' && node -e \"console.log(1)\"";
    const result = rewriteCommand(input);
    assert.ok(result !== null);
    assert.ok(result.includes("node << 'NF_EVAL'"));
    assert.ok(result.includes('console.log(1)'));
    // the echo'd mention must be left untouched
    assert.ok(result.includes("echo 'use node -e'"));
  });
});

// ─── rewriteCommand: edge cases ────────────────────────────

describe('rewriteCommand edge cases', () => {
  it('handles escaped double quotes in JS code', () => {
    const input = 'node -e "console.log(\\"hello\\")"';
    const result = rewriteCommand(input);
    assert.ok(result !== null);
    assert.ok(result.includes('NF_EVAL'));
  });
});

// ─── Integration: full hook via stdin ──────────────────────

describe('hook integration', () => {
  it('denies node -e command and provides heredoc rewrite', () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'node -e "console.log(1)"' },
      cwd: process.cwd(),
    });

    const result = spawnSync('node', [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 0, 'hook should exit 0');
    assert.ok(result.stdout, 'hook should produce output');
    const output = JSON.parse(result.stdout);
    assert.ok(output.hookSpecificOutput);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('NF_EVAL'));
    assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes('console.log(1)'));
  });

  it('passes through non-node commands unchanged', () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: process.cwd(),
    });

    const result = spawnSync('node', [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'no output means pass-through');
  });

  it('passes through non-Bash tools', () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo' },
      cwd: process.cwd(),
    });

    const result = spawnSync('node', [HOOK_PATH], {
      input: payload,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  it('fail-open on malformed stdin', () => {
    const result = spawnSync('node', [HOOK_PATH], {
      input: 'not json',
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 0, 'should exit 0 (fail-open)');
    assert.equal(result.stdout, '', 'no output on error');
  });

  it('fail-open on empty stdin', () => {
    const result = spawnSync('node', [HOOK_PATH], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 0);
  });
});
