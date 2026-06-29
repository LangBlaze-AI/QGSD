#!/usr/bin/env node
// bin/ccr-secure-config.cjs
// Reads the 3 CCR provider API keys from the nForma secrets store and writes them
// into ~/.claude-code-router/config.json with chmod 600.
// Designed to be called at session start and on-demand. Fail-silent when secrets
// store is unavailable or keys are not yet stored.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.claude-code-router', 'config.json');

// Locate secrets.cjs — try installed global path first, then local dev path.
function findSecrets() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'nf-bin', 'secrets.cjs'), // installed path
    path.join(__dirname, 'secrets.cjs'),                             // local dev path
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return require(p);
      }
    } catch (_) {}
  }
  return null;
}

async function main() {
  const secrets = findSecrets();
  if (!secrets) {
    process.stderr.write('[ccr-secure-config] secrets.cjs not found — skipping CCR config population\n');
    process.exit(0);
  }

  let akashKey, togetherKey, fireworksKey;
  try {
    akashKey    = await secrets.get('nforma', 'AKASHML_API_KEY');
    togetherKey = await secrets.get('nforma', 'TOGETHER_API_KEY');
    fireworksKey = await secrets.get('nforma', 'FIREWORKS_API_KEY');
  } catch (e) {
    process.stderr.write('[ccr-secure-config] secrets store unavailable: ' + e.message + '\n');
    process.exit(0);
  }

  if (!akashKey && !togetherKey && !fireworksKey) {
    process.stderr.write('[ccr-secure-config] No CCR provider keys found in secrets store — run manage-agents (option 9) to set them\n');
    process.exit(0);
  }

  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (e) {
    process.stderr.write('[ccr-secure-config] Could not read ' + CONFIG_PATH + ': ' + e.message + '\n');
    process.exit(1);
  }

  if (!config || typeof config !== 'object' || !Array.isArray(config.providers)) {
    process.stderr.write('[ccr-secure-config] config.json has no providers array\n');
    process.exit(1);
  }

  const providerKeyMap = {
    akashml:   akashKey,
    together:  togetherKey,
    fireworks: fireworksKey,
  };

  let patched = 0;
  for (const provider of config.providers) {
    if (!provider.name || typeof provider.name !== 'string') continue;
    const keyName = provider.name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(providerKeyMap, keyName) && providerKeyMap[keyName]) {
      provider.api_key = providerKeyMap[keyName];
      patched++;
    }
  }

  // Write config back atomically
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);

  // Enforce permissions on existing file (writeFileSync mode only applies to new files on some systems)
  try {
    execFileSync('chmod', ['600', CONFIG_PATH]);
  } catch (_) {}

  console.log('[ccr-secure-config] Populated ' + patched + ' provider key(s)');
}

main().catch((e) => {
  process.stderr.write('[ccr-secure-config] Unexpected error: ' + e.message + '\n');
  process.exit(1);
});
