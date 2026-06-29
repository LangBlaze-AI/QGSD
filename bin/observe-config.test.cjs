const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadObserveConfig, parseSimpleYaml, parseYamlValue } = require('./observe-config.cjs');

// Helper: create a temp directory with config files
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observe-config-test-'));
}

function writeConfig(dir, filename, content) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, filename), content, 'utf8');
}

describe('parseYamlValue', () => {
  it('parses booleans', () => {
    assert.equal(parseYamlValue('true'), true);
    assert.equal(parseYamlValue('false'), false);
  });

  it('parses numbers', () => {
    assert.equal(parseYamlValue('10'), 10);
    assert.equal(parseYamlValue('3.14'), 3.14);
  });

  it('parses null', () => {
    assert.equal(parseYamlValue('null'), null);
    assert.equal(parseYamlValue('~'), null);
  });

  it('parses inline arrays', () => {
    assert.deepEqual(parseYamlValue('[bug, regression]'), ['bug', 'regression']);
    assert.deepEqual(parseYamlValue('[]'), []);
  });

  it('parses quoted strings', () => {
    assert.equal(parseYamlValue('"GitHub Issues"'), 'GitHub Issues');
    assert.equal(parseYamlValue("'hello'"), 'hello');
  });

  it('parses plain strings', () => {
    assert.equal(parseYamlValue('open'), 'open');
  });
});

describe('parseSimpleYaml', () => {
  it('parses top-level key-value pairs', () => {
    const result = parseSimpleYaml('name: test\ncount: 5');
    assert.equal(result.name, 'test');
    assert.equal(result.count, 5);
  });

  it('parses nested objects', () => {
    const yaml = `observe_config:
  default_timeout: 10
  fail_open_default: true`;
    const result = parseSimpleYaml(yaml);
    assert.equal(result.observe_config.default_timeout, 10);
    assert.equal(result.observe_config.fail_open_default, true);
  });

  it('skips comment-only lines', () => {
    const yaml = `# This is a comment
name: test
# Another comment`;
    const result = parseSimpleYaml(yaml);
    assert.equal(result.name, 'test');
  });
});

describe('loadObserveConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty sources with error when neither file exists', () => {
    const result = loadObserveConfig(null, tmpDir);
    assert.deepEqual(result.sources, []);
    assert.equal(result.configFile, null);
    assert.equal(result.error, 'No observe sources configured');
  });

  it('loads observe-sources.md with valid config', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  default_timeout: 15
  fail_open_default: true

sources:
  - type: github
    label: "GitHub Issues"
    timeout: 8
---

## Observe Sources
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].type, 'github');
    assert.equal(result.sources[0].label, 'GitHub Issues');
    assert.equal(result.sources[0].timeout, 8);
    assert.equal(result.configFile, path.join(tmpDir, '.planning/observe-sources.md'));
    assert.equal(result.error, undefined);
  });

  it('falls back to triage-sources.md when observe-sources.md is missing', () => {
    writeConfig(tmpDir, 'triage-sources.md', `---
sources:
  - type: bash
    label: "TODO scan"
    command: "grep -r TODO src/"
---

## Triage Sources
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].type, 'bash');
    assert.equal(result.configFile, path.join(tmpDir, '.planning/triage-sources.md'));
  });

  it('prefers observe-sources.md over triage-sources.md', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - type: github
    label: "GH"
---
`);
    writeConfig(tmpDir, 'triage-sources.md', `---
sources:
  - type: bash
    label: "Bash"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].type, 'github');
  });

  it('uses explicit configPath when provided', () => {
    const customPath = path.join(tmpDir, 'custom-config.md');
    fs.writeFileSync(customPath, `---
sources:
  - type: sentry
    label: "Sentry"
---
`, 'utf8');
    const result = loadObserveConfig(customPath, tmpDir);
    assert.equal(result.sources[0].type, 'sentry');
    assert.equal(result.configFile, customPath);
  });

  it('infers issue_type for known source types', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - type: github
    label: "GH"
  - type: sentry
    label: "Sentry"
  - type: sentry-feedback
    label: "Feedback"
  - type: bash
    label: "Bash"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].issue_type, 'issue');
    assert.equal(result.sources[1].issue_type, 'issue');
    assert.equal(result.sources[2].issue_type, 'issue');
    assert.equal(result.sources[3].issue_type, 'issue');
  });

  it('infers drift issue_type for drift source types', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - type: prometheus
    label: "Prom"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].issue_type, 'drift');
  });

  it('preserves explicit issue_type', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - type: bash
    label: "Custom"
    issue_type: drift
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].issue_type, 'drift');
  });

  it('applies default timeout from observe_config', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  default_timeout: 20

sources:
  - type: github
    label: "GH"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].timeout, 20);
  });

  it('applies fallback timeout of 10 when no observe_config', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - type: github
    label: "GH"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].timeout, 10);
  });

  it('preserves custom timeout override', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  default_timeout: 20

sources:
  - type: github
    label: "GH"
    timeout: 5
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].timeout, 5);
  });

  it('applies default fail_open from observe_config', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  fail_open_default: false

sources:
  - type: github
    label: "GH"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].fail_open, false);
  });

  it('preserves custom fail_open override', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  fail_open_default: true

sources:
  - type: github
    label: "GH"
    fail_open: false
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.sources[0].fail_open, false);
  });

  it('returns validation errors for sources missing required fields', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - type: github
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.ok(result.error);
    assert.ok(result.error.includes('label required'));
  });

  it('returns validation error for missing type', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - label: "Test"
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.ok(result.error);
    assert.ok(result.error.includes('type required'));
  });

  it('returns error when frontmatter is missing', () => {
    writeConfig(tmpDir, 'observe-sources.md', `No frontmatter here`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.error, 'No YAML frontmatter found in config file');
    assert.deepEqual(result.sources, []);
  });

  it('handles empty sources array', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  default_timeout: 10
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.deepEqual(result.sources, []);
    assert.equal(result.error, undefined);
  });

  it('returns observeConfig with global settings', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
observe_config:
  default_timeout: 15
  fail_open_default: false
sources: []
---
`);
    const result = loadObserveConfig(null, tmpDir);
    assert.equal(result.observeConfig.default_timeout, 15);
    assert.equal(result.observeConfig.fail_open_default, false);
  });

  it('does not crash when a source entry is null or a bare scalar (fail-open)', () => {
    writeConfig(tmpDir, 'observe-sources.md', `---
sources:
  - null
  - github
---
`);
    let result;
    assert.doesNotThrow(() => { result = loadObserveConfig(null, tmpDir); });
    assert.ok(result.error, 'expected a validation error for non-object source entries');
    assert.ok(result.error.includes('sources[0]'));
  });

  it('fails open (no throw) when the config path is a directory', () => {
    const dirPath = path.join(tmpDir, 'config-as-dir');
    fs.mkdirSync(dirPath);
    let result;
    assert.doesNotThrow(() => { result = loadObserveConfig(dirPath, tmpDir); });
    assert.deepEqual(result.sources, []);
    assert.ok(result.error && /read/i.test(result.error));
  });
});
