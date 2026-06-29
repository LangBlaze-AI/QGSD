'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  handleSessionInsights,
  validateMaxSessions,
  listSessionFiles,
  analyzeSession
} = require('./observe-handler-session-insights.cjs');

// Helper: create a temp directory
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-insights-test-'));
}

function writeJsonlFile(dir, name, lines) {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

describe('observe-handler-session-insights', () => {

  describe('fail-open behavior', () => {
    it('returns ok with empty issues for nonexistent project dir', () => {
      const result = handleSessionInsights(
        { label: 'Test' },
        { projectRoot: '/nonexistent/path/that/does/not/exist' }
      );
      assert.equal(result.status, 'ok');
      assert.deepEqual(result.issues, []);
      assert.equal(result.source_type, 'session-insights');
    });

    it('returns ok with empty issues when called with empty config', () => {
      const result = handleSessionInsights({}, {});
      assert.equal(result.status, 'ok');
      assert.equal(result.source_type, 'session-insights');
    });
  });

  describe('validateMaxSessions', () => {
    it('defaults to 20 for undefined', () => {
      assert.equal(validateMaxSessions(undefined), 20);
    });

    it('defaults to 20 for null', () => {
      assert.equal(validateMaxSessions(null), 20);
    });

    it('defaults to 20 for 0', () => {
      assert.equal(validateMaxSessions(0), 20);
    });

    it('defaults to 20 for negative', () => {
      assert.equal(validateMaxSessions(-1), 20);
    });

    it('defaults to 20 for "abc"', () => {
      assert.equal(validateMaxSessions('abc'), 20);
    });

    it('accepts valid positive integer', () => {
      assert.equal(validateMaxSessions(5), 5);
    });

    it('defaults to 20 for float', () => {
      assert.equal(validateMaxSessions(3.5), 20);
    });
  });

  describe('listSessionFiles', () => {
    it('skips files smaller than 500 bytes', () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'tiny.jsonl'), 'x');
        const files = listSessionFiles(dir, 20, 5242880);
        assert.equal(files.length, 0);
      } finally {
        cleanup(dir);
      }
    });

    it('skips files larger than max_file_size_bytes', () => {
      const dir = createTempDir();
      try {
        fs.writeFileSync(path.join(dir, 'big.jsonl'), 'x'.repeat(100));
        const files = listSessionFiles(dir, 20, 50);
        assert.equal(files.length, 0);
      } finally {
        cleanup(dir);
      }
    });

    it('respects maxSessions limit', () => {
      const dir = createTempDir();
      try {
        for (let i = 0; i < 5; i++) {
          fs.writeFileSync(path.join(dir, `session${i}.jsonl`), 'x'.repeat(600));
        }
        const files = listSessionFiles(dir, 2, 5242880);
        assert.equal(files.length, 2);
      } finally {
        cleanup(dir);
      }
    });

    it('sorts by mtime descending', () => {
      const dir = createTempDir();
      try {
        const file1 = path.join(dir, 'old.jsonl');
        const file2 = path.join(dir, 'new.jsonl');
        fs.writeFileSync(file1, 'x'.repeat(600));
        const oldTime = new Date(Date.now() - 86400000);
        fs.utimesSync(file1, oldTime, oldTime);
        fs.writeFileSync(file2, 'x'.repeat(600));

        const files = listSessionFiles(dir, 20, 5242880);
        assert.equal(files[0].name, 'new.jsonl');
        assert.equal(files[1].name, 'old.jsonl');
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - Category 1: Repeated tool failures', () => {
    it('detects tool failing 3+ times', () => {
      const dir = createTempDir();
      try {
        const lines = [
          { type: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
          { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'error 1' }] },
          { type: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } }] },
          { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'error 2' }] },
          { type: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'ls' } }] },
          { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', is_error: true, content: 'error 3' }] },
        ];
        const filePath = writeJsonlFile(dir, 'test-fail.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-fail.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const toolFailures = issues.filter(i => i.id.includes('tool-failure'));
        assert.equal(toolFailures.length, 1);
        assert.ok(toolFailures[0].title.includes("Tool 'Bash' failed 3 times"));
        assert.equal(toolFailures[0].severity, 'warning');
      } finally {
        cleanup(dir);
      }
    });

    it('does not report tool with fewer than 3 failures', () => {
      const dir = createTempDir();
      try {
        const lines = [
          { type: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
          { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'err' }] },
          { type: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }] },
          { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'err' }] },
        ];
        const filePath = writeJsonlFile(dir, 'test-2fail.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-2fail.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const toolFailures = issues.filter(i => i.id.includes('tool-failure'));
        assert.equal(toolFailures.length, 0);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - Category 2: Long sessions', () => {
    it('detects session with 50+ assistant turns', () => {
      const dir = createTempDir();
      try {
        const lines = [];
        for (let i = 0; i < 55; i++) {
          lines.push({ type: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] });
        }
        const filePath = writeJsonlFile(dir, 'test-long.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-long.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const longSessions = issues.filter(i => i.id.includes('long-session'));
        assert.equal(longSessions.length, 1);
        assert.ok(longSessions[0].title.includes('55 turns'));
        assert.equal(longSessions[0].severity, 'info');
      } finally {
        cleanup(dir);
      }
    });

    it('does not report session with fewer than 50 turns', () => {
      const dir = createTempDir();
      try {
        const lines = [];
        for (let i = 0; i < 30; i++) {
          lines.push({ type: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] });
        }
        const filePath = writeJsonlFile(dir, 'test-short.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-short.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const longSessions = issues.filter(i => i.id.includes('long-session'));
        assert.equal(longSessions.length, 0);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - Category 3: Circuit breaker triggers', () => {
    it('detects OSCILLATION_DETECTED in assistant text', () => {
      const dir = createTempDir();
      try {
        const lines = [
          { type: 'assistant', content: [{ type: 'text', text: 'OSCILLATION_DETECTED: stopping' }] },
        ];
        const filePath = writeJsonlFile(dir, 'test-osc.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-osc.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const breakers = issues.filter(i => i.id.includes('circuit-breaker'));
        assert.equal(breakers.length, 1);
        assert.equal(breakers[0].severity, 'warning');
      } finally {
        cleanup(dir);
      }
    });

    it('detects circuit breaker from progress events', () => {
      const dir = createTempDir();
      try {
        const lines = [
          { type: 'progress', data: { type: 'hook_progress', hook: 'nf-circuit-breaker', status: 'triggered' } },
        ];
        const filePath = writeJsonlFile(dir, 'test-cb.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-cb.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const breakers = issues.filter(i => i.id.includes('circuit-breaker'));
        assert.equal(breakers.length, 1);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - Category 4: Repeated file edits', () => {
    it('detects same file edited 5+ times', () => {
      const dir = createTempDir();
      try {
        const lines = [];
        for (let i = 0; i < 6; i++) {
          lines.push({
            type: 'assistant',
            content: [{ type: 'tool_use', id: `tu${i}`, name: 'Edit', input: { file_path: '/src/main.js' } }]
          });
        }
        const filePath = writeJsonlFile(dir, 'test-churn.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-churn.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const churn = issues.filter(i => i.id.includes('file-churn'));
        assert.equal(churn.length, 1);
        assert.ok(churn[0].title.includes("'/src/main.js' edited 6 times"));
        assert.equal(churn[0].severity, 'warning');
      } finally {
        cleanup(dir);
      }
    });

    it('tracks Write tool with .input.path', () => {
      const dir = createTempDir();
      try {
        const lines = [];
        for (let i = 0; i < 5; i++) {
          lines.push({
            type: 'assistant',
            content: [{ type: 'tool_use', id: `tu${i}`, name: 'Write', input: { path: '/src/out.txt' } }]
          });
        }
        const filePath = writeJsonlFile(dir, 'test-write.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-write.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const churn = issues.filter(i => i.id.includes('file-churn'));
        assert.equal(churn.length, 1);
        assert.ok(churn[0].title.includes('/src/out.txt'));
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - Category 5: Hook failures', () => {
    it('detects hook failure from progress events', () => {
      const dir = createTempDir();
      try {
        const lines = [
          { type: 'progress', data: { type: 'hook_progress', hook: 'nf-stop', status: 'error' } },
        ];
        const filePath = writeJsonlFile(dir, 'test-hook.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'test-hook.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });

        const hookIssues = issues.filter(i => i.id.includes('hook-failure'));
        assert.equal(hookIssues.length, 1);
        assert.ok(hookIssues[0].meta.includes('nf-stop'));
        assert.equal(hookIssues[0].severity, 'info');
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - malformed JSONL', () => {
    it('skips malformed lines without crashing', () => {
      const dir = createTempDir();
      try {
        const content = '{"type":"assistant","content":[{"type":"text","text":"ok"}]}\n' +
          'this is not json\n' +
          '{broken json\n' +
          '{"type":"assistant","content":[{"type":"text","text":"fine"}]}\n';
        const filePath = path.join(dir, 'malformed.jsonl');
        fs.writeFileSync(filePath, content);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'malformed.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });
        assert.ok(Array.isArray(issues));
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - adversarial: literal null line', () => {
    it('does not silently drop a session when a transcript line is literal null', () => {
      const dir = createTempDir();
      try {
        const lines = [null];
        for (let i = 0; i < 55; i++) {
          lines.push({ type: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] });
        }
        const filePath = writeJsonlFile(dir, 'null-line.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'null-line.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });
        const longSessions = issues.filter(i => i.id.includes('long-session'));
        assert.equal(longSessions.length, 1);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('analyzeSession - adversarial: null content block', () => {
    it('does not silently drop a session when a content array contains null', () => {
      const dir = createTempDir();
      try {
        const lines = [{ type: 'assistant', content: [null] }];
        for (let i = 0; i < 55; i++) {
          lines.push({ type: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] });
        }
        const filePath = writeJsonlFile(dir, 'null-block.jsonl', lines);
        const stat = fs.statSync(filePath);
        const issues = analyzeSession({ name: 'null-block.jsonl', path: filePath, mtime: stat.mtime, size: stat.size });
        const longSessions = issues.filter(i => i.id.includes('long-session'));
        assert.equal(longSessions.length, 1);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('handleSessionInsights - return schema', () => {
    it('returns correct source_type', () => {
      const result = handleSessionInsights({ label: 'Test' }, {});
      assert.equal(result.source_type, 'session-insights');
    });

    it('returns ok status on success', () => {
      const result = handleSessionInsights({ label: 'Test' }, {});
      assert.equal(result.status, 'ok');
    });

    it('exports handleSessionInsights as a function', () => {
      assert.equal(typeof handleSessionInsights, 'function');
    });
  });
});
