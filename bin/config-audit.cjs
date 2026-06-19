#!/usr/bin/env node
'use strict';

// bin/config-audit.cjs
// Cross-references providers.json against nf.json agent_config.
// Detects the "all-default" anti-pattern where every slot defaults to auth_type='api',
// which permanently defeats T1 tiered fallback (FALLBACK-01).
//
// Output: JSON to stdout: { warnings: string[], missing: string[] }
// Exit: always 0 (fail-open)

const fs = require('fs');
const path = require('path');
const { loadProviders } = require('./resolve-providers.cjs');

try {
  // Parse CLI args
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const projectRootArg = args.find(a => a.startsWith('--project-root='));
  const projectRoot = projectRootArg ? projectRootArg.split('=').slice(1).join('=') : null;

  // 1. Load providers.json via the single resolver (#197/#218)
  const providers = loadProviders({ baseDir: __dirname });
  if (!Array.isArray(providers) || providers.length === 0) {
    const result = { warnings: [], missing: [], error: 'no providers.json with providers found' };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }
  const allSlotNames = providers.map(p => p.name);

  // 2. Load config via config-loader
  const configLoader = require(path.join(__dirname, '..', 'hooks', 'config-loader'));
  const config = configLoader.loadConfig(projectRoot || undefined);

  // 3. Determine which slots to audit
  const quorumActive = config.quorum_active || [];
  const slotsToAudit = quorumActive.length > 0 ? quorumActive : allSlotNames;

  // 4. Cross-reference against agent_config
  const agentConfig = config.agent_config || {};
  const warnings = [];
  const missing = [];

  for (const slot of slotsToAudit) {
    if (!agentConfig[slot]) {
      missing.push(slot);
    }
  }

  // 5. Detect the "all-default" anti-pattern
  // If ALL audited slots either have no agent_config entry or have auth_type='api' (or absent),
  // then T1 (sub-CLI slots) is always empty and FALLBACK-01 is defeated.
  const hasAnySub = slotsToAudit.some(slot => {
    const entry = agentConfig[slot];
    return entry && entry.auth_type === 'sub';
  });

  if (!hasAnySub && slotsToAudit.length > 0) {
    warnings.push(
      'All slots default to auth_type=api \u2014 T1 tiered fallback (FALLBACK-01) will be permanently empty. ' +
      'Set auth_type=\'sub\' for subscription-tier providers (codex-1, gemini-1, opencode-1, copilot-1) ' +
      'in ~/.claude/nf.json agent_config.'
    );
  }

  // 6. Output
  const result = { warnings, missing };

  if (jsonFlag) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    // Human-readable output
    if (warnings.length > 0) {
      for (const w of warnings) {
        process.stderr.write('[config-audit] WARNING: ' + w + '\n');
      }
    }
    if (missing.length > 0) {
      process.stderr.write('[config-audit] Missing agent_config entries for: ' + missing.join(', ') + '\n');
    }
    if (warnings.length === 0 && missing.length === 0) {
      process.stderr.write('[config-audit] All slots configured correctly.\n');
    }
    // Still output JSON to stdout for machine consumption
    process.stdout.write(JSON.stringify(result) + '\n');
  }

  process.exit(0);

} catch (err) {
  process.stderr.write('[config-audit] ERROR: ' + (err.message || err) + '\n');
  process.stdout.write(JSON.stringify({ warnings: [], missing: [], error: (err.message || String(err)) }) + '\n');
  process.exit(0);
}
