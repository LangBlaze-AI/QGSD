#!/usr/bin/env node
'use strict';
/**
 * set-secret.cjs
 * Usage: node bin/set-secret.cjs <KEY_NAME>
 *
 * Reads the secret value from stdin (secure, not visible in ps).
 * Stores KEY_NAME=value in the nForma secrets store,
 * then syncs all nforma secrets into ~/.claude.json mcpServers env blocks.
 */
const { set, syncToClaudeJson, SERVICE } = require('./secrets.cjs');
const readline = require('readline');

const [, , keyName] = process.argv;
if (!keyName) {
  console.error('Usage: node bin/set-secret.cjs <KEY_NAME>');
  console.error('Reads secret value from stdin (echo "secret" | node bin/set-secret.cjs KEY_NAME)');
  process.exit(1);
}

// Reject reserved object keys. `__proto__` in particular is silently dropped by
// the JSON-backed store (store['__proto__'] = '<string>' sets the prototype, a
// no-op, so the secret never persists) — yet the CLI would still print "Stored".
if (keyName === '__proto__' || keyName === 'constructor' || keyName === 'prototype') {
  console.error(`[nf] Error: "${keyName}" is a reserved key name and cannot be used as a secret key`);
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false // don't echo input
});

let value = '';
rl.on('line', (line) => {
  value += line + '\n';
});

rl.on('close', async () => {
  value = value.trim();
  if (!value) {
    console.error('Usage: node bin/set-secret.cjs <KEY_NAME>');
    console.error('Reads secret value from stdin (echo "secret" | node bin/set-secret.cjs KEY_NAME)');
    console.error('Error: No value provided via stdin');
    process.exit(1);
  }

  try {
    await set(SERVICE, keyName, value);
    console.log(`[nf] Stored ${keyName} in secrets store (service: ${SERVICE})`);
    await syncToClaudeJson(SERVICE);
    console.log('[nf] Synced secrets to ~/.claude.json');
  } catch (e) {
    console.error('[nf] Error:', e.message);
    process.exit(1);
  }
});
