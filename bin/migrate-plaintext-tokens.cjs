#!/usr/bin/env node
'use strict';

// migrate-plaintext-tokens.cjs — one-shot migration for issue 169
// Scans providers.json for plaintext secret values (*_API_KEY, *_AUTH_TOKEN, *_TOKEN),
// stores them in the secrets store (~/.claude/nf-secrets.json), and replaces with
// ${VAR} placeholders in providers.json.
//
// Idempotent: re-running is safe — already-masked values are skipped.
//
// Usage:
//   node bin/migrate-plaintext-tokens.cjs           # migrate
//   node bin/migrate-plaintext-tokens.cjs --dry-run # preview only

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { maskSecrets, isPlaceholder } = require('./resolve-env.cjs');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Locate providers.json ──────────────────────────────────────────────────
const candidates = [
  path.join(os.homedir(), '.claude', 'nf', 'bin', 'providers.json'),
  path.join(os.homedir(), '.claude', 'nf-bin', 'providers.json'),
  path.join(process.cwd(), 'bin', 'providers.json'),
];

let providersPath = null;
let providersData = null;

for (const p of candidates) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(data?.providers) && data.providers.length > 0) {
      providersPath = p;
      providersData = data;
      break;
    }
  } catch (_) { /* try next */ }
}

if (!providersPath) {
  process.stderr.write('[migrate-plaintext-tokens] No providers.json with providers found\n');
  process.exit(1);
}

process.stderr.write(`[migrate-plaintext-tokens] Reading: ${providersPath}\n`);

// ── Scan for plaintext secrets ─────────────────────────────────────────────
let totalSecrets = 0;
const allSecrets = []; // { provider, key, value }

for (const provider of providersData.providers) {
  if (!provider.env) continue;
  for (const [k, v] of Object.entries(provider.env)) {
    if (/_(API_KEY|AUTH_TOKEN|TOKEN)$/.test(k) && !isPlaceholder(v)) {
      allSecrets.push({ provider: provider.name, key: k, value: v });
    }
  }
}

if (allSecrets.length === 0) {
  process.stderr.write('[migrate-plaintext-tokens] No plaintext secrets found — nothing to migrate\n');
  process.exit(0);
}

process.stderr.write(`[migrate-plaintext-tokens] Found ${allSecrets.length} plaintext secret(s):\n`);
for (const s of allSecrets) {
  process.stderr.write(`  ${s.provider}.env.${s.key} = [REDACTED]\n`);
}

if (DRY_RUN) {
  process.stderr.write('[migrate-plaintext-tokens] DRY RUN — no changes written\n');
  process.exit(0);
}

// ── Store in secrets store ─────────────────────────────────────────────────
const secretsPath = path.join(os.homedir(), '.claude', 'nf-secrets.json');
let secretsStore = {};
try { secretsStore = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) || {}; } catch (_) {}

for (const s of allSecrets) {
  secretsStore[s.provider + '__' + s.key] = s.value;
}

fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
const tmpSecrets = secretsPath + '.tmp';
fs.writeFileSync(tmpSecrets, JSON.stringify(secretsStore, null, 2), { mode: 0o600 });
fs.renameSync(tmpSecrets, secretsPath);
process.stderr.write(`[migrate-plaintext-tokens] Stored ${allSecrets.length} secret(s) in ${secretsPath}\n`);

// ── Replace with placeholders in providers.json ────────────────────────────
for (const provider of providersData.providers) {
  if (!provider.env) continue;
  const { masked } = maskSecrets(provider.env);
  provider.env = masked;
}

const tmpProviders = providersPath + '.tmp';
fs.writeFileSync(tmpProviders, JSON.stringify(providersData, null, 2) + '\n');
fs.renameSync(tmpProviders, providersPath);
process.stderr.write(`[migrate-plaintext-tokens] Replaced plaintext values with \${VAR} placeholders in ${providersPath}\n`);

// ── Summary ────────────────────────────────────────────────────────────────
process.stderr.write('\n[migrate-plaintext-tokens] Migration complete:\n');
process.stderr.write(`  Secrets stored:   ${allSecrets.length}\n`);
process.stderr.write(`  Secrets store:    ${secretsPath} (mode 0600)\n`);
process.stderr.write(`  Providers file:   ${providersPath}\n`);
process.stderr.write('\nIf any of these tokens were already leaked (backups, Time Machine, etc.),\n');
process.stderr.write('rotate them at the provider dashboard and re-run /nf:link-daintree.\n');
