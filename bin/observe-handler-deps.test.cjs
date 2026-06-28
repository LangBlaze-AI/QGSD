/**
 * Tests for observe-handler-deps.cjs
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  handleDeps,
  detectEcosystems,
  checkNpmOutdated,
  checkNpmAudit,
  checkNodeVersion,
  checkPipOutdated,
  checkPythonVersion,
  classifyVersionBump,
  parseSemver
} = require('./observe-handler-deps.cjs');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deps-test-'));
}

describe('parseSemver', () => {
  it('parses standard semver', () => {
    assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
  });
  it('strips v prefix', () => {
    assert.deepEqual(parseSemver('v22.1.0'), [22, 1, 0]);
  });
  it('handles null', () => {
    assert.deepEqual(parseSemver(null), [0, 0, 0]);
  });
});

describe('parseSemver / checkNpmOutdated non-string versions', () => {
  it('parseSemver coerces a numeric version instead of throwing', () => {
    assert.deepEqual(parseSemver(22), [22, 0, 0]);
  });

  it('checkNpmOutdated still reports packages when a version field is numeric', () => {
    const mockExec = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'outdated') {
        const err = new Error('exit code 1');
        err.stdout = JSON.stringify({
          lodash: { current: 4, latest: 5 },
          express: { current: '4.18.0', latest: '5.0.0' }
        });
        throw err;
      }
      return '';
    };
    const issues = checkNpmOutdated('/tmp', mockExec);
    // both packages must survive; current code returns [] because the numeric
    // lodash entry throws and the outer catch discards everything
    assert.equal(issues.length, 2);
    assert.ok(issues.some(i => /express/.test(i.title)));
  });
});

describe('classifyVersionBump', () => {
  it('returns warning for major bump', () => {
    assert.equal(classifyVersionBump('1.0.0', '2.0.0'), 'warning');
  });
  it('returns info for minor bump', () => {
    assert.equal(classifyVersionBump('1.0.0', '1.1.0'), 'info');
  });
  it('returns info for patch bump', () => {
    assert.equal(classifyVersionBump('1.0.0', '1.0.1'), 'info');
  });
});

describe('detectEcosystems', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('detects node from package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    assert.deepEqual(detectEcosystems(tmpDir), ['node']);
  });

  it('detects python from requirements.txt', () => {
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
    assert.deepEqual(detectEcosystems(tmpDir), ['python']);
  });

  it('detects python from pyproject.toml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\n');
    assert.deepEqual(detectEcosystems(tmpDir), ['python']);
  });

  it('detects both', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
    assert.deepEqual(detectEcosystems(tmpDir), ['node', 'python']);
  });

  it('returns empty for unknown project', () => {
    assert.deepEqual(detectEcosystems(tmpDir), []);
  });
});

describe('checkNpmOutdated', () => {
  it('parses npm outdated json output', () => {
    const mockExec = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'outdated') {
        // npm outdated throws when packages are outdated — simulate that
        const err = new Error('exit code 1');
        err.stdout = JSON.stringify({
          lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21', location: '' },
          express: { current: '4.18.0', wanted: '4.19.0', latest: '5.0.0', location: '' }
        });
        throw err;
      }
      return '';
    };
    const issues = checkNpmOutdated('/tmp', mockExec);
    assert.equal(issues.length, 2);
    assert.match(issues[0].title, /lodash/);
    assert.match(issues[1].title, /express/);
    assert.equal(issues[1]._deps.bumpType, 'MAJOR'); // 4.x → 5.x
    assert.equal(issues[0]._deps.bumpType, 'patch'); // 4.17.20 → 4.17.21
  });

  it('returns empty on error', () => {
    const mockExec = () => { throw new Error('npm not found'); };
    const issues = checkNpmOutdated('/tmp', mockExec);
    assert.deepEqual(issues, []);
  });
});

describe('checkNpmAudit', () => {
  it('parses npm audit json output', () => {
    const mockExec = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'audit') {
        const err = new Error('exit code 1');
        err.stdout = JSON.stringify({
          vulnerabilities: {
            'lodash': {
              severity: 'high',
              via: [{ title: 'Prototype Pollution' }],
              range: '<4.17.21',
              fixAvailable: true
            }
          }
        });
        throw err;
      }
      return '';
    };
    const issues = checkNpmAudit('/tmp', mockExec);
    assert.equal(issues.length, 1);
    assert.match(issues[0].title, /\[VULN\]/);
    assert.match(issues[0].title, /lodash/);
    assert.equal(issues[0].severity, 'error'); // high → error
  });
});

describe('checkNodeVersion', () => {
  it('flags outdated node version', () => {
    // Mock node returning an old major version (below NODE_LTS_MAJOR=22)
    const mockExec = (cmd) => {
      if (cmd === 'node') return 'v18.0.0\n';
      return '';
    };
    const issue = checkNodeVersion(mockExec);
    assert.ok(issue);
    assert.match(issue.title, /Node\.js/);
    assert.equal(issue.severity, 'warning');
  });

  it('returns null when up to date', () => {
    const mockExec = (cmd) => {
      if (cmd === 'node') return 'v22.0.0\n';
      return '';
    };
    const issue = checkNodeVersion(mockExec);
    assert.equal(issue, null);
  });
});

describe('checkPipOutdated', () => {
  it('parses pip list --outdated output', () => {
    const mockExec = () => JSON.stringify([
      { name: 'flask', version: '2.3.0', latest_version: '3.0.0', latest_filetype: 'wheel' },
      { name: 'requests', version: '2.31.0', latest_version: '2.32.0', latest_filetype: 'wheel' }
    ]);
    const issues = checkPipOutdated('/tmp', mockExec);
    assert.equal(issues.length, 2);
    assert.equal(issues[0]._deps.bumpType, 'MAJOR');
    assert.equal(issues[1]._deps.bumpType, 'minor');
  });
});

describe('checkPythonVersion', () => {
  it('flags old python', () => {
    const mockExec = () => 'Python 3.9.7\n';
    const issue = checkPythonVersion(mockExec);
    assert.ok(issue);
    assert.match(issue.title, /Python/);
  });

  it('returns null for modern python', () => {
    const mockExec = () => 'Python 3.12.0\n';
    const issue = checkPythonVersion(mockExec);
    assert.equal(issue, null);
  });
});

describe('handleDeps', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns ok with outdated packages', () => {
    const mockExec = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'outdated') {
        const err = new Error('exit code 1');
        err.stdout = JSON.stringify({
          chalk: { current: '4.1.0', wanted: '4.1.2', latest: '5.3.0', location: '' }
        });
        throw err;
      }
      if (cmd === 'node') return 'v22.0.0\n';
      if (cmd === 'npm' && args[0] === 'audit') return JSON.stringify({ vulnerabilities: {} });
      return '';
    };

    const result = handleDeps(
      { type: 'deps', label: 'Dependencies' },
      { execFn: mockExec, basePath: tmpDir }
    );

    assert.equal(result.status, 'ok');
    assert.ok(result.issues.length >= 1);
    assert.equal(result.issues[0].issue_type, 'deps');
  });

  it('skips audit when skip_audit is true', () => {
    let auditCalled = false;
    const mockExec = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'audit') { auditCalled = true; return '{}'; }
      if (cmd === 'npm' && args[0] === 'outdated') return '{}';
      if (cmd === 'node') return 'v22.0.0\n';
      return '';
    };

    handleDeps(
      { type: 'deps', label: 'Dependencies', skip_audit: true },
      { execFn: mockExec, basePath: tmpDir }
    );

    assert.equal(auditCalled, false);
  });

  it('returns empty issues for unknown ecosystem', () => {
    const emptyDir = makeTmpDir();
    const result = handleDeps(
      { type: 'deps', label: 'Deps' },
      { basePath: emptyDir }
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 0);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('respects configured ecosystems override', () => {
    let pipCalled = false;
    const mockExec = (cmd) => {
      if (cmd === 'pip') { pipCalled = true; return '[]'; }
      if (cmd === 'python3') return 'Python 3.12.0\n';
      return '';
    };

    handleDeps(
      { type: 'deps', label: 'Deps', ecosystems: ['python'] },
      { execFn: mockExec, basePath: tmpDir }
    );

    assert.equal(pipCalled, true);
  });
});

describe('handleDeps adversarial args', () => {
  it('does not throw when options is omitted', () => {
    let result;
    assert.doesNotThrow(() => {
      // ecosystems:[] short-circuits before any exec, so no real npm runs
      result = handleDeps({ type: 'deps', label: 'D', ecosystems: [] });
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.source_type, 'deps');
    assert.deepEqual(result.issues, []);
  });

  it('does not throw when sourceConfig is null', () => {
    const empty = makeTmpDir();
    let result;
    assert.doesNotThrow(() => {
      result = handleDeps(null, { basePath: empty, execFn: () => '' });
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.source_label, 'Dependencies');
    assert.deepEqual(result.issues, []);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
