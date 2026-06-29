#!/usr/bin/env node
'use strict';
// bin/solve-focus-filter.test.cjs
// Unit tests for solve-focus-filter.cjs — uses mock data (not real requirements.json)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { filterRequirementsByFocus, describeFocusFilter, tokenize } = require('./solve-focus-filter.cjs');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS: ${msg}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL: ${msg}\n`);
  }
}

// ── Setup mock data ────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solve-focus-test-'));
const planningDir = path.join(tmpDir, '.planning', 'formal');
fs.mkdirSync(planningDir, { recursive: true });

const mockRequirements = {
  schema_version: "1",
  requirements: [
    { id: "QUORUM-01", text: "Quorum dispatch uses parallel slot workers", category: "Quorum & Dispatch", category_raw: "Architecture" },
    { id: "QUORUM-02", text: "Quorum requires minimum 3 verdicts for consensus", category: "Quorum & Dispatch", category_raw: "Quorum Gates" },
    { id: "HOOK-01", text: "Stop hook blocks non-quorum planning responses", category: "Hooks & Enforcement", category_raw: "Stop Hook" },
    { id: "HOOK-02", text: "Circuit breaker detects oscillation patterns", category: "Hooks & Enforcement", category_raw: "Detection" },
    { id: "INST-01", text: "Installer copies hook files to global path", category: "Installer & CLI", category_raw: "Installer" },
    { id: "FORMAL-01", text: "TLA+ models cover all state machine transitions", category: "Formal Verification", category_raw: "Schema Foundation" },
    { id: "MCP-01", text: "Unified MCP server handles all provider slots", category: "MCP & Agents", category_raw: "Agent Roster" },
    { id: "TRACK-01", text: "Solve trend uses Mann-Kendall for non-parametric trend detection", category: "Observability & Diagnostics", category_raw: "Observability" },
    { id: "CFG-01", text: "Two-layer config loader merges global and project settings", category: "Configuration", category_raw: "Config System" },
  ],
};

const mockCategoryGroups = {
  "Stop Hook": "Hooks & Enforcement",
  "Architecture": "Quorum & Dispatch",
  "Quorum Gates": "Quorum & Dispatch",
  "Detection": "Hooks & Enforcement",
  "Installer": "Installer & CLI",
  "Schema Foundation": "Formal Verification",
  "Agent Roster": "MCP & Agents",
  "Observability": "Observability & Diagnostics",
  "Config System": "Configuration",
};

fs.writeFileSync(path.join(planningDir, 'requirements.json'), JSON.stringify(mockRequirements));
fs.writeFileSync(path.join(planningDir, 'category-groups.json'), JSON.stringify(mockCategoryGroups));

// ── Tests ──────────────────────────────────────────────────────────────────

console.log('\n=== solve-focus-filter.test.cjs ===\n');

// 1. Returns null for empty/undefined/null focus phrase
console.log('Null/empty handling:');
assert(filterRequirementsByFocus(null, { root: tmpDir }) === null, 'null input returns null');
assert(filterRequirementsByFocus(undefined, { root: tmpDir }) === null, 'undefined input returns null');
assert(filterRequirementsByFocus('', { root: tmpDir }) === null, 'empty string returns null');
assert(filterRequirementsByFocus('   ', { root: tmpDir }) === null, 'whitespace-only returns null (no tokens after split)');
assert(filterRequirementsByFocus('the a an', { root: tmpDir }) === null, 'only stop words returns null');

// 2. Matches requirement by ID substring
console.log('\nID matching:');
const quorumResult = filterRequirementsByFocus('quorum', { root: tmpDir });
assert(quorumResult !== null, 'quorum returns non-null');
assert(quorumResult.has('QUORUM-01'), 'quorum matches QUORUM-01 by ID');
assert(quorumResult.has('QUORUM-02'), 'quorum matches QUORUM-02 by ID');

// 3. Matches requirement by category group name
console.log('\nCategory group matching:');
const hookResult = filterRequirementsByFocus('hooks', { root: tmpDir });
assert(hookResult !== null, 'hooks returns non-null');
assert(hookResult.has('HOOK-01'), 'hooks matches HOOK-01 via category group "Hooks & Enforcement"');
assert(hookResult.has('HOOK-02'), 'hooks matches HOOK-02 via category group "Hooks & Enforcement"');

// 4. Matches requirement by text content
console.log('\nText matching:');
const oscillationResult = filterRequirementsByFocus('oscillation patterns', { root: tmpDir });
assert(oscillationResult !== null, 'oscillation returns non-null');
assert(oscillationResult.has('HOOK-02'), 'oscillation matches HOOK-02 via text "oscillation patterns"');

// 5. Does NOT match completely unrelated requirements
console.log('\nNegative matching:');
const quorumResultCheck = filterRequirementsByFocus('quorum', { root: tmpDir });
assert(!quorumResultCheck.has('INST-01'), 'quorum does NOT match INST-01 (installer)');
assert(!quorumResultCheck.has('CFG-01'), 'quorum does NOT match CFG-01 (config)');

// 6. describeFocusFilter returns correct summary string
console.log('\ndescribeFocusFilter:');
const ids = new Set(['QUORUM-01', 'QUORUM-02']);
const desc = describeFocusFilter('quorum', ids, 9);
assert(desc === "Focus: 'quorum' -- 2/9 requirements matched", `describeFocusFilter output correct: "${desc}"`);

// 7. Tokenizer tests
console.log('\nTokenizer:');
const tokens = tokenize('quorum state-machine');
assert(tokens.includes('quorum'), 'tokenizes "quorum"');
assert(tokens.includes('state'), 'splits hyphenated: "state"');
assert(tokens.includes('machine'), 'splits hyphenated: "machine"');
assert(!tokens.includes('the'), 'excludes stop word "the"');

// 8. Multi-token matching compounds score
console.log('\nMulti-token:');
const formalResult = filterRequirementsByFocus('formal verification', { root: tmpDir });
assert(formalResult !== null, 'formal verification returns non-null');
assert(formalResult.has('FORMAL-01'), 'formal verification matches FORMAL-01');

// 9. Nonexistent root returns empty set (not crash)
console.log('\nEdge cases:');
const noRoot = filterRequirementsByFocus('quorum', { root: '/nonexistent/path' });
assert(noRoot !== null && noRoot.size === 0, 'nonexistent root returns empty set');

// 10. Adversarial: null / non-object requirement entries must not crash the loop
console.log('\nAdversarial: null requirement entries:');
const advDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'solve-focus-adv1-'));
const advPlanning1 = path.join(advDir1, '.planning', 'formal');
fs.mkdirSync(advPlanning1, { recursive: true });
fs.writeFileSync(
  path.join(advPlanning1, 'requirements.json'),
  JSON.stringify({ requirements: [null, 'a-bare-string', 123, { id: 'QUORUM-99', text: 'quorum thing' }] })
);
let threw1 = false;
let res1 = null;
try {
  res1 = filterRequirementsByFocus('quorum', { root: advDir1 });
} catch (e) {
  threw1 = true;
}
assert(!threw1, 'null/non-object requirement entries do not throw');
assert(res1 !== null && res1.has('QUORUM-99'), 'valid requirement still matched alongside junk entries');
fs.rmSync(advDir1, { recursive: true, force: true });

// 11. Adversarial: prototype-chain key in category_raw must not crash bracket lookup
console.log('\nAdversarial: prototype-pollution category_raw:');
const advDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'solve-focus-adv2-'));
const advPlanning2 = path.join(advDir2, '.planning', 'formal');
fs.mkdirSync(advPlanning2, { recursive: true });
for (const evilKey of ['__proto__', 'constructor', 'toString']) {
  fs.writeFileSync(
    path.join(advPlanning2, 'requirements.json'),
    JSON.stringify({ requirements: [{ id: 'EVIL-01', text: 'quorum dispatch', category_raw: evilKey }] })
  );
  fs.writeFileSync(path.join(advPlanning2, 'category-groups.json'), '{}');
  let threw2 = false;
  let res2 = null;
  try {
    // two-token focus so the entry scores via text (text match is +1 each; threshold is 2)
    res2 = filterRequirementsByFocus('quorum dispatch', { root: advDir2 });
  } catch (e) {
    threw2 = true;
  }
  assert(!threw2, `category_raw "${evilKey}" does not throw on group lookup`);
  assert(res2 !== null && res2.has('EVIL-01'), `still matches by text with category_raw "${evilKey}"`);
}
fs.rmSync(advDir2, { recursive: true, force: true });

// 12. Adversarial: non-string field values must not crash toLowerCase()
console.log('\nAdversarial: non-string requirement fields:');
const advDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'solve-focus-adv3-'));
const advPlanning3 = path.join(advDir3, '.planning', 'formal');
fs.mkdirSync(advPlanning3, { recursive: true });
fs.writeFileSync(
  path.join(advPlanning3, 'requirements.json'),
  JSON.stringify({ requirements: [{ id: 12345, category: true, text: 'quorum dispatch' }] })
);
let threw3 = false;
let res3 = null;
try {
  // two-token focus so the entry scores via text (text match is +1 each; threshold is 2)
  res3 = filterRequirementsByFocus('quorum dispatch', { root: advDir3 });
} catch (e) {
  threw3 = true;
}
assert(!threw3, 'numeric id / boolean category do not throw');
assert(res3 !== null && res3.has(12345), 'requirement with numeric id still matched by text');
fs.rmSync(advDir3, { recursive: true, force: true });

// ── Cleanup + Summary ──────────────────────────────────────────────────────

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
