#!/usr/bin/env node
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { detectProjectIntent } = require('./detect-project-intent.cjs');

/**
 * Create a temporary directory with optional files
 */
function createTempProject(files = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-intent-'));
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return tmpDir;
}

/**
 * Clean up temporary directory
 */
function cleanupTmpDir(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

describe('detectProjectIntent', () => {
  // Test 1: Empty directory -> all false/none, base_profile unknown
  test('1. Empty directory: all false, base_profile unknown, needs confirmation', () => {
    const tmpDir = createTempProject({});
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.base_profile, 'unknown');
      assert.equal(result.suggested.iac, false);
      assert.equal(result.suggested.deploy, 'none');
      assert.equal(result.suggested.sensitive, false);
      assert.equal(result.suggested.oss, false);
      assert.equal(result.suggested.monorepo, false);

      assert.ok(result.needs_confirmation.includes('base_profile'));
      assert.ok(Array.isArray(result.signals));
      assert.ok(Array.isArray(result.needs_confirmation));
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 2: Directory with main.tf -> iac: true, high confidence
  test('2. Directory with terraform files: iac true with high confidence', () => {
    const tmpDir = createTempProject({
      'main.tf': 'resource "aws_instance" "example" {}',
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.iac, true);
      const iacSignal = result.signals.find(s => s.dimension === 'iac');
      assert.ok(iacSignal);
      assert.equal(iacSignal.confidence, 'high');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 3: Directory with LICENSE -> oss: true, high confidence
  test('3. Directory with LICENSE: oss true with high confidence', () => {
    const tmpDir = createTempProject({
      'LICENSE': 'MIT License',
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.oss, true);
      const ossSignal = result.signals.find(s => s.dimension === 'oss');
      assert.ok(ossSignal);
      assert.equal(ossSignal.confidence, 'high');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 4: Directory with Dockerfile -> deploy: docker, high confidence
  test('4. Directory with Dockerfile: deploy docker with high confidence', () => {
    const tmpDir = createTempProject({
      'Dockerfile': 'FROM node:18\nRUN echo "test"',
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.deploy, 'docker');
      const deploySignal = result.signals.find(s => s.dimension === 'deploy');
      assert.ok(deploySignal);
      assert.equal(deploySignal.confidence, 'high');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 5: Directory with pnpm-workspace.yaml -> monorepo: true
  test('5. Directory with pnpm-workspace.yaml: monorepo true', () => {
    const tmpDir = createTempProject({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"',
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.monorepo, true);
      const monoSignal = result.signals.find(s => s.dimension === 'monorepo');
      assert.ok(monoSignal);
      assert.equal(monoSignal.confidence, 'high');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 6: Directory with Next.js in package.json -> base_profile: web
  test('6. Directory with next in dependencies: base_profile web', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'test-web',
        dependencies: { next: '^13.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.base_profile, 'web');
      const profileSignal = result.signals.find(s => s.dimension === 'base_profile');
      assert.ok(profileSignal);
      assert.equal(profileSignal.confidence, 'medium');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 7: Directory with Electron -> base_profile: desktop
  test('7. Directory with electron in devDependencies: base_profile desktop', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'test-desktop',
        devDependencies: { electron: '^24.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.base_profile, 'desktop');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 8: Combined signals merge correctly
  test('8. Combined signals: multiple detections merge correctly', () => {
    const tmpDir = createTempProject({
      'main.tf': 'resource "aws_s3_bucket" "example" {}',
      'LICENSE': 'Apache 2.0',
      'Dockerfile': 'FROM alpine:latest',
      'package.json': JSON.stringify({
        name: 'test-combined',
        dependencies: { vite: '^4.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.base_profile, 'web');
      assert.equal(result.suggested.iac, true);
      assert.equal(result.suggested.deploy, 'docker');
      assert.equal(result.suggested.oss, true);
      assert.ok(result.signals.length >= 4);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 9: Return shape has correct fields and types
  test('9. Return shape has suggested, signals, needs_confirmation with correct types', () => {
    const tmpDir = createTempProject({});
    try {
      const result = detectProjectIntent(tmpDir);

      assert.ok(typeof result === 'object');
      assert.ok(result.suggested);
      assert.ok(Array.isArray(result.signals));
      assert.ok(Array.isArray(result.needs_confirmation));

      // Check suggested fields
      assert.equal(typeof result.suggested.base_profile, 'string');
      assert.equal(typeof result.suggested.iac, 'boolean');
      assert.equal(typeof result.suggested.deploy, 'string');
      assert.equal(typeof result.suggested.sensitive, 'boolean');
      assert.equal(typeof result.suggested.oss, 'boolean');
      assert.equal(typeof result.suggested.monorepo, 'boolean');

      // Check signals array items
      for (const signal of result.signals) {
        assert.equal(typeof signal.dimension, 'string');
        assert.equal(typeof signal.confidence, 'string');
        assert.ok(Array.isArray(signal.evidence));
      }
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Test 10: CLI --json flag produces valid JSON
  test('10. CLI --json --root produces valid JSON output', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'test-cli',
        bin: { 'test-cli': 'bin/index.js' },
      }),
      'LICENSE': 'MIT',
    });
    try {
      // Use execFileSync with proper argument passing
      const output = execFileSync('node', [
        path.resolve(__dirname, './detect-project-intent.cjs'),
        '--root',
        tmpDir,
        '--json',
      ], { encoding: 'utf8' });

      const result = JSON.parse(output);
      assert.ok(result.suggested);
      assert.ok(result.signals);
      assert.ok(result.needs_confirmation);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Adversarial: a test-runner-only project must not be misread as a web app
  test('11. vitest devDependency is not misclassified as base_profile web (substring guard)', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'test-stats',
        devDependencies: { vitest: '^1.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.notEqual(result.suggested.base_profile, 'web');
      assert.equal(result.suggested.base_profile, 'unknown');
      assert.ok(result.needs_confirmation.includes('base_profile'));
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Sanity: a real vite dependency must still be detected after the fix
  test('12. real vite dependency still detected as base_profile web', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'real-web',
        devDependencies: { vite: '^4.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);
      assert.equal(result.suggested.base_profile, 'web');
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Adversarial: 'chi-squared' must not trip the payment-library substring match
  test('13. chi-squared dependency is not flagged sensitive (square substring guard)', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'stats-project',
        dependencies: { 'chi-squared': '^1.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);

      assert.equal(result.suggested.sensitive, false);
      assert.equal(result.signals.find(s => s.dimension === 'sensitive'), undefined);
      assert.ok(!result.needs_confirmation.includes('sensitive'));
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });

  // Sanity: a real square dependency must still be detected after the fix
  test('14. real square dependency still flagged sensitive', () => {
    const tmpDir = createTempProject({
      'package.json': JSON.stringify({
        name: 'shop',
        dependencies: { square: '^30.0.0' },
      }),
    });
    try {
      const result = detectProjectIntent(tmpDir);
      assert.equal(result.suggested.sensitive, true);
    } finally {
      cleanupTmpDir(tmpDir);
    }
  });
});
