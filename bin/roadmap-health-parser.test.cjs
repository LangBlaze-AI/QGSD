'use strict';
// bin/roadmap-health-parser.test.cjs
// Guards F8 + F3 (dogfooding):
//   F8 — `nf-tools roadmap analyze` returned ZERO phases on a ROADMAP that uses the
//        checklist phase format (`- [x] Phase N: Title`). The phasePattern regexes
//        only matched `## Phase` headings or **bold** checklist items, never a plain
//        `- [x] Phase N:`. Same blind spot in cmdValidateHealth/Consistency/compare.
//   F3 — `nf-tools validate health` emitted ONE W007 per orphan phase (dozens),
//        pinning /nf:health at DEGRADED. The orphans are now collapsed into a single
//        actionable W007.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = path.join(__dirname, '..', 'core', 'bin', 'nf-tools.cjs');

function runTool(args, cwd) {
  const out = execFileSync('node', [TOOLS, ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(out);
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-rmhp-'));
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  return dir;
}

describe('F8 — roadmap analyze parses the checklist phase format', () => {
  it('extracts phases from `- [x] Phase N: Title` lines', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n<details>\n<summary>Done</summary>\n\n' +
        '- [x] Phase 54: XML Context Packer (2/2 plans)\n' +
        '- [x] Phase 55: Hotspot Detection (2/2 plans)\n' +
        '- [ ] Phase 56: Co-Change (0/1 plan)\n</details>\n');
      const d = runTool(['roadmap', 'analyze'], dir);
      assert.equal(d.phase_count, 3, 'all three checklist phases must be parsed');
      const nums = d.phases.map(p => String(p.number));
      assert.deepEqual(nums.sort(), ['54', '55', '56']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still parses heading and bold-checklist forms (no regression)', () => {
    const dir = tmpProject();
    try {
      fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n## Phase 1: Heading Form\n\n- [ ] **Phase 2: Bold Form**\n');
      const d = runTool(['roadmap', 'analyze'], dir);
      assert.equal(d.phase_count, 2, 'heading + bold forms must still match');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('F3 — health collapses orphan-phase W007s into one', () => {
  it('emits a single W007 listing every orphan, not one per phase', () => {
    const dir = tmpProject();
    try {
      // ROADMAP knows only Phase 1; phases 50/51/52 exist on disk → 3 orphans.
      fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'),
        '# Roadmap\n\n- [ ] Phase 1: Known\n');
      for (const n of ['50-old', '51-old', '52-old']) {
        fs.mkdirSync(path.join(dir, '.planning', 'phases', n), { recursive: true });
      }
      const d = runTool(['validate', 'health', '--json'], dir);
      const all = d.issues || d.warnings || d.checks || [];
      const w007 = all.filter(i => i && i.code === 'W007');
      assert.equal(w007.length, 1, 'orphans must collapse into exactly one W007');
      const msg = w007[0].message || w007[0].msg || '';
      assert.ok(/50/.test(msg) && /51/.test(msg) && /52/.test(msg),
        'the single W007 must enumerate all orphan phases');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
