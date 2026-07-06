const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Suppress the live diagnostic probes (categories 6–14, 17) for the whole file.
// Those categories spawnSync installed scripts that hit the network / MCP fleet
// and each carry a 15–30s timeout, so without this the suite hangs (>100s) and
// is non-deterministic (a genuinely-unhealthy fleet would inject unrelated
// issues). This flag leaves the fast file-scan categories — including the
// stubbed Category 15 health path exercised below — fully intact. Node runs each
// test file in its own child process, so this env cannot leak to other suites.
process.env.NF_OBSERVE_SKIP_LIVE_PROBES = '1';

const { handleInternal, formatAgeFromMtime } = require('./observe-handler-internal.cjs');

/**
 * Helper: create a temp directory for test isolation
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observe-internal-test-'));
}

/**
 * Helper: recursively remove directory
 */
function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Helper: create a file with optional content, ensuring parent dirs exist
 */
function createFile(base, relPath, content = '') {
  const full = path.join(base, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// ── Cross-cutting: Schema shape ──

describe('handleInternal schema', () => {
  it('returns correct schema shape with all required fields', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.ok('source_label' in result, 'missing source_label');
      assert.ok('source_type' in result, 'missing source_type');
      assert.ok('status' in result, 'missing status');
      assert.ok('issues' in result, 'missing issues');
      assert.equal(result.source_type, 'internal');
      assert.equal(result.status, 'ok');
      assert.ok(Array.isArray(result.issues));
    } finally {
      rmrf(tmpDir);
    }
  });

  it('uses custom label from sourceConfig', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = handleInternal({ label: 'Custom Label' }, { projectRoot: tmpDir });
      assert.equal(result.source_label, 'Custom Label');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('defaults label to Internal Work', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.equal(result.source_label, 'Internal Work');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── Category 1: Unfinished quick tasks ──

describe('Category 1 — Unfinished quick tasks', () => {
  it('reports task with PLAN but no SUMMARY', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/quick/42-some-task/42-PLAN.md', '---\nphase: quick-42\n---');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-quick-42');
      assert.ok(issue, 'should find quick task 42');
      assert.equal(issue.severity, 'warning');
      assert.ok(issue.title.includes('#42'));
      assert.ok(issue.title.includes('some-task'));
      assert.equal(issue.source_type, 'internal');
      assert.equal(issue.issue_type, 'issue');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('skips directory without numeric prefix', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/quick/no-number-here/PLAN.md', 'content');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const quickIssues = result.issues.filter(i => i.id.startsWith('internal-quick-'));
      assert.equal(quickIssues.length, 0);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('does NOT report task with both PLAN and SUMMARY', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/quick/99-done-task/99-PLAN.md', 'plan');
      createFile(tmpDir, '.planning/quick/99-done-task/99-SUMMARY.md', 'summary');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-quick-99');
      assert.equal(issue, undefined, 'completed task should not be reported');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('does not crash when quick dir does not exist (fail-open)', () => {
    const tmpDir = makeTmpDir();
    try {
      // No .planning/quick/ directory at all
      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.equal(result.status, 'ok');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── Category 2: Stale debug sessions ──

describe('Category 2 — Stale debug sessions', () => {
  it('reports recent debug file with "status: open"', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/quick/quorum-debug-latest.md', '# Debug\nstatus: open\nSome content');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-debug-latest');
      assert.ok(issue, 'should detect unresolved debug session');
      assert.equal(issue.severity, 'info');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('reports recent debug file with "unresolved" keyword', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/quick/quorum-debug-latest.md', '# Debug\nThis is unresolved');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-debug-latest');
      assert.ok(issue, 'should detect unresolved via keyword');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('does NOT report file older than 7 days', () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = createFile(tmpDir, '.planning/quick/quorum-debug-latest.md', 'status: open');
      // Set mtime to 8 days ago
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(filePath, eightDaysAgo, eightDaysAgo);
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-debug-latest');
      assert.equal(issue, undefined, 'old debug session should not be reported');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('does NOT report file without unresolved/open keywords', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/quick/quorum-debug-latest.md', '# Debug\nAll resolved.');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-debug-latest');
      assert.equal(issue, undefined, 'resolved debug session should not be reported');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── Category 3: TODO scanner ──

describe('Category 3 — TODO scanner', () => {
  it('detects TODO and FIXME in source files with correct severity', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, 'src/example.js', '// TODO: fix this\nconst x = 1;\n// FIXME: urgent\n');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const todoIssues = result.issues.filter(i => i.id.startsWith('internal-todo-'));
      assert.ok(todoIssues.length >= 2, `expected >=2 TODO issues, got ${todoIssues.length}`);

      const todoItem = todoIssues.find(i => i.title.includes('TODO'));
      assert.ok(todoItem, 'should find TODO item');
      assert.equal(todoItem.severity, 'info');

      const fixmeItem = todoIssues.find(i => i.title.includes('FIXME'));
      assert.ok(fixmeItem, 'should find FIXME item');
      assert.equal(fixmeItem.severity, 'warning');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('enriches TODO issues with fingerprint fields (exception_type, function_name)', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, 'src/app.js', '// TODO: add validation\n');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const todoIssues = result.issues.filter(i => i.id.startsWith('internal-todo-'));
      assert.ok(todoIssues.length >= 1);

      const item = todoIssues[0];
      assert.ok(item.exception_type, 'should have exception_type');
      assert.equal(item.exception_type, 'TODO');
      assert.ok(item.function_name, 'should have function_name');
      assert.ok(item.function_name.includes('src/app.js'), `function_name should include relative path, got: ${item.function_name}`);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('excludes files in .planning/ directory', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/some-plan.md', '<!-- TODO: plan item -->');
      createFile(tmpDir, 'src/real.js', '// TODO: real item\n');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const planningTodos = result.issues.filter(i =>
        i.id.startsWith('internal-todo-') && i.id.includes('.planning/')
      );
      assert.equal(planningTodos.length, 0, '.planning/ TODOs should be excluded');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('respects limitOverride option', () => {
    const tmpDir = makeTmpDir();
    try {
      // Create many TODOs
      let content = '';
      for (let i = 0; i < 20; i++) {
        content += `// TODO: item ${i}\n`;
      }
      createFile(tmpDir, 'src/many.js', content);
      const result = handleInternal({}, { projectRoot: tmpDir, limitOverride: 5 });
      const todoIssues = result.issues.filter(i => i.id.startsWith('internal-todo-'));
      assert.ok(todoIssues.length <= 5, `limit should cap at 5, got ${todoIssues.length}`);
    } finally {
      rmrf(tmpDir);
    }
  });

  it('handles non-existent projectRoot without crash (fail-open)', () => {
    const result = handleInternal({}, { projectRoot: '/tmp/nonexistent-observe-test-dir-xyz' });
    assert.equal(result.status, 'ok');
    const todoIssues = result.issues.filter(i => i.id.startsWith('internal-todo-'));
    assert.equal(todoIssues.length, 0, 'non-existent root should yield zero TODOs');
  });

  it('detects HACK and XXX tags with warning severity', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, 'src/hack.js', '// HACK: workaround\n// XXX: danger\n');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const hackIssue = result.issues.find(i => i.id.startsWith('internal-todo-') && i.title.includes('HACK'));
      const xxxIssue = result.issues.find(i => i.id.startsWith('internal-todo-') && i.title.includes('XXX'));
      assert.ok(hackIssue, 'should find HACK');
      assert.equal(hackIssue.severity, 'warning');
      assert.ok(xxxIssue, 'should find XXX');
      assert.equal(xxxIssue.severity, 'warning');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── Category 4: Active unverified phases ──

describe('Category 4 — Active unverified phases', () => {
  it('reports active phase without VERIFICATION.md', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/STATE.md', '# Project State\n\nPhase: 01-test\nPlan: 01\n');
      fs.mkdirSync(path.join(tmpDir, '.planning/phases/01-test'), { recursive: true });
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-milestone-01-test');
      assert.ok(issue, 'should detect unverified phase');
      assert.equal(issue.severity, 'warning');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('skips when phase is "-" placeholder', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/STATE.md', '# Project State\n\nPhase: -\nPlan: -\n');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const milestoneIssues = result.issues.filter(i => i.id.startsWith('internal-milestone-'));
      assert.equal(milestoneIssues.length, 0, 'placeholder phase should be skipped');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('does NOT report phase with VERIFICATION.md present', () => {
    const tmpDir = makeTmpDir();
    try {
      createFile(tmpDir, '.planning/STATE.md', '# Project State\n\nPhase: 02-done\nPlan: 01\n');
      createFile(tmpDir, '.planning/phases/02-done/02-done-VERIFICATION.md', 'verified');
      const result = handleInternal({}, { projectRoot: tmpDir });
      const issue = result.issues.find(i => i.id === 'internal-milestone-02-done');
      assert.equal(issue, undefined, 'verified phase should not be reported');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── formatAgeFromMtime ──

describe('formatAgeFromMtime', () => {
  it('returns minutes for recent times', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000);
    assert.equal(formatAgeFromMtime(fiveMinAgo), '5m');
  });

  it('returns hours for multi-hour times', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000);
    assert.equal(formatAgeFromMtime(twoHoursAgo), '2h');
  });

  it('returns days for multi-day times', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
    assert.equal(formatAgeFromMtime(threeDaysAgo), '3d');
  });

  it('returns unknown for null', () => {
    assert.equal(formatAgeFromMtime(null), 'unknown');
  });

  it('returns unknown for non-Date', () => {
    assert.equal(formatAgeFromMtime('not a date'), 'unknown');
  });

  it('returns future for future dates', () => {
    const future = new Date(Date.now() + 60000);
    assert.equal(formatAgeFromMtime(future), 'future');
  });
});

// ── Category 15: Health diagnostics ──

describe('Category 15 — Health diagnostics', () => {
  it('skips when core/bin/nf-tools.cjs absent (non-QNF repo)', () => {
    const tmpDir = makeTmpDir();
    try {
      // No core/bin/nf-tools.cjs — should silently skip
      const result = handleInternal({}, { projectRoot: tmpDir });
      const healthIssues = result.issues.filter(i => i.id.startsWith('internal-health-'));
      assert.equal(healthIssues.length, 0, 'no health issues when nf-tools absent');
      assert.equal(result.status, 'ok');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('maps health check JSON output to observe issues with correct severities and routes', () => {
    const tmpDir = makeTmpDir();
    try {
      const mockScript = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  status: 'degraded',
  errors: [{ code: 'E001', message: '.planning/ directory not found', fix: 'Run init', repairable: false }],
  warnings: [{ code: 'W003', message: 'config.json not found', fix: 'Run repair', repairable: true }],
  info: [{ code: 'I001', message: 'Plan has no SUMMARY', fix: 'May be in progress', repairable: false }],
  repairable_count: 1
}));`;
      createFile(tmpDir, 'core/bin/nf-tools.cjs', mockScript);
      fs.chmodSync(path.join(tmpDir, 'core/bin/nf-tools.cjs'), 0o755);

      const result = handleInternal({}, { projectRoot: tmpDir });
      const healthIssues = result.issues.filter(i => i.id.startsWith('internal-health-'));

      // Error issue
      const e001 = healthIssues.find(i => i.id === 'internal-health-E001');
      assert.ok(e001, 'should find E001 error');
      assert.equal(e001.severity, 'error');
      assert.equal(e001._route, '/nf:solve');
      assert.ok(e001.title.includes('.planning/ directory not found'));

      // Warning issue (repairable)
      const w003 = healthIssues.find(i => i.id === 'internal-health-W003');
      assert.ok(w003, 'should find W003 warning');
      assert.equal(w003.severity, 'warning');
      assert.equal(w003._route, '/nf:health --repair', 'repairable warning should route to health --repair');

      // Info issue
      const i001 = healthIssues.find(i => i.id === 'internal-health-I001');
      assert.ok(i001, 'should find I001 info');
      assert.equal(i001.severity, 'info');
      assert.equal(i001._route, '/nf:solve');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('fail-open when nf-tools.cjs returns non-JSON', () => {
    const tmpDir = makeTmpDir();
    try {
      const mockScript = `#!/usr/bin/env node
process.stdout.write('not json');`;
      createFile(tmpDir, 'core/bin/nf-tools.cjs', mockScript);
      fs.chmodSync(path.join(tmpDir, 'core/bin/nf-tools.cjs'), 0o755);

      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.equal(result.status, 'ok');
      const healthIssues = result.issues.filter(i => i.id.startsWith('internal-health-'));
      assert.equal(healthIssues.length, 0, 'non-JSON output should yield no health issues');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('fail-open when nf-tools.cjs exits non-zero', () => {
    const tmpDir = makeTmpDir();
    try {
      const mockScript = `#!/usr/bin/env node
process.exit(1);`;
      createFile(tmpDir, 'core/bin/nf-tools.cjs', mockScript);
      fs.chmodSync(path.join(tmpDir, 'core/bin/nf-tools.cjs'), 0o755);

      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.equal(result.status, 'ok');
      const healthIssues = result.issues.filter(i => i.id.startsWith('internal-health-'));
      assert.equal(healthIssues.length, 0, 'non-zero exit should yield no health issues');
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── Fail-open cross-cutting ──

describe('Fail-open behavior', () => {
  it('other categories still run when quick dir is missing', () => {
    const tmpDir = makeTmpDir();
    try {
      // Only create a TODO file, no .planning/quick
      createFile(tmpDir, 'src/test.js', '// TODO: check\n');
      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.equal(result.status, 'ok');
      // Should still find the TODO even without quick dir
      const todoIssues = result.issues.filter(i => i.id.startsWith('internal-todo-'));
      assert.ok(todoIssues.length >= 1, 'TODOs should still be found');
    } finally {
      rmrf(tmpDir);
    }
  });

  it('returns ok status even when no issues found anywhere', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = handleInternal({}, { projectRoot: tmpDir });
      assert.equal(result.status, 'ok');
      assert.equal(result.issues.length, 0);
    } finally {
      rmrf(tmpDir);
    }
  });
});

// ── Live-probe suppression (skipLiveProbes) ──
// The file sets NF_OBSERVE_SKIP_LIVE_PROBES=1 globally; these tests additionally
// pin the opts-flag channel and prove the suppression is scoped to the
// resolveScript-based categories (6–14, 17) and does NOT swallow Category 15,
// whose health script resolves via a separate project-local path.

describe('Live-probe suppression (skipLiveProbes)', () => {
  it('opts.skipLiveProbes works with env cleared, yet Category 15 health still fires', () => {
    const tmpDir = makeTmpDir();
    const savedEnv = process.env.NF_OBSERVE_SKIP_LIVE_PROBES;
    try {
      // Prove the opts channel independently of the file-level env flag.
      delete process.env.NF_OBSERVE_SKIP_LIVE_PROBES;

      // Category 15 uses projectRoot/core/bin/nf-tools.cjs (NOT resolveScript),
      // so it must survive skipLiveProbes. Stub it to emit one warning.
      const mockScript = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ status: 'degraded', warnings: [{ code: 'W1', message: 'stub', fix: 'x', repairable: false }] }));`;
      createFile(tmpDir, 'core/bin/nf-tools.cjs', mockScript);
      fs.chmodSync(path.join(tmpDir, 'core/bin/nf-tools.cjs'), 0o755);

      const result = handleInternal({ }, { projectRoot: tmpDir, skipLiveProbes: true });
      assert.equal(result.status, 'ok');
      const health = result.issues.filter(i => i.id.startsWith('internal-health-'));
      assert.equal(health.length, 1, 'Category 15 health must still run under skipLiveProbes');
      assert.equal(health[0].id, 'internal-health-W1');
    } finally {
      if (savedEnv === undefined) delete process.env.NF_OBSERVE_SKIP_LIVE_PROBES;
      else process.env.NF_OBSERVE_SKIP_LIVE_PROBES = savedEnv;
      rmrf(tmpDir);
    }
  });
});

// ── Adversarial: entry-point arg guards ──

describe('Adversarial — entry-point arg guards', () => {
  it('does not crash when sourceConfig is null (fail-open)', () => {
    const tmpDir = makeTmpDir();
    try {
      let result;
      assert.doesNotThrow(() => {
        result = handleInternal(null, { projectRoot: tmpDir });
      }, 'null sourceConfig must not throw');
      assert.ok(result && typeof result === 'object');
      assert.equal(result.source_type, 'internal');
      assert.equal(result.source_label, 'Internal Work');
      assert.ok(Array.isArray(result.issues));
    } finally {
      rmrf(tmpDir);
    }
  });
});

describe('Adversarial — options omitted', () => {
  it('defaults projectRoot to cwd when options is undefined (no crash)', () => {
    const tmpDir = makeTmpDir();
    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir); // make cwd a controlled empty dir to avoid scanning the real repo
      let result;
      assert.doesNotThrow(() => {
        result = handleInternal({});
      }, 'undefined options must not throw');
      assert.ok(result && typeof result === 'object');
      assert.equal(result.source_type, 'internal');
      assert.ok(Array.isArray(result.issues));
    } finally {
      process.chdir(origCwd);
      rmrf(tmpDir);
    }
  });
});
