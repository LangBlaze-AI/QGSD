#!/usr/bin/env node
'use strict';
// bin/validate-requirements-staleness.cjs
// F14: many requirement TEXTS in .planning/formal/requirements.json still mention
// legacy paths/names from before the qgsd→nForma rename (`qgsd.json`, `.formal/`,
// `get-shit-done`). The code resolves the real paths, so nothing is broken — but
// the requirement docs are stale and there was no way to surface them.
//
// This is a DETECT-ONLY reporter. It NEVER writes: editing the hash-protected
// requirements envelope to "fix" doc text is riskier than the stale text itself.
// It prints the offending requirement IDs + suggested replacements so a human can
// decide. Exits 0 by default; --strict exits 1 when stale references are found.
//
// Usage:
//   node bin/validate-requirements-staleness.cjs [--json] [--strict] [--project-root <dir>] [--help]

const fs = require('fs');
const path = require('path');

// Actionable, unambiguous stale → suggested replacement. (The bare word `qgsd`
// is reported as an informational count only — it's too context-dependent to
// auto-suggest a single replacement.)
const RULES = [
  { id: 'qgsd-json', re: /qgsd\.json/g, suggest: 'nf.json' },
  { id: 'dot-formal-dir', re: /(?<![\w.])\.formal\//g, suggest: '.planning/formal/' },
  { id: 'get-shit-done', re: /get-shit-done/g, suggest: 'nforma (or ~/.claude/nf-bin/)' },
];
const INFO = [{ id: 'bare-qgsd', re: /\bqgsd\b/gi }];

function parseArgs(argv) {
  const a = argv.slice(2);
  const opt = { json: a.includes('--json'), strict: a.includes('--strict'),
    help: a.includes('--help') || a.includes('-h'), root: process.cwd() };
  const i = a.indexOf('--project-root');
  if (i !== -1 && a[i + 1]) opt.root = path.resolve(a[i + 1]);
  const eq = a.find(x => x.startsWith('--project-root='));
  if (eq) opt.root = path.resolve(eq.slice('--project-root='.length));
  return opt;
}

const USAGE = [
  'Usage: node bin/validate-requirements-staleness.cjs [options]',
  '',
  'Report requirement texts that reference legacy qgsd→nForma paths/names.',
  'DETECT-ONLY — never edits requirements.json.',
  '',
  '  --json               Machine-readable output.',
  '  --strict             Exit 1 if any stale reference is found (else exit 0).',
  '  --project-root <dir> Operate on <dir>/.planning/formal/requirements.json.',
  '  -h, --help           Show this help and exit.',
].join('\n');

// Walk all string values in a requirement object, yielding {field, value}.
function* strings(obj, prefix = '') {
  if (typeof obj === 'string') { yield { field: prefix || 'value', value: obj }; return; }
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) yield* strings(obj[i], `${prefix}[${i}]`); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) yield* strings(v, prefix ? `${prefix}.${k}` : k);
  }
}

function scan(root) {
  const reqPath = path.join(root, '.planning', 'formal', 'requirements.json');
  if (!fs.existsSync(reqPath)) return { error: 'requirements.json not found', path: reqPath };
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(reqPath, 'utf8')); }
  catch (e) { return { error: 'requirements.json parse error: ' + e.message }; }
  const reqs = envelope.requirements || [];

  const findings = [];
  const counts = {};
  for (const req of reqs) {
    for (const { field, value } of strings(req)) {
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        if (rule.re.test(value)) {
          counts[rule.id] = (counts[rule.id] || 0) + 1;
          findings.push({ id: req.id || '(no id)', field, rule: rule.id, suggest: rule.suggest,
            snippet: value.length > 120 ? value.slice(0, 117) + '…' : value });
        }
      }
    }
  }
  const info = {};
  for (const req of reqs) {
    const blob = JSON.stringify(req);
    for (const r of INFO) { r.re.lastIndex = 0; if (r.re.test(blob)) info[r.id] = (info[r.id] || 0) + 1; }
  }
  return { total_requirements: reqs.length, findings, counts, info, path: reqPath };
}

function main() {
  const opt = parseArgs(process.argv);
  if (opt.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  const result = scan(opt.root);

  if (opt.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (result.error) {
    process.stderr.write('[req-staleness] ' + result.error + '\n');
  } else {
    const n = result.findings.length;
    process.stdout.write(`[req-staleness] ${n} stale reference(s) across ${result.total_requirements} requirements\n`);
    for (const [rule, c] of Object.entries(result.counts)) process.stdout.write(`  ${rule}: ${c} → suggest "${RULES.find(r => r.id === rule).suggest}"\n`);
    if (result.info['bare-qgsd']) process.stdout.write(`  (info) bare "qgsd" mentions: ${result.info['bare-qgsd']} requirement(s) — review case-by-case\n`);
    for (const f of result.findings.slice(0, 40)) process.stdout.write(`  - [${f.id}] ${f.field}: ${f.rule} → ${f.suggest}\n`);
    if (n > 40) process.stdout.write(`  … and ${n - 40} more (use --json for the full list)\n`);
    if (n === 0) process.stdout.write('  clean — no legacy qgsd/.formal references.\n');
  }

  if (result.error) process.exit(opt.strict ? 1 : 0);
  process.exit(opt.strict && result.findings.length > 0 ? 1 : 0);
}

if (require.main === module) main();
module.exports = { scan, RULES };
