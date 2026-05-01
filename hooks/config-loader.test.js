#!/usr/bin/env node
// hooks/config-loader.test.js
// TDD test suite for hooks/config-loader.js
// Uses node:test + node:assert/strict
// Tests write temp config files to os.tmpdir() — cleaned up in finally blocks.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// We test via the module under test
const { loadConfig, DEFAULT_CONFIG, shouldRunHook, HOOK_PROFILE_MAP, validateHookInput, HOOK_INPUT_SCHEMAS, DEFAULT_HOOK_PRIORITIES } = require('./config-loader');

// Helper: write a JSON file to a temp directory
function writeTempConfig(dir, content) {
  const configDir = path.join(dir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'nf.json'), content, 'utf8');
}

// TC1: Project dir missing config, no project-level file exists.
// NOTE: The global ~/.claude/nf.json may or may not exist on the test machine.
// This test verifies: (a) loadConfig() returns a valid config object, (b) no stdout written,
// (c) if global is absent too, a WARNING is emitted.
// We use a fresh temp dir with no .claude/ subdirectory as the project dir.
// @requirement CONF-01
test('TC1: no project config → returns valid config (from global or DEFAULT_CONFIG)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc1-'));
  const stdoutChunks = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(chunk);
    return origStdout(chunk, ...args);
  };
  try {
    // No .claude/nf.json in tmpDir — project layer absent
    const config = loadConfig(tmpDir);
    // Must be a valid config with required shape regardless of global presence
    assert.ok(typeof config === 'object' && config !== null, 'config must be an object');
    assert.ok(Array.isArray(config.quorum_commands), 'quorum_commands must be array');
    assert.ok(typeof config.required_models === 'object' && config.required_models !== null, 'required_models must be object');
    assert.ok(['open', 'closed'].includes(config.fail_mode), 'fail_mode must be valid');
    // Stdout must remain clean
    assert.equal(stdoutChunks.length, 0, 'stdout must remain empty');
  } finally {
    process.stdout.write = origStdout;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC2: Global only, valid — returns DEFAULT_CONFIG merged with global
test('TC2: global config only (valid) → merged over DEFAULT_CONFIG', async (t) => {
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc2g-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc2p-'));
  // Write a global config. We can't easily redirect the global path,
  // so this TC tests project-only (same merge path when global is absent).
  // The global path is always ~/.claude/nf.json — we test through projectDir override.
  // TC2 tests project config only scenario, which covers the { ...DEFAULT_CONFIG, ...project } path.
  try {
    writeTempConfig(projectDir, JSON.stringify({ quorum_commands: ['custom-cmd'], fail_mode: 'open', required_models: DEFAULT_CONFIG.required_models }));
    const config = loadConfig(projectDir);
    assert.ok(Array.isArray(config.quorum_commands));
    assert.ok(config.quorum_commands.includes('custom-cmd'));
    assert.equal(config.fail_mode, 'open');
  } finally {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC3: Project config with fail_mode: 'closed' overrides global/default
test('TC3: project config overrides fail_mode', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc3-'));
  try {
    writeTempConfig(projectDir, JSON.stringify({ fail_mode: 'closed' }));
    const config = loadConfig(projectDir);
    assert.equal(config.fail_mode, 'closed');
    // Other keys should still exist (from DEFAULT_CONFIG)
    assert.ok(Array.isArray(config.quorum_commands));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC4: Malformed project config — warns on stderr, falls back for that layer
test('TC4: malformed project config → stderr warning, uses DEFAULT_CONFIG for that layer', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc4-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, '{ invalid json :');
    const config = loadConfig(projectDir);
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should emit a WARNING on stderr');
    // Config should still be a valid object with DEFAULT_CONFIG keys
    assert.ok(Array.isArray(config.quorum_commands));
    assert.ok(config.required_models);
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC5: validateConfig — invalid quorum_commands (string, not array) → corrected to DEFAULT
test('TC5: validateConfig corrects quorum_commands: string → DEFAULT array', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc5-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ quorum_commands: 'not-an-array' }));
    const config = loadConfig(projectDir);
    assert.ok(Array.isArray(config.quorum_commands), 'quorum_commands should be corrected to array');
    assert.deepEqual(config.quorum_commands, DEFAULT_CONFIG.quorum_commands);
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should warn about invalid quorum_commands');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC6: validateConfig — invalid required_models (not an object) → corrected to DEFAULT
test('TC6: validateConfig corrects required_models: null → DEFAULT object', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc6-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ required_models: null }));
    const config = loadConfig(projectDir);
    assert.ok(config.required_models !== null);
    assert.equal(typeof config.required_models, 'object');
    assert.deepEqual(config.required_models, DEFAULT_CONFIG.required_models);
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should warn about invalid required_models');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC7: validateConfig — invalid fail_mode → corrected to 'open'
test('TC7: validateConfig corrects invalid fail_mode → "open"', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc7-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ fail_mode: 'invalid-value' }));
    const config = loadConfig(projectDir);
    assert.equal(config.fail_mode, 'open');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should warn about invalid fail_mode');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC8: No stdout output from any loadConfig() call
test('TC8: loadConfig() never writes to stdout', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc8-'));
  const stdoutChunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    // Test multiple scenarios
    loadConfig(projectDir); // no files

    writeTempConfig(projectDir, '{ bad json');
    loadConfig(projectDir); // malformed

    writeTempConfig(projectDir, JSON.stringify({ quorum_commands: 'bad', fail_mode: 'bad', required_models: null }));
    loadConfig(projectDir); // validation failures

    assert.equal(stdoutChunks.length, 0, 'stdout must remain empty across all scenarios');
  } finally {
    process.stdout.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC9: DEFAULT_CONFIG exported and has expected shape
test('TC9: DEFAULT_CONFIG exported and has correct shape', async (t) => {
  assert.ok(DEFAULT_CONFIG, 'DEFAULT_CONFIG must be exported');
  assert.ok(Array.isArray(DEFAULT_CONFIG.quorum_commands), 'quorum_commands must be array');
  assert.ok(DEFAULT_CONFIG.quorum_commands.includes('quick'), 'quorum_commands must include "quick"');
  assert.equal(DEFAULT_CONFIG.fail_mode, 'open');
  assert.ok(typeof DEFAULT_CONFIG.required_models === 'object' && DEFAULT_CONFIG.required_models !== null);
  assert.ok(DEFAULT_CONFIG.required_models.codex);
  assert.ok(DEFAULT_CONFIG.required_models.gemini);
  assert.ok(DEFAULT_CONFIG.required_models.opencode);
  assert.ok(DEFAULT_CONFIG.required_models.copilot, 'required_models must include copilot');
  assert.strictEqual(DEFAULT_CONFIG.required_models.copilot.tool_prefix, 'mcp__copilot-cli__', 'copilot tool_prefix must be mcp__copilot-cli__');
  assert.ok(DEFAULT_CONFIG.required_models.codex.tool_prefix.startsWith('mcp__'));
});

// TC10: Shallow merge — project required_models replaces global entirely
test('TC10: shallow merge — project required_models replaces DEFAULT_CONFIG.required_models', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc10-'));
  try {
    const customModels = { custom: { tool_prefix: 'mcp__custom__', required: true } };
    writeTempConfig(projectDir, JSON.stringify({ required_models: customModels }));
    const config = loadConfig(projectDir);
    // Project required_models should completely replace DEFAULT_CONFIG.required_models
    assert.deepEqual(config.required_models, customModels);
    // Should NOT have codex/gemini/opencode from DEFAULT
    assert.equal(config.required_models.codex, undefined);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB1: DEFAULT_CONFIG.circuit_breaker exists with oscillation_depth=3, commit_window=6
test('TC-CB1: DEFAULT_CONFIG.circuit_breaker has correct defaults', async (t) => {
  assert.ok(DEFAULT_CONFIG.circuit_breaker, 'DEFAULT_CONFIG.circuit_breaker must exist');
  assert.equal(DEFAULT_CONFIG.circuit_breaker.oscillation_depth, 3, 'oscillation_depth must be 3');
  assert.equal(DEFAULT_CONFIG.circuit_breaker.commit_window, 6, 'commit_window must be 6');
});

// TC-CB2: Valid circuit_breaker in project config (oscillation_depth=5, commit_window=8) → values used as-is
test('TC-CB2: valid project circuit_breaker overrides defaults', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb2-'));
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: { oscillation_depth: 5, commit_window: 8 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.circuit_breaker.oscillation_depth, 5, 'oscillation_depth should be 5');
    assert.equal(config.circuit_breaker.commit_window, 8, 'commit_window should be 8');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB3: circuit_breaker.oscillation_depth is string 'not-a-number' → falls back to 3, stderr WARNING
test('TC-CB3: invalid oscillation_depth string falls back to 3 with stderr warning', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb3-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: { oscillation_depth: 'not-a-number', commit_window: 6 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.circuit_breaker.oscillation_depth, 3, 'oscillation_depth should fall back to 3');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should emit WARNING on stderr');
    assert.ok(stderrOutput.includes('oscillation_depth'), 'warning should mention oscillation_depth');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB4: circuit_breaker.commit_window is -1 (negative integer) → falls back to 6, stderr WARNING
test('TC-CB4: negative commit_window falls back to 6 with stderr warning', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb4-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: { oscillation_depth: 3, commit_window: -1 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.circuit_breaker.commit_window, 6, 'commit_window should fall back to 6');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should emit WARNING on stderr');
    assert.ok(stderrOutput.includes('commit_window'), 'warning should mention commit_window');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB5: circuit_breaker is null → entire block falls back to defaults, stderr WARNING
test('TC-CB5: null circuit_breaker falls back to full defaults with stderr warning', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb5-'));
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: null }));
    const config = loadConfig(projectDir);
    assert.equal(config.circuit_breaker.oscillation_depth, 3, 'oscillation_depth should be default 3');
    assert.equal(config.circuit_breaker.commit_window, 6, 'commit_window should be default 6');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING:'), 'should emit WARNING on stderr');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB6: circuit_breaker has only oscillation_depth=5 (missing commit_window) →
// oscillation_depth=5 used, commit_window=6 (validateConfig fills in missing sub-key)
test('TC-CB6: partial circuit_breaker with only oscillation_depth uses default commit_window', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb6-'));
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: { oscillation_depth: 5 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.circuit_breaker.oscillation_depth, 5, 'oscillation_depth should be 5 as specified');
    assert.equal(config.circuit_breaker.commit_window, 6, 'commit_window should default to 6 when missing');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB7: loadConfig() with invalid circuit_breaker writes nothing to stdout
test('TC-CB7: loadConfig() with invalid circuit_breaker writes nothing to stdout', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb7-'));
  const stdoutChunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(chunk);
    return origWrite(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: null }));
    loadConfig(projectDir);
    assert.equal(stdoutChunks.length, 0, 'stdout must remain empty with invalid circuit_breaker');
  } finally {
    process.stdout.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TIER-TC1: No config → defaults are model_tier_planner='opus' and model_tier_worker='haiku'
test('TIER-TC1: no config → DEFAULT_CONFIG has model_tier_planner=opus and model_tier_worker=haiku', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tier-tc1-'));
  try {
    // No .claude/nf.json written — use temp dir with no config
    const config = loadConfig(projectDir);
    assert.equal(config.model_tier_planner, 'opus', 'model_tier_planner should default to opus');
    assert.equal(config.model_tier_worker, 'haiku', 'model_tier_worker should default to haiku');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TIER-TC2: Valid model_tier_planner override → preserved as-is
test('TIER-TC2: valid model_tier_planner: sonnet → preserved in config', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tier-tc2-'));
  try {
    writeTempConfig(projectDir, JSON.stringify({ model_tier_planner: 'sonnet' }));
    const config = loadConfig(projectDir);
    assert.equal(config.model_tier_planner, 'sonnet', 'valid model_tier_planner override should be preserved');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TIER-TC3: Invalid model_tier_planner: 'gpt-4' → deleted + stderr WARNING
test('TIER-TC3: invalid model_tier_planner: gpt-4 → deleted + stderr WARNING', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tier-tc3-'));
  const stderrChunks = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origStderr(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ model_tier_planner: 'gpt-4' }));
    const config = loadConfig(projectDir);
    assert.equal(config.model_tier_planner, undefined, 'invalid model_tier_planner should be deleted');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING'), 'should emit a WARNING to stderr');
    assert.ok(stderrOutput.includes('model_tier_planner'), 'WARNING should mention model_tier_planner');
  } finally {
    process.stderr.write = origStderr;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TIER-TC4: Invalid model_tier_worker: 42 (non-string) → deleted + stderr WARNING
test('TIER-TC4: invalid model_tier_worker: 42 (non-string) → deleted + stderr WARNING', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tier-tc4-'));
  const stderrChunks = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origStderr(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ model_tier_worker: 42 }));
    const config = loadConfig(projectDir);
    assert.equal(config.model_tier_worker, undefined, 'invalid model_tier_worker (non-string) should be deleted');
    const stderrOutput = stderrChunks.join('');
    assert.ok(stderrOutput.includes('[nf] WARNING'), 'should emit a WARNING to stderr');
    assert.ok(stderrOutput.includes('model_tier_worker'), 'WARNING should mention model_tier_worker');
  } finally {
    process.stderr.write = origStderr;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CB8: Both sub-keys invalid simultaneously (oscillation_depth='bad', commit_window=-1) →
// each falls back independently (3 and 6), two WARNINGs on stderr, stdout stays empty
test('TC-CB8: both circuit_breaker sub-keys invalid → each falls back independently, two warnings, no stdout', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-tc-cb8-'));
  const stderrChunks = [];
  const stdoutChunks = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  const origStdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(chunk);
    return origStderr(chunk, ...args);
  };
  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(chunk);
    return origStdout(chunk, ...args);
  };
  try {
    writeTempConfig(projectDir, JSON.stringify({ circuit_breaker: { oscillation_depth: 'bad', commit_window: -1 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.circuit_breaker.oscillation_depth, 3, 'oscillation_depth should fall back to 3');
    assert.equal(config.circuit_breaker.commit_window, 6, 'commit_window should fall back to 6');
    const stderrOutput = stderrChunks.join('');
    // Two separate warnings should be emitted
    const warningMatches = (stderrOutput.match(/\[nf\] WARNING:/g) || []);
    assert.ok(warningMatches.length >= 2, 'should emit at least 2 warnings (one per invalid sub-key)');
    assert.equal(stdoutChunks.length, 0, 'stdout must remain empty');
  } finally {
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ENV-TC1: No config → task_envelope_enabled defaults to true
test('ENV-TC1: no config → task_envelope_enabled defaults to true', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-env-tc1-'));
  try {
    const config = loadConfig(projectDir);
    assert.equal(config.task_envelope_enabled, true, 'task_envelope_enabled should default to true');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ENV-TC2: task_envelope_enabled: false → preserved
test('ENV-TC2: task_envelope_enabled: false → preserved in config', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-env-tc2-'));
  try {
    writeTempConfig(projectDir, JSON.stringify({ task_envelope_enabled: false }));
    const config = loadConfig(projectDir);
    assert.equal(config.task_envelope_enabled, false, 'task_envelope_enabled: false should be preserved');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ENV-TC3: task_envelope_enabled: 'yes' (non-boolean) → defaults to true + stderr WARNING
test('ENV-TC3: task_envelope_enabled: yes (non-boolean) → defaults to true + stderr WARNING', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-env-tc3-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ task_envelope_enabled: 'yes' }));
    const config = loadConfig(projectDir);
    assert.equal(config.task_envelope_enabled, true, 'invalid task_envelope_enabled should default to true');
    assert.ok(stderrOutput.includes('task_envelope_enabled'), 'WARNING should mention task_envelope_enabled');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Hook Profile Tests
// ============================================================================

// PROF-TC1: Valid profiles accepted without warning
test('PROF-TC1: valid hook_profile values accepted without warning', async (t) => {
  for (const profile of ['minimal', 'standard', 'strict']) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prof-tc1-'));
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk);
      return origWrite(chunk, ...args);
    };
    try {
      writeTempConfig(projectDir, JSON.stringify({ hook_profile: profile }));
      const config = loadConfig(projectDir);
      assert.equal(config.hook_profile, profile, `hook_profile '${profile}' should be accepted`);
      const stderrOutput = stderrChunks.join('');
      assert.ok(!stderrOutput.includes('hook_profile'), `no warning for valid profile '${profile}'`);
    } finally {
      process.stderr.write = origWrite;
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }
});

// PROF-TC2: Invalid string profile corrected to 'standard' with warning
test('PROF-TC2: invalid hook_profile string corrected to standard with warning', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prof-tc2-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_profile: 'turbo' }));
    const config = loadConfig(projectDir);
    assert.equal(config.hook_profile, 'standard', 'invalid profile should fall back to standard');
    assert.ok(stderrOutput.includes('hook_profile'), 'WARNING should mention hook_profile');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PROF-TC3: Non-string profile (number) corrected to 'standard' with warning
test('PROF-TC3: non-string hook_profile (42) corrected to standard with warning', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prof-tc3-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_profile: 42 }));
    const config = loadConfig(projectDir);
    assert.equal(config.hook_profile, 'standard', 'non-string profile should fall back to standard');
    assert.ok(stderrOutput.includes('hook_profile'), 'WARNING should mention hook_profile');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PROF-TC4: Missing hook_profile defaults to 'standard' via DEFAULT_CONFIG
test('PROF-TC4: missing hook_profile defaults to standard via DEFAULT_CONFIG', async (t) => {
  assert.equal(DEFAULT_CONFIG.hook_profile, 'standard', 'DEFAULT_CONFIG.hook_profile must be standard');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prof-tc4-'));
  try {
    const config = loadConfig(projectDir);
    assert.equal(config.hook_profile, 'standard', 'missing hook_profile should default to standard');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ============================================================================
// shouldRunHook() Tests
// ============================================================================

// SRH-TC1: circuit-breaker active in minimal
test('SRH-TC1: shouldRunHook nf-circuit-breaker in minimal returns true', async (t) => {
  assert.equal(shouldRunHook('nf-circuit-breaker', 'minimal'), true);
});

// SRH-TC2: precompact active in minimal
test('SRH-TC2: shouldRunHook nf-precompact in minimal returns true', async (t) => {
  assert.equal(shouldRunHook('nf-precompact', 'minimal'), true);
});

// SRH-TC3: nf-prompt disabled in minimal
test('SRH-TC3: shouldRunHook nf-prompt in minimal returns false', async (t) => {
  assert.equal(shouldRunHook('nf-prompt', 'minimal'), false);
});

// SRH-TC4: nf-stop disabled in minimal
test('SRH-TC4: shouldRunHook nf-stop in minimal returns false', async (t) => {
  assert.equal(shouldRunHook('nf-stop', 'minimal'), false);
});

// SRH-TC5: nf-prompt active in standard
test('SRH-TC5: shouldRunHook nf-prompt in standard returns true', async (t) => {
  assert.equal(shouldRunHook('nf-prompt', 'standard'), true);
});

// SRH-TC6: nf-stop active in standard
test('SRH-TC6: shouldRunHook nf-stop in standard returns true', async (t) => {
  assert.equal(shouldRunHook('nf-stop', 'standard'), true);
});

// SRH-TC7: nf-prompt active in strict
test('SRH-TC7: shouldRunHook nf-prompt in strict returns true', async (t) => {
  assert.equal(shouldRunHook('nf-prompt', 'strict'), true);
});

// SRH-TC8: circuit-breaker active in strict
test('SRH-TC8: shouldRunHook nf-circuit-breaker in strict returns true', async (t) => {
  assert.equal(shouldRunHook('nf-circuit-breaker', 'strict'), true);
});

// SRH-TC9: unknown profile falls back to standard
test('SRH-TC9: shouldRunHook with unknown profile falls back to standard', async (t) => {
  assert.equal(shouldRunHook('nf-prompt', 'turbo'), true, 'unknown profile should behave like standard');
});

// ============================================================================
// HOOK_PROFILE_MAP Structure Tests
// ============================================================================

// HPM-TC1: All three profiles exist
test('HPM-TC1: HOOK_PROFILE_MAP has all three profiles', async (t) => {
  assert.ok(HOOK_PROFILE_MAP.minimal, 'minimal profile must exist');
  assert.ok(HOOK_PROFILE_MAP.standard, 'standard profile must exist');
  assert.ok(HOOK_PROFILE_MAP.strict, 'strict profile must exist');
});

// HPM-TC2: minimal has exactly 4 entries (added nf-node-eval-guard for zsh safety)
test('HPM-TC2: minimal profile has exactly 4 hooks', async (t) => {
  assert.equal(HOOK_PROFILE_MAP.minimal.size, 4, 'minimal must have 4 hooks');
});

// HPM-TC3: standard has 18 entries (added nf-slot-health-probe for quorum slot statusline)
test('HPM-TC3: standard profile has 18 hooks', async (t) => {
  assert.equal(HOOK_PROFILE_MAP.standard.size, 18, 'standard must have 18 hooks');
});

// HPM-TC4: strict has 18 entries (same as standard)
test('HPM-TC4: strict profile has 18 hooks (same as standard)', async (t) => {
  assert.equal(HOOK_PROFILE_MAP.strict.size, 18, 'strict must have 18 hooks');
});

// HPM-TC5: circuit-breaker in ALL profiles (MonitoringReachable invariant)
test('HPM-TC5: nf-circuit-breaker is in all three profiles', async (t) => {
  assert.ok(HOOK_PROFILE_MAP.minimal.has('nf-circuit-breaker'), 'minimal must include circuit-breaker');
  assert.ok(HOOK_PROFILE_MAP.standard.has('nf-circuit-breaker'), 'standard must include circuit-breaker');
  assert.ok(HOOK_PROFILE_MAP.strict.has('nf-circuit-breaker'), 'strict must include circuit-breaker');
});

// HPM-TC6: nf-node-eval-guard in ALL profiles (zsh safety — must be universal)
test('HPM-TC6: nf-node-eval-guard is in all three profiles', async (t) => {
  assert.ok(HOOK_PROFILE_MAP.minimal.has('nf-node-eval-guard'), 'minimal must include node-eval-guard');
  assert.ok(HOOK_PROFILE_MAP.standard.has('nf-node-eval-guard'), 'standard must include node-eval-guard');
  assert.ok(HOOK_PROFILE_MAP.strict.has('nf-node-eval-guard'), 'strict must include node-eval-guard');
});

// ============================================================================
// validateHookInput Tests
// ============================================================================

// VHI-TC1: validates PreToolUse with valid input
test('VHI-TC1: validates PreToolUse with valid input', async (t) => {
  const result = validateHookInput('PreToolUse', { tool_name: 'Bash', cwd: '/tmp' });
  assert.equal(result.valid, true, 'valid PreToolUse input should pass');
});

// VHI-TC2: rejects PreToolUse with missing tool_name
test('VHI-TC2: rejects PreToolUse with missing tool_name', async (t) => {
  const result = validateHookInput('PreToolUse', {});
  assert.equal(result.valid, false, 'missing tool_name should fail');
  assert.ok(result.errors.some(e => e.field === 'tool_name' && e.error === 'missing'), 'should report tool_name as missing');
});

// VHI-TC3: rejects PreToolUse with wrong type tool_name
test('VHI-TC3: rejects PreToolUse with wrong type tool_name', async (t) => {
  const result = validateHookInput('PreToolUse', { tool_name: 123 });
  assert.equal(result.valid, false, 'wrong type tool_name should fail');
  assert.ok(result.errors.some(e => e.field === 'tool_name' && e.error === 'wrong_type'), 'should report wrong_type for tool_name');
});

// VHI-TC4: validates UserPromptSubmit with valid input
test('VHI-TC4: validates UserPromptSubmit with valid input', async (t) => {
  const result = validateHookInput('UserPromptSubmit', { prompt: 'hello' });
  assert.equal(result.valid, true, 'valid UserPromptSubmit input should pass');
});

// VHI-TC5: rejects UserPromptSubmit with missing prompt
test('VHI-TC5: rejects UserPromptSubmit with missing prompt', async (t) => {
  const result = validateHookInput('UserPromptSubmit', {});
  assert.equal(result.valid, false, 'missing prompt should fail');
  assert.ok(result.errors.some(e => e.field === 'prompt' && e.error === 'missing'), 'should report prompt as missing');
});

// VHI-TC6: validates PostToolUse with valid input
test('VHI-TC6: validates PostToolUse with valid input', async (t) => {
  const result = validateHookInput('PostToolUse', { tool_name: 'Read', tool_response: {} });
  assert.equal(result.valid, true, 'valid PostToolUse input should pass');
});

// VHI-TC7: validates Stop with minimal input (no required fields)
test('VHI-TC7: validates Stop with minimal input', async (t) => {
  const result = validateHookInput('Stop', {});
  assert.equal(result.valid, true, 'Stop with no fields should pass (no required fields)');
});

// VHI-TC8: validates Stop with wrong type optional field
test('VHI-TC8: validates Stop with wrong type optional field', async (t) => {
  const result = validateHookInput('Stop', { stop_hook_active: 'yes' });
  assert.equal(result.valid, false, 'wrong type stop_hook_active should fail');
  assert.ok(result.errors.some(e => e.field === 'stop_hook_active' && e.error === 'wrong_type'), 'should report wrong_type for stop_hook_active');
});

// VHI-TC9: returns valid for unknown event type (fail-open)
test('VHI-TC9: returns valid for unknown event type', async (t) => {
  const result = validateHookInput('FutureEvent', {});
  assert.equal(result.valid, true, 'unknown event type should pass (fail-open)');
});

// VHI-TC10: returns invalid for null input
test('VHI-TC10: returns invalid for null input', async (t) => {
  const result = validateHookInput('PreToolUse', null);
  assert.equal(result.valid, false, 'null input should fail');
  assert.ok(result.errors.some(e => e.field === '(root)' && e.error === 'not_object'), 'should report not_object');
});

// VHI-TC11: returns invalid for non-object input
test('VHI-TC11: returns invalid for non-object input', async (t) => {
  const result = validateHookInput('PreToolUse', 'string');
  assert.equal(result.valid, false, 'string input should fail');
  assert.ok(result.errors.some(e => e.error === 'not_object'), 'should report not_object');
});

// VHI-TC12: ignores null/undefined optional fields
test('VHI-TC12: ignores null/undefined optional fields', async (t) => {
  const result = validateHookInput('PostToolUse', { tool_name: 'Bash', tool_response: null });
  assert.equal(result.valid, true, 'null optional field should be ignored');
});

// VHI-TC13: HOOK_INPUT_SCHEMAS exported and has expected event types
test('VHI-TC13: HOOK_INPUT_SCHEMAS exported and has expected event types', async (t) => {
  assert.ok(HOOK_INPUT_SCHEMAS, 'HOOK_INPUT_SCHEMAS must be exported');
  assert.ok(HOOK_INPUT_SCHEMAS.PreToolUse, 'must have PreToolUse schema');
  assert.ok(HOOK_INPUT_SCHEMAS.PostToolUse, 'must have PostToolUse schema');
  assert.ok(HOOK_INPUT_SCHEMAS.UserPromptSubmit, 'must have UserPromptSubmit schema');
  assert.ok(HOOK_INPUT_SCHEMAS.Stop, 'must have Stop schema');
  assert.ok(HOOK_INPUT_SCHEMAS.SubagentStop, 'must have SubagentStop schema');
  assert.ok(HOOK_INPUT_SCHEMAS.PreCompact, 'must have PreCompact schema');
  assert.ok(HOOK_INPUT_SCHEMAS.SessionStart, 'must have SessionStart schema');
  assert.ok(HOOK_INPUT_SCHEMAS.SessionEnd, 'must have SessionEnd schema');
});

// ============================================================================
// Hook Priorities Tests
// ============================================================================

// PRIO-TC1: DEFAULT_HOOK_PRIORITIES exports correct structure
test('PRIO-TC1: DEFAULT_HOOK_PRIORITIES exports correct structure', async (t) => {
  assert.ok(DEFAULT_HOOK_PRIORITIES, 'DEFAULT_HOOK_PRIORITIES must be exported');
  assert.equal(typeof DEFAULT_HOOK_PRIORITIES, 'object', 'must be an object');
  assert.equal(DEFAULT_HOOK_PRIORITIES['nf-circuit-breaker'], 1000, 'circuit-breaker must be 1000');
  assert.equal(DEFAULT_HOOK_PRIORITIES['nf-stop'], 1000, 'nf-stop must be 1000');
  assert.equal(DEFAULT_HOOK_PRIORITIES['nf-prompt'], 50, 'nf-prompt must be 50');
  assert.equal(DEFAULT_HOOK_PRIORITIES['nf-check-update'], 10, 'nf-check-update must be 10');
});

// PRIO-TC2: loadConfig includes hook_priorities from DEFAULT_CONFIG
test('PRIO-TC2: loadConfig includes hook_priorities from DEFAULT_CONFIG', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prio-tc2-'));
  try {
    const config = loadConfig(projectDir);
    assert.ok(typeof config.hook_priorities === 'object', 'hook_priorities must be an object');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PRIO-TC3: validateConfig accepts valid hook_priorities
test('PRIO-TC3: validateConfig accepts valid hook_priorities', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prio-tc3-'));
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_priorities: { 'nf-prompt': 100 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.hook_priorities['nf-prompt'], 100, 'valid override should be preserved');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PRIO-TC4: validateConfig rejects non-integer priorities
test('PRIO-TC4: validateConfig rejects non-integer priorities', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prio-tc4-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_priorities: { 'nf-prompt': 'high' } }));
    const config = loadConfig(projectDir);
    assert.equal(config.hook_priorities['nf-prompt'], undefined, 'non-integer priority should be removed');
    assert.ok(stderrOutput.includes('hook_priorities.nf-prompt'), 'warning should mention the key');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PRIO-TC5: validateConfig rejects negative priorities
test('PRIO-TC5: validateConfig rejects negative priorities', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prio-tc5-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_priorities: { 'nf-prompt': -1 } }));
    const config = loadConfig(projectDir);
    assert.equal(config.hook_priorities['nf-prompt'], undefined, 'negative priority should be removed');
    assert.ok(stderrOutput.includes('hook_priorities.nf-prompt'), 'warning should mention the key');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PRIO-TC6: validateConfig rejects array hook_priorities
test('PRIO-TC6: validateConfig rejects array hook_priorities', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prio-tc6-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_priorities: [1, 2] }));
    const config = loadConfig(projectDir);
    assert.deepEqual(config.hook_priorities, {}, 'array hook_priorities should be reset to {}');
    assert.ok(stderrOutput.includes('hook_priorities'), 'warning should mention hook_priorities');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// PRIO-TC7: validateConfig rejects null hook_priorities
test('PRIO-TC7: validateConfig rejects null hook_priorities', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-prio-tc7-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    writeTempConfig(projectDir, JSON.stringify({ hook_priorities: null }));
    const config = loadConfig(projectDir);
    assert.deepEqual(config.hook_priorities, {}, 'null hook_priorities should be reset to {}');
    assert.ok(stderrOutput.includes('hook_priorities'), 'warning should mention hook_priorities');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// TC-CRE: context_retrieval_enabled defaults to true when not specified in any config file
test('TC-CRE: context_retrieval_enabled defaults to true when no config file present', async (t) => {
  const tmpDir = path.join(os.tmpdir(), 'nf-test-cre-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const config = loadConfig(tmpDir);
    assert.strictEqual(config.context_retrieval_enabled, true, 'context_retrieval_enabled must default to true');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ADVERSARIAL: quorum.maxSize is validated as positive integer but NOT checked against agent count
// If quorum.maxSize=10 but quorum_active only has 3 slots, the quorum can NEVER be satisfied.
// This is a design flaw: maxSize validation only checks ">= 1", not against available slots.
test('ADVERSARIAL: quorum.maxSize exceeding quorum_active count is not validated — no warning emitted', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-adv-minmax-'));
  let stderrOutput = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (msg) => { stderrOutput += msg; return true; };
  try {
    // maxSize=10 but only 3 slots in quorum_active — quorum can never be satisfied
    writeTempConfig(projectDir, JSON.stringify({
      quorum_active: ['codex-1', 'gemini-1', 'opencode-1'],
      quorum: { maxSize: 10 }
    }));
    const config = loadConfig(projectDir);
    // Validation only checks maxSize >= 1, NOT maxSize <= quorum_active.length
    assert.strictEqual(config.quorum.maxSize, 10, 'maxSize=10 should be accepted (no upper bound check)');
    // No warning should be emitted about the unsatisfiable quorum
    assert.ok(!stderrOutput.includes('quorum.maxSize'), 'no warning about maxSize exceeding agent count');
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
