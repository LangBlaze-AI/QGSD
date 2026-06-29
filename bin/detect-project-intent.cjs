#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Scan a repository for signals indicating project intent.
 * Returns suggested intent with confidence levels and confirmation needs.
 *
 * @param {string} rootPath - Path to project root
 * @returns {Object} { suggested, signals, needs_confirmation }
 */
function detectProjectIntent(rootPath) {
  const root = rootPath || process.cwd();

  const signals = [];
  const suggested = {
    base_profile: 'unknown',
    iac: false,
    deploy: 'none',
    sensitive: false,
    oss: false,
    monorepo: false,
  };

  // Helper to check if file exists
  const fileExists = (filePath) => {
    try {
      return fs.existsSync(path.join(root, filePath));
    } catch (_) {
      return false;
    }
  };

  // Helper to check if any file matching a pattern exists
  const globExists = (pattern) => {
    try {
      const dir = path.join(root, path.dirname(pattern));
      if (!fs.existsSync(dir)) return false;
      const filename = path.basename(pattern);
      const files = fs.readdirSync(dir);
      const regex = filename.replace(/\*/g, '.*');
      return files.some(f => new RegExp(`^${regex}$`).test(f));
    } catch (_) {
      return false;
    }
  };

  // Helper to read package.json
  const getPackageJson = () => {
    try {
      if (fileExists('package.json')) {
        const content = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
        return JSON.parse(content);
      }
    } catch (_) {}
    return null;
  };

  // ============================================================================
  // base_profile detection
  // ============================================================================

  const pkg = getPackageJson();
  let baseProfileFound = false;

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const depsStr = JSON.stringify(deps);

    // web frameworks
    if (/\b(next|nuxt|vite|gatsby|remix)\b/.test(depsStr)) {
      suggested.base_profile = 'web';
      signals.push({
        dimension: 'base_profile',
        confidence: 'medium',
        evidence: ['Web framework detected in package.json (next/nuxt/vite/gatsby/remix)'],
      });
      baseProfileFound = true;
    }
    // mobile frameworks
    else if (/\b(react-native|expo)\b/.test(depsStr)) {
      suggested.base_profile = 'mobile';
      signals.push({
        dimension: 'base_profile',
        confidence: 'medium',
        evidence: ['Mobile framework detected in package.json (react-native/expo)'],
      });
      baseProfileFound = true;
    }
    // desktop frameworks
    else if (/\b(electron|tauri)\b/.test(depsStr)) {
      suggested.base_profile = 'desktop';
      signals.push({
        dimension: 'base_profile',
        confidence: 'medium',
        evidence: ['Desktop framework detected in package.json (electron/tauri)'],
      });
      baseProfileFound = true;
    }

    // Check for bin field (CLI)
    if (pkg.bin && !baseProfileFound) {
      suggested.base_profile = 'cli';
      signals.push({
        dimension: 'base_profile',
        confidence: 'medium',
        evidence: ['bin field present in package.json'],
      });
      baseProfileFound = true;
    }

    // Check for OpenAPI (API)
    if (!baseProfileFound && (fileExists('openapi.json') || fileExists('openapi.yaml') || fileExists('swagger.json'))) {
      suggested.base_profile = 'api';
      signals.push({
        dimension: 'base_profile',
        confidence: 'medium',
        evidence: ['OpenAPI/Swagger spec found (openapi.json/openapi.yaml/swagger.json)'],
      });
      baseProfileFound = true;
    }
  }

  if (!baseProfileFound) {
    signals.push({
      dimension: 'base_profile',
      confidence: 'low',
      evidence: ['No framework or project markers detected'],
    });
  }

  // ============================================================================
  // IaC detection
  // ============================================================================

  const iacSignals = [];

  if (globExists('*.tf')) {
    iacSignals.push('Terraform files (*.tf) found');
  }
  if (fileExists('terraform/main.tf')) {
    iacSignals.push('terraform/main.tf found');
  }
  if (fileExists('Pulumi.yaml')) {
    iacSignals.push('Pulumi.yaml found');
  }
  if (fileExists('cdk.json')) {
    iacSignals.push('cdk.json (AWS CDK) found');
  }
  if (fileExists('serverless.yml')) {
    iacSignals.push('serverless.yml found');
  }
  if (fileExists('infra/') && fs.statSync(path.join(root, 'infra')).isDirectory()) {
    iacSignals.push('infra/ directory found');
  }

  if (iacSignals.length > 0) {
    suggested.iac = true;
    signals.push({
      dimension: 'iac',
      confidence: 'high',
      evidence: iacSignals,
    });
  }

  // ============================================================================
  // deploy detection
  // ============================================================================

  const deploySignals = [];

  if (fileExists('Dockerfile')) {
    suggested.deploy = 'docker';
    deploySignals.push('Dockerfile found');
  } else if (fileExists('docker-compose.yml')) {
    suggested.deploy = 'docker';
    deploySignals.push('docker-compose.yml found');
  } else if (fileExists('fly.toml')) {
    suggested.deploy = 'fly';
    deploySignals.push('fly.toml found');
  } else if (fileExists('vercel.json')) {
    suggested.deploy = 'vercel';
    deploySignals.push('vercel.json found');
  } else if (fileExists('Procfile')) {
    suggested.deploy = 'heroku';
    deploySignals.push('Procfile found');
  }

  if (deploySignals.length > 0) {
    signals.push({
      dimension: 'deploy',
      confidence: 'high',
      evidence: deploySignals,
    });
  }

  // ============================================================================
  // sensitive detection
  // ============================================================================

  const sensitiveSignals = [];

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const depsStr = JSON.stringify(deps);

    if (/\b(passport|next-auth|auth0|firebase|okta)\b/.test(depsStr)) {
      sensitiveSignals.push('Auth library detected (passport/next-auth/auth0/firebase/okta)');
    }
    if (/\b(stripe|paypal|square|shopify|commerce)\b/.test(depsStr)) {
      sensitiveSignals.push('Payment library detected (stripe/paypal/square/shopify)');
    }
  }

  if (sensitiveSignals.length > 0) {
    suggested.sensitive = true;
    signals.push({
      dimension: 'sensitive',
      confidence: 'medium',
      evidence: sensitiveSignals,
    });
  }

  // ============================================================================
  // oss detection
  // ============================================================================

  const ossSignals = [];

  if (fileExists('LICENSE')) {
    ossSignals.push('LICENSE file found');
  }
  if (fileExists('CONTRIBUTING.md')) {
    ossSignals.push('CONTRIBUTING.md found');
  }
  if (fileExists('CODE_OF_CONDUCT.md')) {
    ossSignals.push('CODE_OF_CONDUCT.md found');
  }

  if (ossSignals.length > 0) {
    suggested.oss = true;
    signals.push({
      dimension: 'oss',
      confidence: 'high',
      evidence: ossSignals,
    });
  }

  // ============================================================================
  // monorepo detection
  // ============================================================================

  const monorepoSignals = [];

  if (fileExists('pnpm-workspace.yaml')) {
    monorepoSignals.push('pnpm-workspace.yaml found');
  }
  if (fileExists('lerna.json')) {
    monorepoSignals.push('lerna.json found');
  }
  if (fileExists('nx.json')) {
    monorepoSignals.push('nx.json found');
  }
  if (fileExists('turbo.json')) {
    monorepoSignals.push('turbo.json found');
  }

  if (monorepoSignals.length > 0) {
    suggested.monorepo = true;
    signals.push({
      dimension: 'monorepo',
      confidence: 'high',
      evidence: monorepoSignals,
    });
  }

  // ============================================================================
  // Build needs_confirmation array
  // ============================================================================

  const needsConfirmation = [];

  // Medium-confidence dimensions need confirmation
  for (const signal of signals) {
    if (signal.confidence === 'medium') {
      needsConfirmation.push(signal.dimension);
    }
  }

  // Unknown base_profile always needs confirmation
  if (suggested.base_profile === 'unknown') {
    if (!needsConfirmation.includes('base_profile')) {
      needsConfirmation.push('base_profile');
    }
  }

  return {
    suggested,
    signals,
    needs_confirmation: needsConfirmation,
  };
}

// ============================================================================
// CLI mode
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse --root and --json flags
  let rootPath = process.cwd();
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      rootPath = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  try {
    const result = detectProjectIntent(rootPath);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Human-readable output
      console.log('Project Intent Detection\n');
      console.log('Suggested Intent:');
      console.log(`  base_profile: ${result.suggested.base_profile}`);
      console.log(`  iac:          ${result.suggested.iac}`);
      console.log(`  deploy:       ${result.suggested.deploy}`);
      console.log(`  sensitive:    ${result.suggested.sensitive}`);
      console.log(`  oss:          ${result.suggested.oss}`);
      console.log(`  monorepo:     ${result.suggested.monorepo}\n`);

      if (result.signals.length > 0) {
        console.log('Signals:\n');
        for (const signal of result.signals) {
          console.log(`  ${signal.dimension} (${signal.confidence} confidence):`);
          for (const evidence of signal.evidence) {
            console.log(`    - ${evidence}`);
          }
        }
      }

      if (result.needs_confirmation.length > 0) {
        console.log(`\nNeeds Confirmation:\n  ${result.needs_confirmation.join(', ')}`);
      }
    }
  } catch (err) {
    console.error(`Error detecting project intent: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { detectProjectIntent };
