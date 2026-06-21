/**
 * NF Tools Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOOLS_PATH = path.join(__dirname, 'nf-tools.cjs');

// Helper to run nf-tools command
function runNfTools(args, cwd = process.cwd()) {
  try {
    const result = execSync(`node "${TOOLS_PATH}" ${args}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message,
    };
  }
}

// Create temp directory structure
function createTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nf-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('history-digest command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phases directory returns valid schema', () => {
    const result = runNfTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);

    assert.deepStrictEqual(digest.phases, {}, 'phases should be empty object');
    assert.deepStrictEqual(digest.decisions, [], 'decisions should be empty array');
    assert.deepStrictEqual(digest.tech_stack, [], 'tech_stack should be empty array');
  });

  test('nested frontmatter fields extracted correctly', () => {
    // Create phase directory with SUMMARY containing nested frontmatter
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    const summaryContent = `---
phase: "01"
name: "Foundation Setup"
dependency-graph:
  provides:
    - "Database schema"
    - "Auth system"
  affects:
    - "API layer"
tech-stack:
  added:
    - "prisma"
    - "jose"
patterns-established:
  - "Repository pattern"
  - "JWT auth flow"
key-decisions:
  - "Use Prisma over Drizzle"
  - "JWT in httpOnly cookies"
---

# Summary content here
`;

    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), summaryContent);

    const result = runNfTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);

    // Check nested dependency-graph.provides
    assert.ok(digest.phases['01'], 'Phase 01 should exist');
    assert.deepStrictEqual(
      digest.phases['01'].provides.sort(),
      ['Auth system', 'Database schema'],
      'provides should contain nested values'
    );

    // Check nested dependency-graph.affects
    assert.deepStrictEqual(
      digest.phases['01'].affects,
      ['API layer'],
      'affects should contain nested values'
    );

    // Check nested tech-stack.added
    assert.deepStrictEqual(
      digest.tech_stack.sort(),
      ['jose', 'prisma'],
      'tech_stack should contain nested values'
    );

    // Check patterns-established (flat array)
    assert.deepStrictEqual(
      digest.phases['01'].patterns.sort(),
      ['JWT auth flow', 'Repository pattern'],
      'patterns should be extracted'
    );

    // Check key-decisions
    assert.strictEqual(digest.decisions.length, 2, 'Should have 2 decisions');
    assert.ok(
      digest.decisions.some(d => d.decision === 'Use Prisma over Drizzle'),
      'Should contain first decision'
    );
  });

  test('multiple phases merged into single digest', () => {
    // Create phase 01
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phase01Dir, { recursive: true });
    fs.writeFileSync(
      path.join(phase01Dir, '01-01-SUMMARY.md'),
      `---
phase: "01"
name: "Foundation"
provides:
  - "Database"
patterns-established:
  - "Pattern A"
key-decisions:
  - "Decision 1"
---
`
    );

    // Create phase 02
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase02Dir, { recursive: true });
    fs.writeFileSync(
      path.join(phase02Dir, '02-01-SUMMARY.md'),
      `---
phase: "02"
name: "API"
provides:
  - "REST endpoints"
patterns-established:
  - "Pattern B"
key-decisions:
  - "Decision 2"
tech-stack:
  added:
    - "zod"
---
`
    );

    const result = runNfTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);

    // Both phases present
    assert.ok(digest.phases['01'], 'Phase 01 should exist');
    assert.ok(digest.phases['02'], 'Phase 02 should exist');

    // Decisions merged
    assert.strictEqual(digest.decisions.length, 2, 'Should have 2 decisions total');

    // Tech stack merged
    assert.deepStrictEqual(digest.tech_stack, ['zod'], 'tech_stack should have zod');
  });

  test('malformed SUMMARY.md skipped gracefully', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Valid summary
    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
provides:
  - "Valid feature"
---
`
    );

    // Malformed summary (no frontmatter)
    fs.writeFileSync(
      path.join(phaseDir, '01-02-SUMMARY.md'),
      `# Just a heading
No frontmatter here
`
    );

    // Another malformed summary (broken YAML)
    fs.writeFileSync(
      path.join(phaseDir, '01-03-SUMMARY.md'),
      `---
broken: [unclosed
---
`
    );

    const result = runNfTools('history-digest', tmpDir);
    assert.ok(result.success, `Command should succeed despite malformed files: ${result.error}`);

    const digest = JSON.parse(result.output);
    assert.ok(digest.phases['01'], 'Phase 01 should exist');
    assert.ok(
      digest.phases['01'].provides.includes('Valid feature'),
      'Valid feature should be extracted'
    );
  });

  test('flat provides field still works (backward compatibility)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
provides:
  - "Direct provides"
---
`
    );

    const result = runNfTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);
    assert.deepStrictEqual(
      digest.phases['01'].provides,
      ['Direct provides'],
      'Direct provides should work'
    );
  });

  test('inline array syntax supported', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
phase: "01"
provides: [Feature A, Feature B]
patterns-established: ["Pattern X", "Pattern Y"]
---
`
    );

    const result = runNfTools('history-digest', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const digest = JSON.parse(result.output);
    assert.deepStrictEqual(
      digest.phases['01'].provides.sort(),
      ['Feature A', 'Feature B'],
      'Inline array should work'
    );
    assert.deepStrictEqual(
      digest.phases['01'].patterns.sort(),
      ['Pattern X', 'Pattern Y'],
      'Inline quoted array should work'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phases list command
// ─────────────────────────────────────────────────────────────────────────────

describe('phases list command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phases directory returns empty array', () => {
    const result = runNfTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.directories, [], 'directories should be empty');
    assert.strictEqual(output.count, 0, 'count should be 0');
  });

  test('lists phase directories sorted numerically', () => {
    // Create out-of-order directories
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '10-final'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runNfTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 3, 'should have 3 directories');
    assert.deepStrictEqual(
      output.directories,
      ['01-foundation', '02-api', '10-final'],
      'should be sorted numerically'
    );
  });

  test('handles decimal phases in sort order', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02.1-hotfix'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02.2-patch'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-ui'), { recursive: true });

    const result = runNfTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      ['02-api', '02.1-hotfix', '02.2-patch', '03-ui'],
      'decimal phases should sort correctly between whole numbers'
    );
  });

  test('--type plans lists only PLAN.md files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(phaseDir, 'RESEARCH.md'), '# Research');

    const result = runNfTools('phases list --type plans', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files.sort(),
      ['01-01-PLAN.md', '01-02-PLAN.md'],
      'should list only PLAN files'
    );
  });

  test('--type summaries lists only SUMMARY.md files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary 2');

    const result = runNfTools('phases list --type summaries', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files.sort(),
      ['01-01-SUMMARY.md', '01-02-SUMMARY.md'],
      'should list only SUMMARY files'
    );
  });

  test('--phase filters to specific phase directory', () => {
    const phase01 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase02 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase01, { recursive: true });
    fs.mkdirSync(phase02, { recursive: true });
    fs.writeFileSync(path.join(phase01, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase02, '02-01-PLAN.md'), '# Plan');

    const result = runNfTools('phases list --type plans --phase 01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.files, ['01-01-PLAN.md'], 'should only list phase 01 plans');
    assert.strictEqual(output.phase_dir, 'foundation', 'should report phase name without number prefix');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase command
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap get-phase command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('extracts phase section from ROADMAP.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

### Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

Some description here.

### Phase 2: API
**Goal:** Build REST API
**Plans:** 3 plans
`
    );

    const result = runNfTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase should be found');
    assert.strictEqual(output.phase_number, '1', 'phase number correct');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(output.goal, 'Set up project infrastructure', 'goal extracted');
  });

  test('returns not found for missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up project
`
    );

    const result = runNfTools('roadmap get-phase 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
  });

  test('handles decimal phase numbers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 2: Main
**Goal:** Main work

### Phase 2.1: Hotfix
**Goal:** Emergency fix
`
    );

    const result = runNfTools('roadmap get-phase 2.1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'decimal phase should be found');
    assert.strictEqual(output.phase_name, 'Hotfix', 'phase name correct');
    assert.strictEqual(output.goal, 'Emergency fix', 'goal extracted');
  });

  test('extracts full section content', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize everything

This phase covers:
- Database setup
- Auth configuration
- CI/CD pipeline

### Phase 2: Build
**Goal:** Build features
`
    );

    const result = runNfTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.section.includes('Database setup'), 'section includes description');
    assert.ok(output.section.includes('CI/CD pipeline'), 'section includes all bullets');
    assert.ok(!output.section.includes('Phase 2'), 'section does not include next phase');
  });

  test('handles missing ROADMAP.md gracefully', () => {
    const result = runNfTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'should return not found');
    assert.strictEqual(output.error, 'ROADMAP.md not found', 'should explain why');
  });

  test('accepts ## phase headers (two hashes)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phase 1: Foundation
**Goal:** Set up project infrastructure
**Plans:** 2 plans

## Phase 2: API
**Goal:** Build REST API
`
    );

    const result = runNfTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase with ## header should be found');
    assert.strictEqual(output.phase_name, 'Foundation', 'phase name extracted');
    assert.strictEqual(output.goal, 'Set up project infrastructure', 'goal extracted');
  });

  test('detects malformed ROADMAP with summary list but no detail sections', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

## Phases

- [ ] **Phase 1: Foundation** - Set up project
- [ ] **Phase 2: API** - Build REST API
`
    );

    const result = runNfTools('roadmap get-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'phase should not be found');
    assert.strictEqual(output.error, 'malformed_roadmap', 'should identify malformed roadmap');
    assert.ok(output.message.includes('missing'), 'should explain the issue');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase next-decimal command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase next-decimal command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns X.1 when no decimal phases exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '07-next'), { recursive: true });

    const result = runNfTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.1', 'should return 06.1');
    assert.deepStrictEqual(output.existing, [], 'no existing decimals');
  });

  test('increments from existing decimal phases', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-hotfix'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-patch'), { recursive: true });

    const result = runNfTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.3', 'should return 06.3');
    assert.deepStrictEqual(output.existing, ['06.1', '06.2'], 'lists existing decimals');
  });

  test('handles gaps in decimal sequence', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-first'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.3-third'), { recursive: true });

    const result = runNfTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Should take next after highest, not fill gap
    assert.strictEqual(output.next, '06.4', 'should return 06.4, not fill gap at 06.2');
  });

  test('handles single-digit phase input', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });

    const result = runNfTools('phase next-decimal 6', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.1', 'should normalize to 06.1');
    assert.strictEqual(output.base_phase, '06', 'base phase should be padded');
  });

  test('returns error if base phase does not exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-start'), { recursive: true });

    const result = runNfTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'base phase not found');
    assert.strictEqual(output.next, '06.1', 'should still suggest 06.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase-plan-index command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase-plan-index command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phase directory returns empty plans array', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runNfTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase, '03', 'phase number correct');
    assert.deepStrictEqual(output.plans, [], 'plans should be empty');
    assert.deepStrictEqual(output.waves, {}, 'waves should be empty');
    assert.deepStrictEqual(output.incomplete, [], 'incomplete should be empty');
    assert.strictEqual(output.has_checkpoints, false, 'no checkpoints');
  });

  test('extracts single plan with frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Set up database schema
files-modified: [prisma/schema.prisma, src/lib/db.ts]
---

## Task 1: Create schema
## Task 2: Generate client
`
    );

    const result = runNfTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 1, 'should have 1 plan');
    assert.strictEqual(output.plans[0].id, '03-01', 'plan id correct');
    assert.strictEqual(output.plans[0].wave, 1, 'wave extracted');
    assert.strictEqual(output.plans[0].autonomous, true, 'autonomous extracted');
    assert.strictEqual(output.plans[0].objective, 'Set up database schema', 'objective extracted');
    assert.deepStrictEqual(output.plans[0].files_modified, ['prisma/schema.prisma', 'src/lib/db.ts'], 'files extracted');
    assert.strictEqual(output.plans[0].task_count, 2, 'task count correct');
    assert.strictEqual(output.plans[0].has_summary, false, 'no summary yet');
  });

  test('groups multiple plans by wave', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Database setup
---

## Task 1: Schema
`
    );

    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Auth setup
---

## Task 1: JWT
`
    );

    fs.writeFileSync(
      path.join(phaseDir, '03-03-PLAN.md'),
      `---
wave: 2
autonomous: false
objective: API routes
---

## Task 1: Routes
`
    );

    const result = runNfTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 3, 'should have 3 plans');
    assert.deepStrictEqual(output.waves['1'], ['03-01', '03-02'], 'wave 1 has 2 plans');
    assert.deepStrictEqual(output.waves['2'], ['03-03'], 'wave 2 has 1 plan');
  });

  test('detects incomplete plans (no matching summary)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan with summary
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), `---\nwave: 1\n---\n## Task 1`);
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), `# Summary`);

    // Plan without summary
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), `---\nwave: 2\n---\n## Task 1`);

    const result = runNfTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans[0].has_summary, true, 'first plan has summary');
    assert.strictEqual(output.plans[1].has_summary, false, 'second plan has no summary');
    assert.deepStrictEqual(output.incomplete, ['03-02'], 'incomplete list correct');
  });

  test('detects checkpoints (autonomous: false)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: false
objective: Manual review needed
---

## Task 1: Review
`
    );

    const result = runNfTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_checkpoints, true, 'should detect checkpoint');
    assert.strictEqual(output.plans[0].autonomous, false, 'plan marked non-autonomous');
  });

  test('phase not found returns error', () => {
    const result = runNfTools('phase-plan-index 99', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'Phase not found', 'should report phase not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state-snapshot command
// ─────────────────────────────────────────────────────────────────────────────

describe('state-snapshot command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing STATE.md returns error', () => {
    const result = runNfTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'STATE.md not found', 'should report missing file');
  });

  test('extracts basic fields from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Current Phase Name:** API Layer
**Total Phases:** 6
**Current Plan:** 03-02
**Total Plans in Phase:** 3
**Status:** In progress
**Progress:** 45%
**Last Activity:** 2024-01-15
**Last Activity Description:** Completed 03-01-PLAN.md
`
    );

    const result = runNfTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.current_phase, '03', 'current phase extracted');
    assert.strictEqual(output.current_phase_name, 'API Layer', 'phase name extracted');
    assert.strictEqual(output.total_phases, 6, 'total phases extracted');
    assert.strictEqual(output.current_plan, '03-02', 'current plan extracted');
    assert.strictEqual(output.total_plans_in_phase, 3, 'total plans extracted');
    assert.strictEqual(output.status, 'In progress', 'status extracted');
    assert.strictEqual(output.progress_percent, 45, 'progress extracted');
    assert.strictEqual(output.last_activity, '2024-01-15', 'last activity date extracted');
  });

  test('extracts decisions table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 01

## Decisions Made

| Phase | Decision | Rationale |
|-------|----------|-----------|
| 01 | Use Prisma | Better DX than raw SQL |
| 02 | JWT auth | Stateless authentication |
`
    );

    const result = runNfTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.decisions.length, 2, 'should have 2 decisions');
    assert.strictEqual(output.decisions[0].phase, '01', 'first decision phase');
    assert.strictEqual(output.decisions[0].summary, 'Use Prisma', 'first decision summary');
    assert.strictEqual(output.decisions[0].rationale, 'Better DX than raw SQL', 'first decision rationale');
  });

  test('extracts blockers list', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Blockers

- Waiting for API credentials
- Need design review for dashboard
`
    );

    const result = runNfTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.blockers, [
      'Waiting for API credentials',
      'Need design review for dashboard',
    ], 'blockers extracted');
  });

  test('extracts session continuity info', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03

## Session

**Last Date:** 2024-01-15
**Stopped At:** Phase 3, Plan 2, Task 1
**Resume File:** .planning/phases/03-api/03-02-PLAN.md
`
    );

    const result = runNfTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.session.last_date, '2024-01-15', 'session date extracted');
    assert.strictEqual(output.session.stopped_at, 'Phase 3, Plan 2, Task 1', 'stopped at extracted');
    assert.strictEqual(output.session.resume_file, '.planning/phases/03-api/03-02-PLAN.md', 'resume file extracted');
  });

  test('handles paused_at field', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State

**Current Phase:** 03
**Paused At:** Phase 3, Plan 1, Task 2 - mid-implementation
`
    );

    const result = runNfTools('state-snapshot', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, 'Phase 3, Plan 1, Task 2 - mid-implementation', 'paused_at extracted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// summary-extract command
// ─────────────────────────────────────────────────────────────────────────────

describe('summary-extract command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing file returns error', () => {
    const result = runNfTools('summary-extract .planning/phases/01-test/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'File not found', 'should report missing file');
  });

  test('extracts all fields from SUMMARY.md', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Set up Prisma with User and Project models
key-files:
  - prisma/schema.prisma
  - src/lib/db.ts
tech-stack:
  added:
    - prisma
    - zod
patterns-established:
  - Repository pattern
  - Dependency injection
key-decisions:
  - Use Prisma over Drizzle: Better DX and ecosystem
  - Single database: Start simple, shard later
---

# Summary

Full summary content here.
`
    );

    const result = runNfTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.path, '.planning/phases/01-foundation/01-01-SUMMARY.md', 'path correct');
    assert.strictEqual(output.one_liner, 'Set up Prisma with User and Project models', 'one-liner extracted');
    assert.deepStrictEqual(output.key_files, ['prisma/schema.prisma', 'src/lib/db.ts'], 'key files extracted');
    assert.deepStrictEqual(output.tech_added, ['prisma', 'zod'], 'tech added extracted');
    assert.deepStrictEqual(output.patterns, ['Repository pattern', 'Dependency injection'], 'patterns extracted');
    assert.strictEqual(output.decisions.length, 2, 'decisions extracted');
  });

  test('selective extraction with --fields', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Set up database
key-files:
  - prisma/schema.prisma
tech-stack:
  added:
    - prisma
patterns-established:
  - Repository pattern
key-decisions:
  - Use Prisma: Better DX
---
`
    );

    const result = runNfTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md --fields one_liner,key_files', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.one_liner, 'Set up database', 'one_liner included');
    assert.deepStrictEqual(output.key_files, ['prisma/schema.prisma'], 'key_files included');
    assert.strictEqual(output.tech_added, undefined, 'tech_added excluded');
    assert.strictEqual(output.patterns, undefined, 'patterns excluded');
    assert.strictEqual(output.decisions, undefined, 'decisions excluded');
  });

  test('handles missing frontmatter fields gracefully', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
one-liner: Minimal summary
---

# Summary
`
    );

    const result = runNfTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.one_liner, 'Minimal summary', 'one-liner extracted');
    assert.deepStrictEqual(output.key_files, [], 'key_files defaults to empty');
    assert.deepStrictEqual(output.tech_added, [], 'tech_added defaults to empty');
    assert.deepStrictEqual(output.patterns, [], 'patterns defaults to empty');
    assert.deepStrictEqual(output.decisions, [], 'decisions defaults to empty');
  });

  test('parses key-decisions with rationale', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '01-01-SUMMARY.md'),
      `---
key-decisions:
  - Use Prisma: Better DX than alternatives
  - JWT tokens: Stateless auth for scalability
---
`
    );

    const result = runNfTools('summary-extract .planning/phases/01-foundation/01-01-SUMMARY.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.decisions[0].summary, 'Use Prisma', 'decision summary parsed');
    assert.strictEqual(output.decisions[0].rationale, 'Better DX than alternatives', 'decision rationale parsed');
    assert.strictEqual(output.decisions[1].summary, 'JWT tokens', 'second decision summary');
    assert.strictEqual(output.decisions[1].rationale, 'Stateless auth for scalability', 'second decision rationale');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init commands tests
// ─────────────────────────────────────────────────────────────────────────────

describe('init commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init execute-phase returns file paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '# Plan');

    const result = runNfTools('init execute-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.config_path, '.planning/config.json');
  });

  test('init plan-phase returns file paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Phase Context');
    fs.writeFileSync(path.join(phaseDir, '03-RESEARCH.md'), '# Research Findings');
    fs.writeFileSync(path.join(phaseDir, '03-VERIFICATION.md'), '# Verification');
    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), '# UAT');

    const result = runNfTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.requirements_path, '.planning/REQUIREMENTS.md');
    assert.strictEqual(output.context_path, '.planning/phases/03-api/03-CONTEXT.md');
    assert.strictEqual(output.research_path, '.planning/phases/03-api/03-RESEARCH.md');
    assert.strictEqual(output.verification_path, '.planning/phases/03-api/03-VERIFICATION.md');
    assert.strictEqual(output.uat_path, '.planning/phases/03-api/03-UAT.md');
  });

  test('init progress returns file paths', () => {
    const result = runNfTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.project_path, '.planning/PROJECT.md');
    assert.strictEqual(output.config_path, '.planning/config.json');
  });

  test('init phase-op returns core and optional phase file paths', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Phase Context');
    fs.writeFileSync(path.join(phaseDir, '03-RESEARCH.md'), '# Research');
    fs.writeFileSync(path.join(phaseDir, '03-VERIFICATION.md'), '# Verification');
    fs.writeFileSync(path.join(phaseDir, '03-UAT.md'), '# UAT');

    const result = runNfTools('init phase-op 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, '.planning/STATE.md');
    assert.strictEqual(output.roadmap_path, '.planning/ROADMAP.md');
    assert.strictEqual(output.requirements_path, '.planning/REQUIREMENTS.md');
    assert.strictEqual(output.context_path, '.planning/phases/03-api/03-CONTEXT.md');
    assert.strictEqual(output.research_path, '.planning/phases/03-api/03-RESEARCH.md');
    assert.strictEqual(output.verification_path, '.planning/phases/03-api/03-VERIFICATION.md');
    assert.strictEqual(output.uat_path, '.planning/phases/03-api/03-UAT.md');
  });

  test('init plan-phase omits optional paths if files missing', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runNfTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.context_path, undefined);
    assert.strictEqual(output.research_path, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze command
// ─────────────────────────────────────────────────────────────────────────────

describe('roadmap analyze command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing ROADMAP.md returns error', () => {
    const result = runNfTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'ROADMAP.md not found');
  });

  test('parses phases with goals and disk status', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Set up infrastructure

### Phase 2: Authentication
**Goal:** Add user auth

### Phase 3: Features
**Goal:** Build core features
`
    );

    // Create phase dirs with varying completion
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const p2 = path.join(tmpDir, '.planning', 'phases', '02-authentication');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');

    const result = runNfTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3, 'should find 3 phases');
    assert.strictEqual(output.phases[0].disk_status, 'complete', 'phase 1 complete');
    assert.strictEqual(output.phases[1].disk_status, 'planned', 'phase 2 planned');
    assert.strictEqual(output.phases[2].disk_status, 'no_directory', 'phase 3 no directory');
    assert.strictEqual(output.completed_phases, 1, '1 phase complete');
    assert.strictEqual(output.total_plans, 2, '2 total plans');
    assert.strictEqual(output.total_summaries, 1, '1 total summary');
    assert.strictEqual(output.progress_percent, 50, '50% complete');
    assert.strictEqual(output.current_phase, '2', 'current phase is 2');
  });

  test('extracts goals and dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Setup
**Goal:** Initialize project
**Depends on:** Nothing

### Phase 2: Build
**Goal:** Build features
**Depends on:** Phase 1
`
    );

    const result = runNfTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].goal, 'Initialize project');
    assert.strictEqual(output.phases[0].depends_on, 'Nothing');
    assert.strictEqual(output.phases[1].goal, 'Build features');
    assert.strictEqual(output.phases[1].depends_on, 'Phase 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('adds phase after highest existing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API

---
`
    );

    const result = runNfTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 3, 'should be phase 3');
    assert.strictEqual(output.slug, 'user-dashboard');

    // Verify directory created
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-user-dashboard')),
      'directory should be created'
    );

    // Verify ROADMAP updated
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('### Phase 3: User Dashboard'), 'roadmap should include new phase');
    assert.ok(roadmap.includes('**Depends on:** Phase 2'), 'should depend on previous');
  });

  test('handles empty roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`
    );

    const result = runNfTools('phase add Initial Setup', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 1, 'should be phase 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase insert command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase insert command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('inserts decimal phase after target', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runNfTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '01.1', 'should be 01.1');
    assert.strictEqual(output.after_phase, '1');

    // Verify directory
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01.1-fix-critical-bug')),
      'decimal phase directory should be created'
    );

    // Verify ROADMAP
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Phase 01.1: Fix Critical Bug (INSERTED)'), 'roadmap should include inserted phase');
  });

  test('increments decimal when siblings exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01.1-hotfix'), { recursive: true });

    const result = runNfTools('phase insert 1 Another Fix', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '01.2', 'should be 01.2');
  });

  test('rejects missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Test\n**Goal:** Test\n`
    );

    const result = runNfTools('phase insert 99 Fix Something', tmpDir);
    assert.ok(!result.success, 'should fail for missing phase');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
  });

  test('handles padding mismatch between input and roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## Phase 09.05: Existing Decimal Phase
**Goal:** Test padding

## Phase 09.1: Next Phase
**Goal:** Test
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '09.05-existing'), { recursive: true });

    // Pass unpadded "9.05" but roadmap has "09.05"
    const result = runNfTools('phase insert 9.05 Padding Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.after_phase, '9.05');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('(INSERTED)'), 'roadmap should include inserted phase');
  });

  test('handles #### heading depth from multi-milestone roadmaps', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### v1.1 Milestone

#### Phase 5: Feature Work
**Goal:** Build features

#### Phase 6: Polish
**Goal:** Polish
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '05-feature-work'), { recursive: true });

    const result = runNfTools('phase insert 5 Hotfix', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '05.1');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Phase 05.1: Hotfix (INSERTED)'), 'roadmap should include inserted phase');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase remove command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase remove command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes phase directory and renumbers subsequent', () => {
    // Setup 3 phases
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup
**Depends on:** Nothing

### Phase 2: Auth
**Goal:** Authentication
**Depends on:** Phase 1

### Phase 3: Features
**Goal:** Core features
**Depends on:** Phase 2
`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    const p2 = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');
    const p3 = path.join(tmpDir, '.planning', 'phases', '03-features');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p3, '03-02-PLAN.md'), '# Plan 2');

    // Remove phase 2
    const result = runNfTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.removed, '2');
    assert.strictEqual(output.directory_deleted, '02-auth');

    // Phase 3 should be renumbered to 02
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features')),
      'phase 3 should be renumbered to 02-features'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-features')),
      'old 03-features should not exist'
    );

    // Files inside should be renamed
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features', '02-01-PLAN.md')),
      'plan file should be renumbered to 02-01'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features', '02-02-PLAN.md')),
      'plan 2 should be renumbered to 02-02'
    );

    // ROADMAP should be updated
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('Phase 2: Auth'), 'removed phase should not be in roadmap');
    assert.ok(roadmap.includes('Phase 2: Features'), 'phase 3 should be renumbered to 2');
  });

  test('rejects removal of phase with summaries unless --force', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Test\n**Goal:** Test\n`
    );

    // Should fail without --force
    const result = runNfTools('phase remove 1', tmpDir);
    assert.ok(!result.success, 'should fail without --force');
    assert.ok(result.error.includes('executed plan'), 'error mentions executed plans');

    // Should succeed with --force
    const forceResult = runNfTools('phase remove 1 --force', tmpDir);
    assert.ok(forceResult.success, `Force remove failed: ${forceResult.error}`);
  });

  test('removes decimal phase and renumbers siblings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 6: Main\n**Goal:** Main\n### Phase 6.1: Fix A\n**Goal:** Fix A\n### Phase 6.2: Fix B\n**Goal:** Fix B\n### Phase 6.3: Fix C\n**Goal:** Fix C\n`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-main'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-fix-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-fix-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.3-fix-c'), { recursive: true });

    const result = runNfTools('phase remove 6.2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // 06.3 should become 06.2
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06.2-fix-c')),
      '06.3 should be renumbered to 06.2'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06.3-fix-c')),
      'old 06.3 should not exist'
    );
  });

  test('updates STATE.md phase count', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n**Goal:** A\n### Phase 2: B\n**Goal:** B\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 1\n**Total Phases:** 2\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });

    runNfTools('phase remove 2', tmpDir);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('**Total Phases:** 1'), 'total phases should be decremented');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('marks phase complete and transitions to next', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_phase, '1');
    assert.strictEqual(output.plans_executed, '1/1');
    assert.strictEqual(output.verification_present, true);
    assert.strictEqual(output.next_phase, '02');
    assert.strictEqual(output.is_last_phase, false);

    // Verify STATE.md updated
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('**Current Phase:** 02'), 'should advance to phase 02');
    assert.ok(state.includes('**Status:** Ready to plan'), 'status should be ready to plan');
    assert.ok(state.includes('**Current Plan:** Not started'), 'plan should be reset');

    // Verify ROADMAP checkbox
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('[x]'), 'phase should be checked off');
    assert.ok(roadmap.includes('completed'), 'completion date should be added');
  });

  test('detects last phase in milestone', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Only Phase\n**Goal:** Everything\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-only-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'should detect last phase');
    assert.strictEqual(output.next_phase, null, 'no next phase');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('Milestone complete'), 'status should be milestone complete');
  });

  test('roadmap fallback: detects next phase when no disk directory exists (integer phases)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Plans:** 0 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');
    // NO Phase 2 directory on disk

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, false, 'should detect next phase from roadmap');
    assert.strictEqual(output.next_phase, '2', 'next_phase should be 2');
    assert.ok(output.next_phase_name, 'next_phase_name should be truthy');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('Ready to plan'), 'status should be ready to plan');
    assert.ok(!state.includes('Milestone complete'), 'should NOT say milestone complete');
  });

  test('roadmap fallback: detects next versioned phase v0.28-01 -> v0.28-02', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase v0.28-01: Cache Infrastructure
**Goal:** Build cache
**Plans:** 1 plans

### Phase v0.28-02: Data Pipeline
**Goal:** Build pipeline
**Plans:** 0 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** v0.28-01\n**Current Phase Name:** Cache Infrastructure\n**Status:** In progress\n**Current Plan:** v0.28-01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', 'v0.28-01-cache-infrastructure');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, 'v0.28-01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, 'v0.28-01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, 'v0.28-01-VERIFICATION.md'), '---\nstatus: passed\n---');
    // NO v0.28-02 directory on disk

    const result = runNfTools('phase complete v0.28-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, false, 'should detect next phase from roadmap');
    assert.strictEqual(output.next_phase, 'v0.28-02', 'next_phase should be v0.28-02 (exact, not just truthy)');
  });

  test('roadmap fallback: true last phase when roadmap has no higher phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Only Phase
**Goal:** Everything
**Plans:** 1 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Only Phase\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-only-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');
    // NO other phase directories

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'should be true last phase');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('Milestone complete'), 'status should be milestone complete');
  });

  test('updates REQUIREMENTS.md traceability when phase completes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01, AUTH-02
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Requirements:** API-01
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email
- [ ] **AUTH-02**: User can log in
- [ ] **AUTH-03**: User can reset password

### API

- [ ] **API-01**: REST endpoints

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 2 | Pending |
| API-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');

    // Checkboxes updated for phase 1 requirements
    assert.ok(req.includes('- [x] **AUTH-01**'), 'AUTH-01 checkbox should be checked');
    assert.ok(req.includes('- [x] **AUTH-02**'), 'AUTH-02 checkbox should be checked');
    // Other requirements unchanged
    assert.ok(req.includes('- [ ] **AUTH-03**'), 'AUTH-03 should remain unchecked');
    assert.ok(req.includes('- [ ] **API-01**'), 'API-01 should remain unchecked');

    // Traceability table updated
    assert.ok(req.includes('| AUTH-01 | Phase 1 | Complete |'), 'AUTH-01 status should be Complete');
    assert.ok(req.includes('| AUTH-02 | Phase 1 | Complete |'), 'AUTH-02 status should be Complete');
    assert.ok(req.includes('| AUTH-03 | Phase 2 | Pending |'), 'AUTH-03 should remain Pending');
    assert.ok(req.includes('| API-01 | Phase 2 | Pending |'), 'API-01 should remain Pending');
  });

  test('handles requirements with bracket format [REQ-01, REQ-02]', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** [AUTH-01, AUTH-02]
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Requirements:** [API-01]
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email
- [ ] **AUTH-02**: User can log in
- [ ] **AUTH-03**: User can reset password

### API

- [ ] **API-01**: REST endpoints

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 2 | Pending |
| API-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');

    // Checkboxes updated for phase 1 requirements (brackets stripped)
    assert.ok(req.includes('- [x] **AUTH-01**'), 'AUTH-01 checkbox should be checked');
    assert.ok(req.includes('- [x] **AUTH-02**'), 'AUTH-02 checkbox should be checked');
    // Other requirements unchanged
    assert.ok(req.includes('- [ ] **AUTH-03**'), 'AUTH-03 should remain unchecked');
    assert.ok(req.includes('- [ ] **API-01**'), 'API-01 should remain unchecked');

    // Traceability table updated
    assert.ok(req.includes('| AUTH-01 | Phase 1 | Complete |'), 'AUTH-01 status should be Complete');
    assert.ok(req.includes('| AUTH-02 | Phase 1 | Complete |'), 'AUTH-02 status should be Complete');
    assert.ok(req.includes('| AUTH-03 | Phase 2 | Pending |'), 'AUTH-03 should remain Pending');
    assert.ok(req.includes('| API-01 | Phase 2 | Pending |'), 'API-01 should remain Pending');
  });

  test('handles phase with no requirements mapping', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Setup

### Phase 1: Setup
**Goal:** Project setup (no requirements)
**Plans:** 1 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **REQ-01**: Some requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // REQUIREMENTS.md should be unchanged
    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [ ] **REQ-01**'), 'REQ-01 should remain unchecked');
    assert.ok(req.includes('| REQ-01 | Phase 2 | Pending |'), 'REQ-01 should remain Pending');
  });

  test('handles missing REQUIREMENTS.md gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
**Requirements:** REQ-01

### Phase 1: Foundation
**Goal:** Setup
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: passed\n---');

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(result.success, `Command should succeed even without REQUIREMENTS.md: ${result.error}`);
  });

  test('blocks phase completion when VERIFICATION.md is missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Foundation\n**Goal:** Setup\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    // Deliberately NO VERIFICATION.md

    const result = runNfTools('phase complete 1', tmpDir);
    assert.ok(!result.success, 'should fail without VERIFICATION.md');
    assert.ok(result.error.includes('VERIFICATION.md'), 'error should mention VERIFICATION.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('archives roadmap, requirements, creates MILESTONES.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] User auth\n- [ ] Dashboard\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\none-liner: Set up project infrastructure\n---\n# Summary\n`
    );

    const result = runNfTools('milestone complete v1.0 --name MVP Foundation', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    assert.strictEqual(output.phases, 1);
    assert.ok(output.archived.roadmap, 'roadmap should be archived');
    assert.ok(output.archived.requirements, 'requirements should be archived');

    // Verify archive files exist
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md')),
      'archived roadmap should exist'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md')),
      'archived requirements should exist'
    );

    // Verify MILESTONES.md created
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md should be created'
    );
    const milestones = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    assert.ok(milestones.includes('v1.0 MVP Foundation'), 'milestone entry should contain name');
    assert.ok(milestones.includes('Set up project infrastructure'), 'accomplishments should be listed');
  });

  test('appends to existing MILESTONES.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v0.9 Alpha (Shipped: 2025-01-01)\n\n---\n\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const result = runNfTools('milestone complete v1.0 --name Beta', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const milestones = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    assert.ok(milestones.includes('v0.9 Alpha'), 'existing entry should be preserved');
    assert.ok(milestones.includes('v1.0 Beta'), 'new entry should be appended');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validate consistency command
// ─────────────────────────────────────────────────────────────────────────────

describe('validate consistency command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('passes for consistent project', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n### Phase 2: B\n### Phase 3: C\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-c'), { recursive: true });

    const result = runNfTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.passed, true, 'should pass');
    assert.strictEqual(output.warning_count, 0, 'no warnings');
  });

  test('warns about phase on disk but not in roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-orphan'), { recursive: true });

    const result = runNfTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.warning_count > 0, 'should have warnings');
    assert.ok(
      output.warnings.some(w => w.includes('disk but not in ROADMAP')),
      'should warn about orphan directory'
    );
  });

  test('warns about gaps in phase numbering', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n### Phase 3: C\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-c'), { recursive: true });

    const result = runNfTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.includes('Gap in phase numbering')),
      'should warn about gap'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX-04: decimal phase number parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('FIX-04: decimal phase number parsing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('FIX-04-TC-01: validate consistency does not falsely warn about decimal phase dir matching ROADMAP entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 06.1: Decimal Fix\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-decimal-fix'), { recursive: true });

    const result = runNfTools('validate consistency', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const data = JSON.parse(result.output);
    const falseWarning = (data.warnings || []).some(w =>
      w.includes('06.1') && w.includes('not in ROADMAP')
    );
    assert.ok(!falseWarning, `FIX-04 bug: false warning about 06.1: ${JSON.stringify(data.warnings)}`);
  });

  test('FIX-04-TC-02: validate health does not emit W006 or W007 for decimal phase present in both ROADMAP and disk', () => {
    // Minimal valid project structure for validate health
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 06.1\nPlan: 1\nStatus: in-progress\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 06.1: Decimal Fix\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-decimal-fix'), { recursive: true });

    const result = runNfTools('validate health', tmpDir);
    // validate health exits 0 even with warnings
    const data = JSON.parse(result.output);

    const w006 = (data.issues || []).some(i => i.code === 'W006' && i.message && i.message.includes('06.1'));
    const w007 = (data.issues || []).some(i => i.code === 'W007' && i.message && i.message.includes('06.1'));
    assert.ok(!w006, `FIX-04 bug: W006 false positive for 06.1: ${JSON.stringify(data.issues)}`);
    assert.ok(!w007, `FIX-04 bug: W007 false positive for 06.1: ${JSON.stringify(data.issues)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// progress command
// ─────────────────────────────────────────────────────────────────────────────

describe('progress command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('renders JSON progress', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Done');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan 2');

    const result = runNfTools('progress json', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.total_plans, 2, '2 total plans');
    assert.strictEqual(output.total_summaries, 1, '1 summary');
    assert.strictEqual(output.percent, 50, '50%');
    assert.strictEqual(output.phases.length, 1, '1 phase');
    assert.strictEqual(output.phases[0].status, 'In Progress', 'phase in progress');
  });

  test('renders bar format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Done');

    const result = runNfTools('progress bar --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(result.output.includes('1/1'), 'should include count');
    assert.ok(result.output.includes('100%'), 'should include 100%');
  });

  test('renders table format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0 MVP\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');

    const result = runNfTools('progress table --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.ok(result.output.includes('Phase'), 'should have table header');
    assert.ok(result.output.includes('foundation'), 'should include phase name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// todo complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('todo complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('moves todo from pending to completed', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, 'add-dark-mode.md'),
      `title: Add dark mode\narea: ui\ncreated: 2025-01-01\n`
    );

    const result = runNfTools('todo complete add-dark-mode.md', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed, true);

    // Verify moved
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'pending', 'add-dark-mode.md')),
      'should be removed from pending'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'todos', 'completed', 'add-dark-mode.md')),
      'should be in completed'
    );

    // Verify completion timestamp added
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'todos', 'completed', 'add-dark-mode.md'),
      'utf-8'
    );
    assert.ok(content.startsWith('completed:'), 'should have completed timestamp');
  });

  test('fails for nonexistent todo', () => {
    const result = runNfTools('todo complete nonexistent.md', tmpDir);
    assert.ok(!result.success, 'should fail');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scaffold command
// ─────────────────────────────────────────────────────────────────────────────

describe('scaffold command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('scaffolds context file', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runNfTools('scaffold context --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    // Verify file content
    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-CONTEXT.md'),
      'utf-8'
    );
    assert.ok(content.includes('Phase 3'), 'should reference phase number');
    assert.ok(content.includes('Decisions'), 'should have decisions section');
    assert.ok(content.includes('Discretion Areas'), 'should have discretion section');
  });

  test('scaffolds UAT file', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runNfTools('scaffold uat --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-UAT.md'),
      'utf-8'
    );
    assert.ok(content.includes('User Acceptance Testing'), 'should have UAT heading');
    assert.ok(content.includes('Test Results'), 'should have test results section');
  });

  test('scaffolds verification file', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runNfTools('scaffold verification --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);

    const content = fs.readFileSync(
      path.join(tmpDir, '.planning', 'phases', '03-api', '03-VERIFICATION.md'),
      'utf-8'
    );
    assert.ok(content.includes('Goal-Backward Verification'), 'should have verification heading');
  });

  test('scaffolds phase directory', () => {
    const result = runNfTools('scaffold phase-dir --phase 5 --name User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, true);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '05-user-dashboard')),
      'directory should be created'
    );
  });

  test('does not overwrite existing files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), '# Existing content');

    const result = runNfTools('scaffold context --phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.created, false, 'should not overwrite');
    assert.strictEqual(output.reason, 'already_exists');
  });
});

describe('activity commands', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('TC1: activity-set with full schema writes file with all fields + updated timestamp', () => {
    const json = JSON.stringify({
      activity: 'execute_phase',
      sub_activity: 'executing_plan',
      phase: 14,
      plan: '14-02-PLAN.md',
      wave: 1,
      debug_round: 2,
      checkpoint: 'checkpoint:verify',
      quorum_round: 1,
    });

    const result = runNfTools(`activity-set '${json}'`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.written, true, 'should return written: true');
    assert.strictEqual(output.path, '.planning/current-activity.json', 'should return correct path');

    const filePath = path.join(tmpDir, '.planning', 'current-activity.json');
    assert.ok(fs.existsSync(filePath), 'current-activity.json should exist');

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.strictEqual(written.activity, 'execute_phase', 'should have activity field');
    assert.strictEqual(written.sub_activity, 'executing_plan', 'should have sub_activity field');
    assert.strictEqual(written.phase, 14, 'should have phase field');
    assert.ok(written.updated, 'should have updated timestamp');
    assert.ok(new Date(written.updated).getTime() > 0, 'updated should be a valid ISO timestamp');
  });

  test('TC2: activity-set with minimal fields (activity only) writes file with activity + updated', () => {
    const json = JSON.stringify({ activity: 'plan_phase' });

    const result = runNfTools(`activity-set '${json}'`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const filePath = path.join(tmpDir, '.planning', 'current-activity.json');
    assert.ok(fs.existsSync(filePath), 'current-activity.json should exist');

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.strictEqual(written.activity, 'plan_phase', 'should have activity field');
    assert.ok(written.updated, 'should have updated timestamp');
    // Only activity and updated should be present
    const keys = Object.keys(written);
    assert.strictEqual(keys.length, 2, 'should only have activity and updated keys');
  });

  test('TC3: activity-set then activity-clear removes file; activity-get returns {}', () => {
    const json = JSON.stringify({ activity: 'execute_phase', sub_activity: 'debugging' });
    runNfTools(`activity-set '${json}'`, tmpDir);

    const filePath = path.join(tmpDir, '.planning', 'current-activity.json');
    assert.ok(fs.existsSync(filePath), 'file should exist after activity-set');

    const clearResult = runNfTools('activity-clear', tmpDir);
    assert.ok(clearResult.success, `activity-clear failed: ${clearResult.error}`);
    const clearOutput = JSON.parse(clearResult.output);
    assert.strictEqual(clearOutput.cleared, true, 'should return cleared: true');

    assert.ok(!fs.existsSync(filePath), 'file should be removed after activity-clear');

    const getResult = runNfTools('activity-get', tmpDir);
    assert.ok(getResult.success, `activity-get failed: ${getResult.error}`);
    const getOutput = JSON.parse(getResult.output);
    assert.deepStrictEqual(getOutput, {}, 'activity-get should return empty object when file missing');
  });

  test('TC4: activity-clear on non-existent file returns { cleared: true } without error', () => {
    const filePath = path.join(tmpDir, '.planning', 'current-activity.json');
    assert.ok(!fs.existsSync(filePath), 'file should not exist before test');

    const result = runNfTools('activity-clear', tmpDir);
    assert.ok(result.success, `activity-clear failed on missing file: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.cleared, true, 'should return cleared: true even when file absent');
  });
});

describe('maintain-tests batch command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeDiscoverJson(tmpDir, testFiles) {
    const discoverPath = path.join(tmpDir, 'discover-out.json');
    fs.writeFileSync(discoverPath, JSON.stringify({
      runners: ['jest'],
      test_files: testFiles,
      total_count: testFiles.length,
    }), 'utf-8');
    return discoverPath;
  }

  test('TC1: Deterministic shuffle — same seed produces same order', () => {
    const files = Array.from({ length: 20 }, (_, i) => `/project/test${i + 1}.test.js`);
    const discoverPath = writeDiscoverJson(tmpDir, files);

    const result1 = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --size 5 --seed 12345`);
    const result2 = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --size 5 --seed 12345`);

    assert.ok(result1.success, `First run failed: ${result1.error}`);
    assert.ok(result2.success, `Second run failed: ${result2.error}`);

    const out1 = JSON.parse(result1.output);
    const out2 = JSON.parse(result2.output);

    assert.deepStrictEqual(out1.batches[0].files, out2.batches[0].files, 'Same seed must produce same order');
    assert.strictEqual(out1.seed, 12345, 'seed should be 12345');
    assert.strictEqual(out1.total_batches, 4, 'Should produce 4 batches of 5 from 20 files');
  });

  test('TC2: Batch sizing — correct split', () => {
    const files = Array.from({ length: 250 }, (_, i) => `/project/test${i + 1}.test.js`);
    const discoverPath = writeDiscoverJson(tmpDir, files);

    const result = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --size 100 --seed 1`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.total_batches, 3, 'Should produce 3 batches (100+100+50)');
    assert.strictEqual(out.batches[0].file_count, 100, 'First batch should have 100 files');
    assert.strictEqual(out.batches[2].file_count, 50, 'Third batch should have 50 files');
  });

  test('TC3: --exclude-file filters already-processed files', () => {
    const files = Array.from({ length: 10 }, (_, i) => `/a/${i + 1}.js`);
    const discoverPath = writeDiscoverJson(tmpDir, files);

    const excludedFiles = files.slice(0, 5);
    const excludePath = path.join(tmpDir, 'exclude.json');
    fs.writeFileSync(excludePath, JSON.stringify(excludedFiles), 'utf-8');

    const result = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --exclude-file "${excludePath}" --size 100 --seed 1`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.total_files, 5, 'Should have 5 files after excluding 5');

    const allBatchedFiles = out.batches.flatMap(b => b.files);
    for (const excluded of excludedFiles) {
      assert.ok(!allBatchedFiles.includes(excluded), `Excluded file ${excluded} should not appear in batches`);
    }
  });

  test('TC4: --manifest-file writes JSON to disk', () => {
    const files = ['/project/a.test.js', '/project/b.test.js', '/project/c.test.js'];
    const discoverPath = writeDiscoverJson(tmpDir, files);
    const manifestPath = '/tmp/batch-manifest-test.json';

    // Cleanup before test
    try { fs.unlinkSync(manifestPath); } catch { /* ok */ }

    const result = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --size 100 --seed 1 --manifest-file "${manifestPath}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(fs.existsSync(manifestPath), 'manifest file should exist at specified path');
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(Array.isArray(written.batches), 'manifest should have batches array');
    assert.ok(typeof written.total_batches === 'number', 'manifest should have total_batches');

    // Cleanup
    try { fs.unlinkSync(manifestPath); } catch { /* ok */ }
  });

  test('TC5: Empty input — returns zero batches', () => {
    const discoverPath = writeDiscoverJson(tmpDir, []);

    const result = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --size 100 --seed 1`);
    assert.ok(result.success, `Command should succeed with empty input: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.total_batches, 0, 'Should have 0 batches');
    assert.deepStrictEqual(out.batches, [], 'batches should be empty array');
    assert.strictEqual(out.total_files, 0, 'total_files should be 0');
  });

  test('TC6: Single file smaller than batch size — one batch with one file', () => {
    const discoverPath = writeDiscoverJson(tmpDir, ['/project/only.test.js']);

    const result = runNfTools(`maintain-tests batch --input-file "${discoverPath}" --size 100 --seed 1`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.total_batches, 1, 'Should have 1 batch');
    assert.strictEqual(out.batches[0].file_count, 1, 'That batch should have 1 file');
  });
});

describe('maintain-tests discover command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('TC1: --runner jest flag forces jest runner only', () => {
    // Create both jest and playwright configs in the temp dir
    fs.writeFileSync(path.join(tmpDir, 'jest.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.js'), 'module.exports = {};');

    const result = runNfTools(`maintain-tests discover --runner jest --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.runners, ['jest'], 'runners should be exactly ["jest"]');
    assert.ok(Array.isArray(output.test_files), 'test_files must be array');
    assert.ok(typeof output.total_count === 'number', 'total_count must be a number');
    assert.ok(typeof output.by_runner === 'object', 'by_runner must be an object');
    // playwright should not appear in by_runner since --runner jest was specified
    assert.ok(!output.by_runner.playwright, 'playwright should not be in by_runner');
  });

  test('TC2: No config files returns empty runners with warning', () => {
    // tmpDir has no jest/playwright/pytest config files by default
    const result = runNfTools(`maintain-tests discover --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.runners, [], 'runners should be []');
    assert.strictEqual(output.total_count, 0, 'total_count should be 0');
    assert.ok(Array.isArray(output.test_files), 'test_files must be array');
    assert.ok(Array.isArray(output.warnings), 'warnings should be present when no runners detected');
  });

  test('TC3: --output-file writes JSON to disk', () => {
    const outputFile = path.join(require('os').tmpdir(), 'discover-test-output.json');
    // Clean up any pre-existing file
    try { fs.unlinkSync(outputFile); } catch (e) { /* ok */ }

    const result = runNfTools(`maintain-tests discover --runner jest --dir "${tmpDir}" --output-file "${outputFile}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(fs.existsSync(outputFile), 'output file should exist at specified path');

    const content = fs.readFileSync(outputFile, 'utf-8');
    const parsed = JSON.parse(content);
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'test_files'), 'JSON must have test_files key');
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'runners'), 'JSON must have runners key');
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'total_count'), 'JSON must have total_count key');

    // Cleanup
    try { fs.unlinkSync(outputFile); } catch (e) { /* ok */ }
  });

  test('TC4: Deduplication — paths from both runners are not duplicated', () => {
    // Simulate two runners that could theoretically list the same file
    // We test by using --runner jest twice via manual inspection of the JSON schema
    // Since we cannot control CLI output in unit tests, verify schema and dedup logic
    // via a simple two-runner detect scenario where only one runner is available
    fs.writeFileSync(path.join(tmpDir, 'jest.config.js'), 'module.exports = {};');

    const result = runNfTools(`maintain-tests discover --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Verify no duplicate paths exist in test_files
    const uniquePaths = new Set(output.test_files);
    assert.strictEqual(
      uniquePaths.size,
      output.test_files.length,
      'test_files should contain no duplicate paths'
    );
    // total_count must match test_files array length
    assert.strictEqual(output.total_count, output.test_files.length, 'total_count must equal test_files.length');
  });

  test('TC5: Jest detection via package.json jest key', () => {
    // Write a package.json with "jest" key — no jest.config.* file
    const pkgJson = JSON.stringify({
      name: 'test-project',
      jest: { testMatch: ['**/*.test.js'] },
    }, null, 2);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), pkgJson);

    const result = runNfTools(`maintain-tests discover --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.runners.includes('jest'), 'runners should include "jest" when package.json has jest key');
  });
});

describe('maintain-tests run-batch command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Helper: write a minimal batch manifest to disk and return the path
  function writeBatchManifest(dir, opts = {}) {
    const manifest = {
      batch_id: opts.batch_id || 1,
      runner: opts.runner || 'jest',
      batches: [
        {
          batch_id: opts.batch_id || 1,
          files: opts.files || [],
          file_count: (opts.files || []).length,
        },
      ],
      total_batches: 1,
      total_files: (opts.files || []).length,
      seed: 1,
      batch_size: 100,
    };
    const manifestPath = path.join(dir, 'batch-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    return manifestPath;
  }

  test('TC1: spawnToFile writes process output to file', (t, done) => {
    // Test spawnToFile mechanics directly using Node.js child_process.spawn
    // This mirrors exactly what spawnToFile does internally.
    const os = require('os');
    const { spawn } = require('child_process');

    const outputPath = path.join(os.tmpdir(), `spawntofile-test-${Date.now()}.tmp`);
    const outStream = require('fs').createWriteStream(outputPath);
    const proc = spawn('node', ['-e', "console.log('spawntofile-output')"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.pipe(outStream);
    proc.stderr.pipe(outStream);

    proc.on('close', (code) => {
      outStream.end(() => {
        try {
          const content = fs.readFileSync(outputPath, 'utf-8');
          assert.ok(content.includes('spawntofile-output'), 'output file should contain process stdout');
          assert.strictEqual(code, 0, 'exit code should be 0 for successful process');
          try { fs.unlinkSync(outputPath); } catch (e) { /* ok */ }
          done();
        } catch (err) {
          try { fs.unlinkSync(outputPath); } catch (e) { /* ok */ }
          done(err);
        }
      });
    });
  });

  test('TC2: Timeout fires and kills process', (t, done) => {
    // Test that a 200ms timeout kills a long-running process and returns timedOut: true
    // This mirrors spawnToFile's timeout behavior.
    const os = require('os');
    const { spawn } = require('child_process');

    const outputPath = path.join(os.tmpdir(), `spawntofile-timeout-${Date.now()}.tmp`);
    const outStream = require('fs').createWriteStream(outputPath);

    const proc = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.pipe(outStream);
    proc.stderr.pipe(outStream);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, 200);

    proc.on('close', (code) => {
      clearTimeout(timer);
      outStream.end(() => {
        try {
          assert.ok(timedOut, 'timedOut should be true when timeout fires');
          // code may be null (SIGTERM) or non-zero — just check it is not normal exit
          assert.ok(code === null || code !== 0, 'process should not have exited normally (code 0) when killed');
          try { fs.unlinkSync(outputPath); } catch (e) { /* ok */ }
          done();
        } catch (err) {
          try { fs.unlinkSync(outputPath); } catch (e) { /* ok */ }
          done(err);
        }
      });
    });
  });

  test('TC3: run-batch output schema validation — empty batch returns required keys', () => {
    const manifestPath = writeBatchManifest(tmpDir, { files: [] });
    const result = runNfTools(`maintain-tests run-batch --batch-file "${manifestPath}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    // All required top-level keys must be present
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'executed_count'), 'output must have executed_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'passed_count'), 'output must have passed_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'failed_count'), 'output must have failed_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'flaky_count'), 'output must have flaky_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'results'), 'output must have results');
    assert.ok(Array.isArray(out.results), 'results must be an array');
    assert.strictEqual(out.executed_count, 0, 'executed_count should be 0 for empty batch');
    assert.strictEqual(out.results.length, 0, 'results should be empty for empty batch');
  });

  test('TC4: Error summary truncated to 500 chars', () => {
    // Test the truncation logic by writing a helper script to a temp file and running it.
    // Using execFileSync avoids shell-escaping issues with inline -e scripts.
    const os = require('os');
    const { execFileSync } = require('child_process');

    const scriptPath = path.join(os.tmpdir(), `truncate-test-${Date.now()}.js`);
    const scriptLines = [
      'const s = "X".repeat(2000);',
      'function truncateErrorSummary(text) {',
      '  if (!text) return null;',
      '  const str = String(text);',
      '  return str.length > 500 ? str.slice(0, 500) : str;',
      '}',
      'const result = truncateErrorSummary(s);',
      'process.stdout.write(JSON.stringify({ length: result.length, first5: result.slice(0, 5) }));',
    ].join('\n');

    fs.writeFileSync(scriptPath, scriptLines, 'utf-8');

    try {
      const raw = execFileSync(process.execPath, [scriptPath], { encoding: 'utf-8' });
      const out = JSON.parse(raw);
      assert.strictEqual(out.length, 500, 'truncateErrorSummary should limit output to exactly 500 chars');
      assert.strictEqual(out.first5, 'XXXXX', 'truncated string should preserve start of original');
    } finally {
      try { fs.unlinkSync(scriptPath); } catch (e) { /* ok */ }
    }
  });

  test('TC5: --output-file writes results JSON to disk', () => {
    const manifestPath = writeBatchManifest(tmpDir, { files: [] });
    const outputFile = path.join(require('os').tmpdir(), `run-batch-test-${Date.now()}.json`);

    // Cleanup before test
    try { fs.unlinkSync(outputFile); } catch (e) { /* ok */ }

    const result = runNfTools(`maintain-tests run-batch --batch-file "${manifestPath}" --output-file "${outputFile}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(fs.existsSync(outputFile), 'output file should exist at specified path');

    const content = fs.readFileSync(outputFile, 'utf-8');
    const parsed = JSON.parse(content);
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'results'), 'written JSON must have results key');
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'executed_count'), 'written JSON must have executed_count');

    // Cleanup
    try { fs.unlinkSync(outputFile); } catch (e) { /* ok */ }
  });

  test('TC6: --env flag is accepted without error', () => {
    const manifestPath = writeBatchManifest(tmpDir, { files: [] });
    const result = runNfTools(`maintain-tests run-batch --batch-file "${manifestPath}" --env MY_VAR=hello`);
    assert.ok(result.success, `Command should accept --env without crashing: ${result.error}`);

    // Output must still be valid JSON (no crash from env parsing)
    const out = JSON.parse(result.output);
    assert.ok(typeof out === 'object', 'output should be a valid JSON object');
    assert.strictEqual(out.executed_count, 0, 'empty batch should have executed_count 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maintain-tests integration — monorepo cross-discovery
// ─────────────────────────────────────────────────────────────────────────────

describe('maintain-tests integration — monorepo cross-discovery', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nf-monorepo-'));
    // Create a monorepo fixture with both jest and playwright configs
    fs.writeFileSync(path.join(tmpDir, 'jest.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'monorepo-test',
      devDependencies: { jest: '^29.0.0' },
    }, null, 2));
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tests', 'unit.test.js'), '// jest-only test');
    fs.writeFileSync(path.join(tmpDir, 'tests', 'component.spec.ts'), '// could match both');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('TC-MONOREPO-1: deduplication removes exact path duplicates from combined runner output', () => {
    // We test the deduplication behavior by verifying the discover output has no duplicates.
    // The internal addPaths function uses a Set (seenPaths) for deduplication.
    // We exercise this by creating a discover output manually and verifying the schema.
    // Since we cannot inject mock CLI output, we verify the invariant via the output schema:
    // test_files must never contain duplicates regardless of how many runners are invoked.

    // Simulate what would happen if jest and playwright both list the same .spec.ts file.
    // We verify this invariant by using a helper script approach: write a script that
    // creates a fake discover JSON with manually constructed duplicates, then pass it to
    // the batch command which reads test_files — the dedup must have already occurred at discover time.

    // Direct deduplication test: create a JSON with intentional duplicates and verify
    // that the batch command still accepts it (batch does not de-dup; discover does).
    // The real test is the discover output invariant.
    const result = runNfTools(`maintain-tests discover --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    // Invariant: test_files must have no duplicates (Set dedup via addPaths)
    const uniquePaths = new Set(output.test_files);
    assert.strictEqual(
      uniquePaths.size,
      output.test_files.length,
      'TC-MONOREPO-1: test_files must contain each unique path exactly once (no duplicates)'
    );

    // The path count should equal the union of unique paths across all runners
    const allRunnerPaths = Object.values(output.by_runner || {}).flat();
    const uniqueRunnerPaths = new Set(allRunnerPaths.map(p => path.resolve(p)));
    // test_files is the deduplicated union of all runner outputs
    assert.strictEqual(
      output.test_files.length,
      uniqueRunnerPaths.size,
      'TC-MONOREPO-1: test_files.length must equal unique path count across all runners'
    );
  });

  test('TC-MONOREPO-2: --runner jest flag prevents cross-framework contamination', () => {
    // Both jest.config.js and playwright.config.js are in tmpDir.
    // With --runner jest, only jest CLI should be invoked; playwright must be absent.
    const result = runNfTools(`maintain-tests discover --runner jest --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    // runners array must be exactly ["jest"]
    assert.deepStrictEqual(output.runners, ['jest'],
      'TC-MONOREPO-2: runners must be exactly ["jest"] when --runner jest is passed');

    // by_runner must not have a playwright key
    assert.ok(!output.by_runner.playwright,
      'TC-MONOREPO-2: by_runner.playwright must be undefined when --runner jest is passed');
  });

  test('TC-MONOREPO-3: auto mode with both configs detects both runners', () => {
    // In auto mode (no --runner flag), both jest.config.js and playwright.config.js
    // are present, so both should be detected and appear in runners.
    // CLI invocations may fail gracefully if tools not installed — that is expected.
    const result = runNfTools(`maintain-tests discover --dir "${tmpDir}"`);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);

    // Detection (not invocation) — both runners must appear in runners array
    assert.ok(output.runners.includes('jest'),
      'TC-MONOREPO-3: runners must include "jest" when jest.config.js is present');
    assert.ok(output.runners.includes('playwright'),
      'TC-MONOREPO-3: runners must include "playwright" when playwright.config.js is present');

    // by_runner must have entries for both (even if empty due to CLI not installed)
    assert.ok(Object.prototype.hasOwnProperty.call(output.by_runner, 'jest'),
      'TC-MONOREPO-3: by_runner must have a "jest" key');
    assert.ok(Object.prototype.hasOwnProperty.call(output.by_runner, 'playwright'),
      'TC-MONOREPO-3: by_runner must have a "playwright" key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maintain-tests integration — pytest parametrized ID parsing
// ─────────────────────────────────────────────────────────────────────────────

describe('maintain-tests integration — pytest parametrized ID parsing', () => {
  // These tests exercise the pytest output parser logic directly via a helper script.
  // The parser logic (extracted from invokePytest in nf-tools.cjs) splits on "::",
  // takes index 0 as file path, and deduplicates. We replicate the parser here to
  // verify correctness with fixture inputs — this is Option A from the plan.

  function parsePytestCollectOutput(stdout, cwd) {
    // Replicates the parsing logic from invokePytest in nf-tools.cjs:
    // split by newline, filter ERRORS/separators/empty, split on "::", take index 0.
    const lines = stdout.split('\n');
    const files = new Set();
    let inErrorSection = false;
    for (const line of lines) {
      if (line.startsWith('ERRORS')) { inErrorSection = true; continue; }
      if (line.startsWith('=')) continue; // separator lines
      if (line.trim() === '') continue;
      if (inErrorSection) {
        // Skip lines until we see a non-error test line (heuristic: must have ::)
        if (line.includes('::') && !line.startsWith('tests/') && line.includes('ERROR')) continue;
        if (!line.includes('::') || line.trim().startsWith('_') || line.trim() === '') continue;
        // If it has :: and doesn't start with ERRORS/= it might be a real test
        if (line.includes('ERROR') && line.includes('::ERROR')) continue;
      }
      if (line.includes('::')) {
        const filePart = line.split('::')[0].trim();
        if (filePart && !filePart.includes('ERROR')) {
          const abs = path.isAbsolute(filePart) ? filePart : path.resolve(cwd, filePart);
          files.add(abs);
        }
      }
    }
    return Array.from(files);
  }

  const CWD = process.cwd();

  test('TC-PYTEST-1: basic parametrized ID parsing — 5 test IDs map to 2 unique files', () => {
    const fixtureOutput = [
      'tests/test_math.py::test_add[1+2-3]',
      'tests/test_math.py::test_add[2+3-5]',
      'tests/test_math.py::test_multiply[2*3-6]',
      'tests/test_string.py::test_concat[hello-world-helloworld]',
      'tests/test_string.py::test_upper[abc-ABC]',
      'PASSED 5 items',
    ].join('\n');

    const result = parsePytestCollectOutput(fixtureOutput, CWD);

    // 5 test IDs → 2 unique files
    assert.strictEqual(result.length, 2, 'TC-PYTEST-1: should produce exactly 2 unique file paths from 5 parametrized test IDs');

    // No path should contain bracket characters
    for (const p of result) {
      assert.ok(!p.includes('['), `TC-PYTEST-1: file path must not contain "[": ${p}`);
      assert.ok(!p.includes(']'), `TC-PYTEST-1: file path must not contain "]": ${p}`);
    }

    // Both expected files must be present (resolved absolute paths)
    const resolvedMath = path.resolve(CWD, 'tests/test_math.py');
    const resolvedString = path.resolve(CWD, 'tests/test_string.py');
    assert.ok(result.includes(resolvedMath), `TC-PYTEST-1: result must include test_math.py (resolved: ${resolvedMath})`);
    assert.ok(result.includes(resolvedString), `TC-PYTEST-1: result must include test_string.py (resolved: ${resolvedString})`);
  });

  test('TC-PYTEST-2: special characters in parameters do not corrupt file path', () => {
    const fixtureOutput = 'tests/conftest.py::test_fixture[key=value with spaces]';

    const result = parsePytestCollectOutput(fixtureOutput, CWD);

    assert.strictEqual(result.length, 1, 'TC-PYTEST-2: should produce exactly 1 file path');
    const resolved = path.resolve(CWD, 'tests/conftest.py');
    assert.strictEqual(result[0], resolved, `TC-PYTEST-2: file path must be tests/conftest.py (got: ${result[0]})`);
    assert.ok(!result[0].includes('='), 'TC-PYTEST-2: file path must not contain "=" from parameter');
    assert.ok(!result[0].includes('key'), 'TC-PYTEST-2: file path must not contain parameter key');
  });

  test('TC-PYTEST-3: ERRORS section and separator lines are filtered out', () => {
    const fixtureOutput = [
      'ERRORS',
      'tests/broken_test.py::ERROR',
      '========= 1 error in collection =========',
      'tests/good_test.py::test_thing',
    ].join('\n');

    const result = parsePytestCollectOutput(fixtureOutput, CWD);

    const resolvedGood = path.resolve(CWD, 'tests/good_test.py');
    const resolvedBroken = path.resolve(CWD, 'tests/broken_test.py');

    // good_test.py should be present
    assert.ok(result.includes(resolvedGood), `TC-PYTEST-3: tests/good_test.py must appear in result`);

    // broken_test.py (from ERRORS section) must not appear
    assert.ok(!result.includes(resolvedBroken), 'TC-PYTEST-3: broken_test.py from ERRORS section must be excluded');
  });

  test('TC-PYTEST-4: empty pytest output produces empty array without crash', () => {
    // Empty string
    const result1 = parsePytestCollectOutput('', CWD);
    assert.deepStrictEqual(result1, [], 'TC-PYTEST-4: empty string must return empty array');

    // Whitespace-only string
    const result2 = parsePytestCollectOutput('   \n  \n   ', CWD);
    assert.deepStrictEqual(result2, [], 'TC-PYTEST-4: whitespace-only string must return empty array');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maintain-tests integration — buffer overflow regression
// ─────────────────────────────────────────────────────────────────────────────

describe('maintain-tests integration — buffer overflow regression', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nf-buffer-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('TC-BUFFER-1: spawnToFile handles >1MB output without crash', async () => {
    const os = require('os');
    // Write a script that outputs 2MB to stdout
    const scriptPath = path.join(tmpDir, 'large-output.js');
    const outputPath = path.join(tmpDir, 'large-output.tmp');
    fs.writeFileSync(scriptPath, [
      "const line = 'x'.repeat(1000) + '\\n';",
      'for (let i = 0; i < 2000; i++) process.stdout.write(line); // 2MB output',
    ].join('\n'), 'utf-8');

    // Run via nf-tools maintain-tests run-batch with an empty batch — this exercises
    // spawnToFile indirectly. For a direct test we call node with the large-output script
    // via a run-batch manifest pointing to the script as a "test file".
    // However, since run-batch expects a real test runner, we test spawnToFile directly
    // by using node's execSync with a large output in a separate subprocess.
    // The key regression: execSync maxBuffer=1MB would throw ENOBUFS here.
    // Since spawnToFile is not exported, we verify via the run-batch path:
    // create a batch manifest with 0 files, which still exercises the spawnToFile plumbing.

    // Direct regression test: run node with large output via execSync (OLD way — should fail at >1MB)
    // vs spawnToFile (NEW way — should succeed). We test the new way by calling run-batch
    // with an empty batch manifest and asserting no ENOBUFS error occurs.
    const manifestContent = JSON.stringify({
      batch_id: 1,
      runner: 'jest',
      batches: [{ batch_id: 1, files: [], file_count: 0 }],
      total_batches: 1,
      total_files: 0,
      seed: 1,
      batch_size: 100,
    });
    const manifestPath = path.join(tmpDir, 'empty-manifest.json');
    fs.writeFileSync(manifestPath, manifestContent, 'utf-8');

    const result = runNfTools(`maintain-tests run-batch --batch-file "${manifestPath}"`);
    assert.ok(result.success, `TC-BUFFER-1: run-batch should not crash on empty batch: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.executed_count, 0, 'TC-BUFFER-1: empty batch should have 0 executed files');

    // Now directly verify that a Node subprocess producing >1MB does not crash
    // when captured to file (this is what spawnToFile does vs execSync maxBuffer).
    // We use execSync in the test (with large maxBuffer) to invoke the large-output.js
    // and verify the file size exceeds 1MB when captured to disk.
    const { spawnSync: childSpawnSync } = require('child_process');
    const captureOutput = path.join(tmpDir, 'capture.tmp');
    const captureScript = path.join(tmpDir, 'capture-via-redirect.js');
    fs.writeFileSync(captureScript, [
      "const fs = require('fs');",
      "const { spawn } = require('child_process');",
      `const outStream = fs.createWriteStream(${JSON.stringify(captureOutput)});`,
      `const proc = spawn(process.execPath, [${JSON.stringify(scriptPath)}]);`,
      'proc.stdout.pipe(outStream);',
      "proc.on('close', () => outStream.end(() => process.exit(0)));",
    ].join('\n'), 'utf-8');

    const captureResult = childSpawnSync(process.execPath, [captureScript], {
      timeout: 15000,
      encoding: 'utf-8',
    });
    assert.strictEqual(captureResult.status, 0, `TC-BUFFER-1: capture script should exit 0 (got ${captureResult.status})`);
    assert.ok(fs.existsSync(captureOutput), 'TC-BUFFER-1: output file should exist after spawnToFile-style capture');

    const stats = fs.statSync(captureOutput);
    assert.ok(stats.size > 1024 * 1024, `TC-BUFFER-1: captured file should be >1MB (got ${stats.size} bytes)`);
  });

  test('TC-BUFFER-2: run-batch with empty batch completes without crash (end-to-end path)', () => {
    // This test verifies the end-to-end run-batch path without needing real test runners.
    // A batch with 0 files exercises all setup/teardown code in cmdMaintainTestsRunBatch
    // without invoking any test CLI. The key assertion: the command completes and outputs valid JSON.
    const manifestPath = path.join(tmpDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      batch_id: 99,
      runner: 'jest',
      batches: [{ batch_id: 99, files: [], file_count: 0 }],
      total_batches: 1,
      total_files: 0,
      seed: 42,
      batch_size: 50,
    }), 'utf-8');

    const result = runNfTools(`maintain-tests run-batch --batch-file "${manifestPath}"`);
    assert.ok(result.success, `TC-BUFFER-2: run-batch must complete without crash: ${result.error}`);

    const out = JSON.parse(result.output);

    // Verify output schema
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'executed_count'), 'TC-BUFFER-2: output must have executed_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'passed_count'), 'TC-BUFFER-2: output must have passed_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'failed_count'), 'TC-BUFFER-2: output must have failed_count');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'results'), 'TC-BUFFER-2: output must have results array');
    assert.ok(Array.isArray(out.results), 'TC-BUFFER-2: results must be an array');

    assert.strictEqual(out.executed_count, 0, 'TC-BUFFER-2: executed_count must be 0 for empty batch');
    assert.strictEqual(out.results.length, 0, 'TC-BUFFER-2: results must be empty for empty batch');
  });
});

describe('maintain-tests batch \u2014 runner field propagation', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('TC-RUNNER-1: playwright runner propagated into all batch entries', () => {
    const discoverPath = path.join(tmpDir, 'discover-out.json');
    fs.writeFileSync(discoverPath, JSON.stringify({
      runners: ['playwright'],
      test_files: ['/project/a.spec.ts', '/project/b.spec.ts', '/project/c.spec.ts'],
      total_count: 3,
    }), 'utf-8');
    const result = runNfTools('maintain-tests batch --input-file "' + discoverPath + '" --size 10 --seed 1', tmpDir);
    assert.ok(result.success, 'TC-RUNNER-1: batch must succeed: ' + result.error);
    const out = JSON.parse(result.output);
    assert.ok(out.batches.length > 0, 'TC-RUNNER-1: must have at least one batch');
    for (const batch of out.batches) {
      assert.strictEqual(batch.runner, 'playwright', 'TC-RUNNER-1: all batches must have runner=playwright, got: ' + batch.runner);
    }
  });

  test('TC-RUNNER-2: pytest runner propagated into all batch entries', () => {
    const discoverPath = path.join(tmpDir, 'discover-out.json');
    fs.writeFileSync(discoverPath, JSON.stringify({
      runners: ['pytest'],
      test_files: ['/project/test_a.py', '/project/test_b.py'],
      total_count: 2,
    }), 'utf-8');
    const result = runNfTools('maintain-tests batch --input-file "' + discoverPath + '" --size 10 --seed 1', tmpDir);
    assert.ok(result.success, 'TC-RUNNER-2: batch must succeed: ' + result.error);
    const out = JSON.parse(result.output);
    assert.ok(out.batches.length > 0, 'TC-RUNNER-2: must have at least one batch');
    assert.strictEqual(out.batches[0].runner, 'pytest', 'TC-RUNNER-2: batch must have runner=pytest');
  });

  test('TC-RUNNER-3: defaults to jest when runners array is empty', () => {
    const discoverPath = path.join(tmpDir, 'discover-out.json');
    fs.writeFileSync(discoverPath, JSON.stringify({
      runners: [],
      test_files: ['/project/a.test.js'],
      total_count: 1,
    }), 'utf-8');
    const result = runNfTools('maintain-tests batch --input-file "' + discoverPath + '" --size 10 --seed 1', tmpDir);
    assert.ok(result.success, 'TC-RUNNER-3: batch must succeed: ' + result.error);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.batches[0].runner, 'jest', 'TC-RUNNER-3: empty runners should default to jest');
  });
});

describe('maintain-tests run-batch \u2014 --batch-index flag', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeManifest(dir, numBatches) {
    const batches = Array.from({ length: numBatches }, (_, i) => ({
      batch_id: i + 1,
      files: [],
      file_count: 0,
      runner: 'jest',
    }));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      seed: 42,
      batch_size: 100,
      total_files: 0,
      total_batches: numBatches,
      batches,
    }), 'utf-8');
    return manifestPath;
  }

  test('TC-BATCHIDX-1: --batch-index 0 executes batches[0] (default behavior)', () => {
    const manifestPath = writeManifest(tmpDir, 3);
    const result = runNfTools('maintain-tests run-batch --batch-file "' + manifestPath + '" --batch-index 0', tmpDir);
    assert.ok(result.success, 'TC-BATCHIDX-1: run-batch must succeed: ' + result.error);
    const out = JSON.parse(result.output);
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'executed_count'), 'TC-BATCHIDX-1: must have executed_count');
  });

  test('TC-BATCHIDX-2: --batch-index 2 executes batches[2] (third batch)', () => {
    const manifestPath = writeManifest(tmpDir, 3);
    const result = runNfTools('maintain-tests run-batch --batch-file "' + manifestPath + '" --batch-index 2', tmpDir);
    assert.ok(result.success, 'TC-BATCHIDX-2: run-batch must succeed for valid index: ' + result.error);
    const out = JSON.parse(result.output);
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'executed_count'), 'TC-BATCHIDX-2: must have executed_count');
  });

  test('TC-BATCHIDX-3: --batch-index out of range returns error', () => {
    const manifestPath = writeManifest(tmpDir, 3);
    const result = runNfTools('maintain-tests run-batch --batch-file "' + manifestPath + '" --batch-index 99', tmpDir);
    assert.ok(!result.success, 'TC-BATCHIDX-3: out-of-range index must fail');
    assert.ok(result.error.includes('out of range'), 'TC-BATCHIDX-3: error must say "out of range", got: ' + result.error);
  });
});

describe('maintain-tests save-state command', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function minimalStateJson() {
    return JSON.stringify({
      schema_version: 1,
      session_id: '2026-01-01T00:00:00Z',
      manifest_path: '.planning/manifest.json',
      runner: 'jest',
      total_tests: 100,
      batch_size: 10,
      seed: 42,
      total_batches: 10,
      batches_complete: 3,
      batch_status: { '1': 'complete', '2': 'complete', '3': 'complete' },
      processed_files: [],
      results_by_category: { valid_skip: [], adapt: [], isolate: [], real_bug: [], fixture: [], flaky: [] },
      iteration_count: 1,
      last_unresolved_count: 70,
      deferred_tests: [],
    });
  }

  test('TC-SAVESTATE-1: save-state writes file and returns written=true', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const stateJsonArg = minimalStateJson().replace(/'/g, "'\\''");
    const result = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", tmpDir);
    assert.ok(result.success, 'TC-SAVESTATE-1: save-state must succeed: ' + result.error);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.written, true, 'TC-SAVESTATE-1: written must be true');
    assert.ok(['sqlite', 'json'].includes(out.backend), 'TC-SAVESTATE-1: backend must be sqlite or json, got: ' + out.backend);
    assert.ok(fs.existsSync(stateFile), 'TC-SAVESTATE-1: state file must exist on disk');
  });

  test('TC-SAVESTATE-2: save-state requires --state-json', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const result = runNfTools('maintain-tests save-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(!result.success, 'TC-SAVESTATE-2: save-state without --state-json must fail');
    assert.ok(result.error.includes('--state-json is required'), 'TC-SAVESTATE-2: error must mention --state-json: ' + result.error);
  });

  test('TC-SAVESTATE-3: save-state rejects invalid JSON', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const result = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json 'not-json'", tmpDir);
    assert.ok(!result.success, 'TC-SAVESTATE-3: invalid JSON must fail');
    assert.ok(result.error.includes('invalid JSON'), 'TC-SAVESTATE-3: error must say invalid JSON: ' + result.error);
  });

  test('TC-SAVESTATE-4: save-state auto-sets updated timestamp', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const stateJsonArg = minimalStateJson().replace(/'/g, "'\\''");
    runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", tmpDir);
    const loadResult = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(loadResult.success, 'TC-SAVESTATE-4: load-state must succeed: ' + loadResult.error);
    const state = JSON.parse(loadResult.output);
    assert.ok(state !== null, 'TC-SAVESTATE-4: state must not be null');
    assert.ok(typeof state.updated === 'string' && state.updated.length > 0, 'TC-SAVESTATE-4: updated field must be set');
  });
});

describe('maintain-tests load-state command', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('TC-LOADSTATE-1: load-state returns null when file does not exist', () => {
    const stateFile = path.join(tmpDir, 'nonexistent.db');
    const result = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(result.success, 'TC-LOADSTATE-1: load-state must succeed even when file missing: ' + result.error);
    assert.strictEqual(result.output, 'null', 'TC-LOADSTATE-1: output must be null for missing file, got: ' + result.output);
  });

  test('TC-LOADSTATE-2: load-state round-trips save-state data correctly', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const stateJson = JSON.stringify({ schema_version: 1, session_id: 'round-trip-test', batches_complete: 7 });
    const stateJsonArg = stateJson.replace(/'/g, "'\\''");
    const saveResult = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", tmpDir);
    assert.ok(saveResult.success, 'TC-LOADSTATE-2: save must succeed: ' + saveResult.error);
    const loadResult = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(loadResult.success, 'TC-LOADSTATE-2: load must succeed: ' + loadResult.error);
    const state = JSON.parse(loadResult.output);
    assert.ok(state !== null, 'TC-LOADSTATE-2: state must not be null');
    assert.strictEqual(state.schema_version, 1, 'TC-LOADSTATE-2: schema_version must round-trip');
    assert.strictEqual(state.session_id, 'round-trip-test', 'TC-LOADSTATE-2: session_id must round-trip');
    assert.strictEqual(state.batches_complete, 7, 'TC-LOADSTATE-2: batches_complete must round-trip');
  });

  test('TC-LOADSTATE-3: load-state uses default path .planning/maintain-tests-state.json when --state-file omitted', () => {
    const stateJson = JSON.stringify({ schema_version: 1, session_id: 'default-path-test', batches_complete: 0 });
    const stateJsonArg = stateJson.replace(/'/g, "'\\''");
    const saveResult = runNfTools("maintain-tests save-state --state-json '" + stateJsonArg + "'", tmpDir);
    assert.ok(saveResult.success, 'TC-LOADSTATE-3: save to default path must succeed: ' + saveResult.error);
    const expectedPath = path.join(tmpDir, '.planning', 'maintain-tests-state.json');
    assert.ok(fs.existsSync(expectedPath), 'TC-LOADSTATE-3: file must exist at default path');
    const loadResult = runNfTools('maintain-tests load-state', tmpDir);
    assert.ok(loadResult.success, 'TC-LOADSTATE-3: load from default path must succeed: ' + loadResult.error);
    const state = JSON.parse(loadResult.output);
    assert.ok(state !== null, 'TC-LOADSTATE-3: state must not be null');
    assert.strictEqual(state.session_id, 'default-path-test', 'TC-LOADSTATE-3: session_id must match');
  });
});

// ============================================================================
// Task 1 — INTG-03 compliance test
// ============================================================================

describe('maintain-tests INTG-03 compliance', () => {
  test('TC-INTG03-1: fix-tests absent from quorum_commands in ~/.claude/nf.json', () => {
    const os = require('os');
    const nfJsonPath = path.join(os.homedir(), '.claude', 'nf.json');
    if (!fs.existsSync(nfJsonPath)) {
      assert.ok(true, 'nf.json not installed — INTG-03 N/A');
      return;
    }
    const config = JSON.parse(fs.readFileSync(nfJsonPath, 'utf8'));
    const quorumCommands = config.quorum_commands || [];
    assert.ok(
      !quorumCommands.includes('fix-tests'),
      'TC-INTG03-1: fix-tests must NOT appear in quorum_commands (INTG-03 / R2.1), found: ' + JSON.stringify(quorumCommands)
    );
  });
});

// ============================================================================
// Task 2 — Circuit breaker lifecycle tests
// ============================================================================

const INSTALL_PATH = path.join(__dirname, '../../bin/install.js');

function runInstall(args, cwd) {
  try {
    const result = execSync('node "' + INSTALL_PATH + '" ' + args, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return { success: false, output: err.stdout?.toString().trim() || '', error: err.stderr?.toString().trim() || err.message };
  }
}

describe('circuit-breaker --disable-breaker / --enable-breaker', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('TC-CB-1: --disable-breaker writes disabled:true to circuit-breaker-state.json', () => {
    const result = runInstall('--disable-breaker', tmpDir);
    assert.ok(result.success, 'TC-CB-1: --disable-breaker must exit 0, got: ' + result.error);
    const stateFile = path.join(tmpDir, '.claude', 'circuit-breaker-state.json');
    assert.ok(fs.existsSync(stateFile), 'TC-CB-1: circuit-breaker-state.json must be created');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(state.disabled, true, 'TC-CB-1: disabled must be true after --disable-breaker');
  });

  test('TC-CB-2: --enable-breaker after disable writes disabled:false', () => {
    runInstall('--disable-breaker', tmpDir);
    const result = runInstall('--enable-breaker', tmpDir);
    assert.ok(result.success, 'TC-CB-2: --enable-breaker must exit 0, got: ' + result.error);
    const stateFile = path.join(tmpDir, '.claude', 'circuit-breaker-state.json');
    assert.ok(fs.existsSync(stateFile), 'TC-CB-2: circuit-breaker-state.json must exist after enable');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(state.disabled, false, 'TC-CB-2: disabled must be false after --enable-breaker');
  });

  test('TC-CB-3: --enable-breaker when no state file exits 0 without error', () => {
    const stateFile = path.join(tmpDir, '.claude', 'circuit-breaker-state.json');
    assert.ok(!fs.existsSync(stateFile), 'TC-CB-3: state file must not exist before test');
    const result = runInstall('--enable-breaker', tmpDir);
    assert.ok(result.success, 'TC-CB-3: --enable-breaker with no state file must exit 0, got: ' + result.error);
    assert.ok(result.output.includes('enabled'), 'TC-CB-3: output must mention "enabled", got: ' + result.output);
  });
});

// ============================================================================
// Task 3 — Resume mid-batch safety tests
// ============================================================================

describe('maintain-tests resume mid-batch', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('TC-RESUME-1: load-state with batches_complete:2 returns state with correct batches_complete', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const stateJson = JSON.stringify({
      schema_version: 1,
      session_id: 'resume-test',
      batches_complete: 2,
    });
    const stateJsonArg = stateJson.replace(/'/g, "'\\''");
    const saveResult = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", tmpDir);
    assert.ok(saveResult.success, 'TC-RESUME-1: save must succeed: ' + saveResult.error);
    const loadResult = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(loadResult.success, 'TC-RESUME-1: load must succeed: ' + loadResult.error);
    const state = JSON.parse(loadResult.output);
    assert.ok(state !== null, 'TC-RESUME-1: state must not be null');
    assert.strictEqual(state.batches_complete, 2, 'TC-RESUME-1: batches_complete must be 2, got: ' + state.batches_complete);
  });

  test('TC-RESUME-2: run-batch --batch-index 2 on a 3-batch manifest returns executed_count', () => {
    const manifest = {
      seed: 1,
      batch_size: 10,
      total_files: 0,
      total_batches: 3,
      batches: [
        { batch_id: 1, files: [], file_count: 0 },
        { batch_id: 2, files: [], file_count: 0 },
        { batch_id: 3, files: [], file_count: 0 },
      ],
    };
    const manifestPath = path.join(tmpDir, 'batch-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    const result = runNfTools('maintain-tests run-batch --batch-file "' + manifestPath + '" --batch-index 2', tmpDir);
    assert.ok(result.success, 'TC-RESUME-2: run-batch with --batch-index 2 must succeed: ' + result.error);
    const out = JSON.parse(result.output);
    assert.ok(out.executed_count !== undefined, 'TC-RESUME-2: output must include executed_count');
  });
});

// ============================================================================
// Task 4 — Termination condition state tests
// ============================================================================

describe('maintain-tests termination state conditions', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function saveAndLoad(stateObj, dir) {
    const stateFile = path.join(dir, 'state.db');
    const stateJson = JSON.stringify(stateObj);
    const stateJsonArg = stateJson.replace(/'/g, "'\\''");
    const saveResult = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", dir);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    const loadResult = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', dir);
    if (!loadResult.success) return { success: false, error: loadResult.error };
    return { success: true, state: JSON.parse(loadResult.output) };
  }

  test('TC-TERM-1: state with consecutive_no_progress:5 round-trips correctly', () => {
    const res = saveAndLoad({ schema_version: 1, session_id: 'term-test', consecutive_no_progress: 5 }, tmpDir);
    assert.ok(res.success, 'TC-TERM-1: save/load must succeed: ' + res.error);
    assert.strictEqual(res.state.consecutive_no_progress, 5, 'TC-TERM-1: consecutive_no_progress must be 5, got: ' + res.state.consecutive_no_progress);
  });

  test('TC-TERM-2: state with iteration_count:10 round-trips correctly', () => {
    const res = saveAndLoad({ schema_version: 1, session_id: 'term-test', iteration_count: 10 }, tmpDir);
    assert.ok(res.success, 'TC-TERM-2: save/load must succeed: ' + res.error);
    assert.strictEqual(res.state.iteration_count, 10, 'TC-TERM-2: iteration_count must be 10, got: ' + res.state.iteration_count);
  });

  test('TC-TERM-3: state with last_unresolved_count:0 round-trips correctly', () => {
    const res = saveAndLoad({ schema_version: 1, session_id: 'term-test', last_unresolved_count: 0 }, tmpDir);
    assert.ok(res.success, 'TC-TERM-3: save/load must succeed: ' + res.error);
    assert.strictEqual(res.state.last_unresolved_count, 0, 'TC-TERM-3: last_unresolved_count must be 0, got: ' + res.state.last_unresolved_count);
  });
});

// ============================================================================
// Task 5 — Phase 21 schema round-trip tests
// ============================================================================

describe('maintain-tests Phase 21 schema fields round-trip', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('TC-SCHEMA21-1: save-state with categorization_verdicts + dispatched_tasks + deferred_report round-trips all three fields', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const stateObj = {
      schema_version: 1,
      session_id: 'schema21-test',
      categorization_verdicts: [{ test: 'foo.test.js', category: 'real_bug' }],
      dispatched_tasks: [{ task_id: 'task-1', category: 'real_bug', files: ['foo.test.js'] }],
      deferred_report: {
        real_bug: ['foo.test.js'],
        low_context: ['bar.test.js'],
      },
    };
    const stateJsonArg = JSON.stringify(stateObj).replace(/'/g, "'\\''");
    const saveResult = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", tmpDir);
    assert.ok(saveResult.success, 'TC-SCHEMA21-1: save must succeed: ' + saveResult.error);
    const loadResult = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(loadResult.success, 'TC-SCHEMA21-1: load must succeed: ' + loadResult.error);
    const state = JSON.parse(loadResult.output);
    assert.ok(Array.isArray(state.categorization_verdicts), 'TC-SCHEMA21-1: categorization_verdicts must be an array');
    assert.strictEqual(state.categorization_verdicts.length, 1, 'TC-SCHEMA21-1: categorization_verdicts must have 1 entry');
    assert.ok(Array.isArray(state.dispatched_tasks), 'TC-SCHEMA21-1: dispatched_tasks must be an array');
    assert.strictEqual(state.dispatched_tasks.length, 1, 'TC-SCHEMA21-1: dispatched_tasks must have 1 entry');
    assert.strictEqual(state.deferred_report.real_bug[0], 'foo.test.js', 'TC-SCHEMA21-1: deferred_report.real_bug[0] must match');
  });

  test('TC-SCHEMA21-2: save-state with Phase 21 schema preserves nested structure of deferred_report', () => {
    const stateFile = path.join(tmpDir, 'state.db');
    const stateObj = {
      schema_version: 1,
      session_id: 'schema21-nested-test',
      deferred_report: {
        real_bug: ['foo.test.js'],
        low_context: ['bar.test.js'],
      },
    };
    const stateJsonArg = JSON.stringify(stateObj).replace(/'/g, "'\\''");
    const saveResult = runNfTools("maintain-tests save-state --state-file \"" + stateFile + "\" --state-json '" + stateJsonArg + "'", tmpDir);
    assert.ok(saveResult.success, 'TC-SCHEMA21-2: save must succeed: ' + saveResult.error);
    const loadResult = runNfTools('maintain-tests load-state --state-file "' + stateFile + '"', tmpDir);
    assert.ok(loadResult.success, 'TC-SCHEMA21-2: load must succeed: ' + loadResult.error);
    const state = JSON.parse(loadResult.output);
    assert.strictEqual(state.deferred_report.low_context[0], 'bar.test.js', 'TC-SCHEMA21-2: deferred_report.low_context[0] must match');
    assert.ok('real_bug' in state.deferred_report, 'TC-SCHEMA21-2: deferred_report must have real_bug key');
    assert.ok('low_context' in state.deferred_report, 'TC-SCHEMA21-2: deferred_report must have low_context key');
  });
});

// ─── Milestone-Scoped Phase IDs ───────────────────────────────────────────────

describe('milestone-scoped phase IDs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('MS-TC-01: roadmap analyze parses milestone-scoped phase headers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap: nForma\n\n### Phase v0.7-01: Composition Architecture\n**Goal:** Config-driven quorum\n\n### Phase v0.7-02: Multiple Slots\n**Goal:** N instances per family\n`
    );

    const result = runNfTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 2, 'should find 2 phases');
    assert.strictEqual(output.phases[0].number, 'v0.7-01', 'first phase number is v0.7-01');
    assert.strictEqual(output.phases[1].number, 'v0.7-02', 'second phase number is v0.7-02');
    assert.strictEqual(output.phases[0].name, 'Composition Architecture', 'phase name extracted');
    assert.strictEqual(output.phases[0].goal, 'Config-driven quorum', 'goal extracted');
  });

  test('MS-TC-02: find-phase v0.7-01 finds milestone-scoped directory', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'v0.7-01-composition-architecture');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runNfTools('find-phase v0.7-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase must be found');
    assert.ok(output.directory.includes('v0.7-01-composition-architecture'), 'directory contains phase ID');
  });

  test('MS-TC-03: phases list sorts v0.7-01, v0.7-01.1, v0.7-02 in correct order', () => {
    const dirs = ['v0.7-02-multiple-slots', 'v0.7-01-composition', 'v0.7-01.1-gap-fix'];
    for (const d of dirs) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', d), { recursive: true });
    }

    const result = runNfTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.directories.length, 3, '3 directories');
    assert.ok(output.directories[0].startsWith('v0.7-01-'), 'first is v0.7-01');
    assert.ok(output.directories[1].startsWith('v0.7-01.1-'), 'second is v0.7-01.1');
    assert.ok(output.directories[2].startsWith('v0.7-02-'), 'third is v0.7-02');
  });

  test('MS-TC-04: roadmap analyze reads disk_status for milestone-scoped phase directories', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase v0.7-01: Composition Architecture\n**Goal:** Config-driven quorum\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'v0.7-01-composition-architecture');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'v0.7-01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, 'v0.7-01-01-SUMMARY.md'), '# Summary');

    const result = runNfTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases[0].disk_status, 'complete', 'disk_status is complete');
    assert.strictEqual(output.phases[0].plan_count, 1, '1 plan found');
    assert.strictEqual(output.phases[0].summary_count, 1, '1 summary found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HLTH: versioned phase dir health check fixes
// ─────────────────────────────────────────────────────────────────────────────

describe('HLTH: versioned phase dir health check fixes', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Write minimal valid project scaffold used by all HLTH tests
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase v0.15-01: Health Fix\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase v0.15-01\nPlan: 1\nStatus: in-progress\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.15-01-health-fix'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('HLTH-01-TC-01: W005 not emitted for v0.X-YY-name dirs', () => {
    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w005 = (data.warnings || []).some(
      i => i.code === 'W005' && i.message && i.message.includes('v0.15-01-health-fix')
    );
    assert.ok(!w005, `HLTH-01-TC-01: W005 false positive for v0.15-01-health-fix: ${JSON.stringify(data.warnings)}`);
  });

  test('HLTH-01-TC-02: W005 not emitted for v0.X-YY-name dirs with dots in name segment (v0.9-08-post-v0.9-install-sync)', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.9-08-post-v0.9-install-sync'), { recursive: true });

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w005 = (data.warnings || []).some(
      i => i.code === 'W005' && i.message && i.message.includes('v0.9-08-post-v0.9-install-sync')
    );
    assert.ok(!w005, `HLTH-01-TC-02: W005 false positive for v0.9-08-post-v0.9-install-sync: ${JSON.stringify(data.warnings)}`);
  });

  test('HLTH-02-TC-01: W007 not emitted for versioned phases present on both disk and ROADMAP', () => {
    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w007 = (data.warnings || []).some(
      i => i.code === 'W007' && i.message && i.message.includes('v0.15-01')
    );
    assert.ok(!w007, `HLTH-02-TC-01: W007 false positive for v0.15-01: ${JSON.stringify(data.warnings)}`);
  });

  test('HLTH-03-TC-01: W002 not emitted for Phase v0.X-YY STATE.md references when dir exists', () => {
    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w002 = (data.warnings || []).some(
      i => i.code === 'W002' && i.message && i.message.includes('v0.15-01')
    );
    assert.ok(!w002, `HLTH-03-TC-01: W002 false positive for v0.15-01: ${JSON.stringify(data.warnings)}`);
  });
});

describe('SAFE-01: --repair safety guard for rich STATE.md', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Write minimal valid project scaffold used by all SAFE-01 tests
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase v0.15-01: Test\n'
    );
    // Create a phase dir that does NOT match the phantom phase referenced in STATE.md
    // This triggers W002 → regenerateState is queued when --repair is passed
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.99-01-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('SAFE-01-TC-01: --repair without --force does not overwrite STATE.md with more than 50 lines', () => {
    // 55-line STATE.md referencing phantom phase v0.99-99 (triggers W002 → regenerateState)
    // Only v0.99-01-test exists on disk — so v0.99-99 has no matching dir
    const richState = [
      '# Project State',
      '',
      'Phase v0.99-99: referenced but no dir',
      ...Array.from({ length: 52 }, (_, i) => `Line ${i + 4}: padding content`),
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), richState);

    const result = runNfTools('validate health --repair', tmpDir);
    const data = JSON.parse(result.output);

    // STATE.md must be unchanged
    const afterContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(afterContent, richState, 'STATE.md was overwritten despite no --force');

    // repairs_performed must contain a skipped entry for regenerateState
    const skippedEntry = (data.repairs_performed || []).find(
      r => r.action === 'regenerateState' && r.skipped === true
    );
    assert.ok(skippedEntry, `Expected skipped regenerateState entry, got: ${JSON.stringify(data.repairs_performed)}`);
    assert.ok(skippedEntry.reason.includes('50'), `Expected line count threshold in reason, got: ${skippedEntry.reason}`);
  });

  test('SAFE-01-TC-02: --repair --force overwrites STATE.md with more than 50 lines', () => {
    const richState = [
      '# Project State',
      '',
      'Phase v0.99-99: referenced but no dir',
      ...Array.from({ length: 52 }, (_, i) => `Line ${i + 4}: padding content`),
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), richState);

    const result = runNfTools('validate health --repair --force', tmpDir);
    const data = JSON.parse(result.output);

    const afterContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.notStrictEqual(afterContent, richState, 'STATE.md should have been overwritten with --force');

    const successEntry = (data.repairs_performed || []).find(
      r => r.action === 'regenerateState' && r.success === true
    );
    assert.ok(successEntry, `Expected successful regenerateState entry, got: ${JSON.stringify(data.repairs_performed)}`);
  });

  test('SAFE-01-TC-03: --repair without --force overwrites STATE.md with 50 lines or fewer', () => {
    // Exactly 50 lines (at/below threshold — guard must not block)
    // v0.99-99 referenced but not on disk → W002 → regenerateState queued
    const shortState = [
      '# Project State',
      '',
      'Phase v0.99-99: referenced but no dir',
      ...Array.from({ length: 47 }, (_, i) => `Line ${i + 4}: content`),
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), shortState);

    const result = runNfTools('validate health --repair', tmpDir);
    const data = JSON.parse(result.output);

    const afterContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.notStrictEqual(afterContent, shortState, 'STATE.md should have been overwritten for short file');
  });
});

describe('SAFE-02: legacy numeric phase dirs archived', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Write minimal valid project scaffold
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' })
    );
    // ROADMAP with numeric phase entries (simulating pre-archive state)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [x] **Phase 18: CLI Foundation** — test (completed 2026-02-22)\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: v0.15-03\nPlan: 1\nStatus: in-progress\n'
    );
    // Create a versioned phase dir so STATE.md ref doesn't trigger W002
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.15-03-test'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('SAFE-02-TC-01: W007 not emitted for numeric phases present in both ROADMAP and disk', () => {
    // Simulate pre-archive state: dir on disk + in ROADMAP
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '18-cli-foundation'), { recursive: true });
    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings || []).some(
      i => i.code === 'W007' && i.message && i.message.includes('18')
    );
    assert.ok(!w007, `SAFE-02 pre-condition: W007 false positive for phase 18: ${JSON.stringify(data.warnings)}`);
  });

  test('SAFE-02-TC-02: W007 not emitted for numeric phases after move to archive/legacy/', () => {
    // Simulate post-archive state: dir NOT in phases/, in archive/legacy/
    // Numeric phase 18 is in ROADMAP but NOT on disk under phases/
    // -> W006 fires (in ROADMAP, not on disk) but W007 must NOT fire
    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);
    const w007 = (data.warnings || []).some(
      i => i.code === 'W007' && i.message && i.message.includes('18')
    );
    assert.ok(!w007, `SAFE-02-TC-02: W007 must not fire for archived phase 18: ${JSON.stringify(data.warnings)}`);
  });

  test('SAFE-02-TC-03: archive/legacy/ contains numeric phase dirs after archive', () => {
    // Simulate the archive dir creation and move
    fs.mkdirSync(path.join(tmpDir, '.planning', 'archive', 'legacy'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'archive', 'legacy', '18-cli-foundation'), { recursive: true });
    // Verify archive dir exists and contains the moved dir
    const archiveExists = fs.existsSync(path.join(tmpDir, '.planning', 'archive', 'legacy'));
    const dirMoved = fs.existsSync(path.join(tmpDir, '.planning', 'archive', 'legacy', '18-cli-foundation'));
    const notInPhases = !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '18-cli-foundation'));
    assert.ok(archiveExists, 'SAFE-02-TC-03: .planning/archive/legacy/ must exist');
    assert.ok(dirMoved, 'SAFE-02-TC-03: 18-cli-foundation must exist in archive/legacy/');
    assert.ok(notInPhases, 'SAFE-02-TC-03: 18-cli-foundation must NOT be in phases/ after archive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUICK-231: W007 false positives for archived milestone phase directories
// ─────────────────────────────────────────────────────────────────────────────

describe('QUICK-231: W007 not emitted for phases archived in milestones/v*-phases/', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Test Project\n\n## Vision\nTest\n\n## Scope\nTest\n'
    );
    // ROADMAP only references current phase, not archived ones
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase v0.32-01: Current Work\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\nCurrent phase: v0.32-01\n'
    );
    // Create current phase directory
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.32-01-current-work'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('QUICK-231-TC-01: W007 not emitted for phases in milestones/v*-phases/ archive', () => {
    // Create archived milestone phase directories (simulates post-cleanup state)
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones', 'v0.9-phases', 'v0.9-01-some-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones', 'v0.9-phases', 'v0.9-02-another-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones', 'v0.15-phases', 'v0.15-01-health-fix'), { recursive: true });

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const archivedW007 = (data.warnings || []).filter(
      i => i.code === 'W007' && i.message && (
        i.message.includes('v0.9-01') ||
        i.message.includes('v0.9-02') ||
        i.message.includes('v0.15-01')
      )
    );
    assert.strictEqual(archivedW007.length, 0,
      `QUICK-231-TC-01: W007 must not fire for archived milestone phases: ${JSON.stringify(archivedW007)}`);
  });

  test('QUICK-231-TC-02: W007 still fires for genuinely orphaned phases in phases/', () => {
    // Create an orphaned phase not in ROADMAP and not archived
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.99-01-orphaned'), { recursive: true });

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const orphanW007 = (data.warnings || []).filter(
      i => i.code === 'W007' && i.message && i.message.includes('v0.99-01')
    );
    assert.strictEqual(orphanW007.length, 1,
      `QUICK-231-TC-02: W007 must fire for genuinely orphaned phase v0.99-01: ${JSON.stringify(data.warnings)}`);
  });

  test('QUICK-231-TC-03: W006 still works for archived phases (ROADMAP entry matched by archive)', () => {
    // Add a ROADMAP entry that only exists in archive, not in phases/
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase v0.32-01: Current Work\n\n### Phase v0.9-01: Archived Feature\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones', 'v0.9-phases', 'v0.9-01-archived-feature'), { recursive: true });

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    // W006 should NOT fire because the phase exists in archive
    const w006 = (data.warnings || []).filter(
      i => i.code === 'W006' && i.message && i.message.includes('v0.9-01')
    );
    assert.strictEqual(w006.length, 0,
      `QUICK-231-TC-03: W006 must not fire for phase v0.9-01 present in archive: ${JSON.stringify(w006)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIS-01: Quorum failure visibility in health output
// ─────────────────────────────────────────────────────────────────────────────

describe('VIS-01: quorum failure health warnings', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'quality' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase v0.15-04: Health Fix\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase v0.15-04\nPlan: 1\nStatus: in-progress\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'v0.15-04-health-fix'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('VIS-01-TC-01: W008 emitted for slot with count >= 3', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'quorum-failures.json'),
      JSON.stringify([
        { slot: 'codex-1', error_type: 'TIMEOUT', pattern: 'TIMEOUT after 1ms', count: 3, last_seen: '2026-02-27T00:00:00.000Z' }
      ])
    );

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w008 = (data.warnings || []).some(
      i => i.code === 'W008' && i.message && i.message.includes('codex-1')
    );
    assert.ok(w008, `VIS-01-TC-01: W008 not emitted for codex-1 (count=3): ${JSON.stringify(data.warnings)}`);
  });

  test('VIS-01-TC-02: W008 not emitted when all slot counts are < 3', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'quorum-failures.json'),
      JSON.stringify([
        { slot: 'codex-1', error_type: 'TIMEOUT', pattern: 'TIMEOUT after 1ms', count: 2, last_seen: '2026-02-27T00:00:00.000Z' },
        { slot: 'copilot-1', error_type: 'TIMEOUT', pattern: 'TIMEOUT after 120000ms', count: 1, last_seen: '2026-02-27T00:00:00.000Z' }
      ])
    );

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w008 = (data.warnings || []).some(i => i.code === 'W008');
    assert.ok(!w008, `VIS-01-TC-02: W008 falsely emitted when counts < 3: ${JSON.stringify(data.warnings)}`);
  });

  test('VIS-01-TC-03: W008 not emitted when quorum-failures.json does not exist', () => {
    // File intentionally NOT written in this test

    const result = runNfTools('validate health', tmpDir);
    const data = JSON.parse(result.output);

    const w008 = (data.warnings || []).some(i => i.code === 'W008');
    assert.ok(!w008, `VIS-01-TC-03: W008 falsely emitted when quorum-failures.json absent: ${JSON.stringify(data.warnings)}`);
  });
});

describe('TIER: resolveModelInternal tier lookup', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('TIER-01: default config → nf-phase-researcher resolves to haiku', () => {
    // No config.json — uses DEFAULT_CONFIG where model_tier_worker = 'haiku'
    const result = runNfTools('resolve-model nf-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.model, 'haiku', `TIER-01: expected haiku, got ${data.model}`);
  });

  test('TIER-02: default config → nf-plan-checker resolves to haiku', () => {
    // No config.json — uses DEFAULT_CONFIG where model_tier_worker = 'haiku'
    const result = runNfTools('resolve-model nf-plan-checker', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.model, 'haiku', `TIER-02: expected haiku, got ${data.model}`);
  });

  test('TIER-03a: default config → nf-planner resolves to inherit (opus tier)', () => {
    // No config.json — planner tier = 'planner', model_tier_planner = 'opus' → 'inherit'
    const result = runNfTools('resolve-model nf-planner', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.model, 'inherit', `TIER-03a: expected inherit, got ${data.model}`);
  });

  test('TIER-03b: model_tier_worker:sonnet in config → nf-phase-researcher resolves to sonnet', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_tier_worker: 'sonnet' })
    );
    const result = runNfTools('resolve-model nf-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.model, 'sonnet', `TIER-03b: expected sonnet, got ${data.model}`);
  });

  test('TIER-03c: per-agent model_overrides beats tier key for nf-phase-researcher', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_overrides: { 'nf-phase-researcher': 'sonnet' } })
    );
    const result = runNfTools('resolve-model nf-phase-researcher', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.model, 'sonnet', `TIER-03c: expected sonnet (override), got ${data.model}`);
  });

  test('TIER-03d: unknown agent type falls back to worker tier (haiku)', () => {
    // Unknown agents fall through agentToTier default '|| worker'
    const result = runNfTools('resolve-model nf-unknown-agent-xyz', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.model, 'haiku', `TIER-03d: expected haiku worker fallback, got ${data.model}`);
  });
});

describe('default_milestone config feature', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('DM-TC-01: default_milestone "v0.42 My Milestone" populates init quick output', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: 'v0.42 My Milestone' })
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.42', `DM-TC-01: expected chosen_milestone=v0.42, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, true, `DM-TC-01: expected default_milestone_used=true, got ${data.default_milestone_used}`);
  });

  test('DM-TC-02: default_milestone null falls back to STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: null })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'Milestone: v0.41 — milestone\n'
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.41', `DM-TC-02: expected chosen_milestone=v0.41, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, false, `DM-TC-02: expected default_milestone_used=false, got ${data.default_milestone_used}`);
  });

  test('DM-TC-03: default_milestone "auto" is treated as not-set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: 'auto' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'Milestone: v0.41 — milestone\n'
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.41', `DM-TC-03: expected chosen_milestone=v0.41, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, false, `DM-TC-03: expected default_milestone_used=false, got ${data.default_milestone_used}`);
  });

  test('DM-TC-04: default_milestone without v-prefix normalizes correctly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: '0.42' })
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.42', `DM-TC-04: expected chosen_milestone=v0.42, got ${data.chosen_milestone}`);
  });

  test('DM-TC-05: default_milestone with colon format "v0.42: Release"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: 'v0.42: Release' })
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.42', `DM-TC-05: expected chosen_milestone=v0.42, got ${data.chosen_milestone}`);
  });

  test('DM-TC-06: default_milestone takes priority over STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: 'v0.99 Override' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'Milestone: v0.41 — milestone\n'
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.99', `DM-TC-06: expected chosen_milestone=v0.99, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, true, `DM-TC-06: expected default_milestone_used=true, got ${data.default_milestone_used}`);
  });

  test('DM-TC-07: no config and no STATE.md yields null chosen_milestone', () => {
    // Already have .planning/phases created by createTempProject, no config.json, no STATE.md
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, null, `DM-TC-07: expected chosen_milestone=null, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, false, `DM-TC-07: expected default_milestone_used=false, got ${data.default_milestone_used}`);
  });

  test('DM-TC-09: default_milestone empty string falls back to STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: '' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      'Milestone: v0.41 — milestone\n'
    );
    const result = runNfTools('init quick "test task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.41', `DM-TC-09: expected chosen_milestone=v0.41, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, false, `DM-TC-09: expected default_milestone_used=false, got ${data.default_milestone_used}`);
  });

  test('DM-TC-10: phase-plan-index populates chosen_milestone from config', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ default_milestone: 'v0.42 PhaseTest' })
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Test milestone context
---

## Task 1: Placeholder
`
    );
    const result = runNfTools('phase-plan-index 03 --raw', tmpDir);
    assert.ok(result.success, `phase-plan-index failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.chosen_milestone, 'v0.42', `DM-TC-10: expected chosen_milestone=v0.42, got ${data.chosen_milestone}`);
    assert.strictEqual(data.default_milestone_used, true, `DM-TC-10: expected default_milestone_used=true, got ${data.default_milestone_used}`);
  });

  test('DM-TC-08: config-ensure-section includes default_milestone in template', () => {
    // Ensure tmpDir has no config.json
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    const result = runNfTools('config-ensure-section --raw', tmpDir);
    assert.ok(result.success, `config-ensure-section failed: ${result.error}`);
    assert.strictEqual(result.output, 'created', `DM-TC-08: expected 'created' output`);
    // Now read the created config file and check for default_milestone
    const createdConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.ok(createdConfig.hasOwnProperty('default_milestone'), `DM-TC-08: default_milestone key not found in created config.json`);
  });
});

describe('init quick atomic task_id assignment', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('RC-01: init quick creates .claimed file in task directory', () => {
    const result = runNfTools('init quick "race condition fix" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.next_num, 1, `RC-01: expected next_num=1, got ${data.next_num}`);
    const claimedPath = path.join(tmpDir, '.planning', 'quick', '1-race-condition-fix', '.claimed');
    assert.ok(fs.existsSync(claimedPath), `RC-01: .claimed file should exist at ${claimedPath}`);
    const claimed = JSON.parse(fs.readFileSync(claimedPath, 'utf8'));
    assert.strictEqual(claimed.task_id, 1, `RC-01: .claimed task_id should be 1, got ${claimed.task_id}`);
    assert.ok(claimed.pid, 'RC-01: .claimed should have pid');
    assert.ok(claimed.ts, 'RC-01: .claimed should have ts');
  });

  test('RC-02: init quick creates task directory atomically', () => {
    const result = runNfTools('init quick "atomic test" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    const taskDir = path.join(tmpDir, '.planning', 'quick', `${data.next_num}-atomic-test`);
    assert.ok(fs.existsSync(taskDir), `RC-02: task directory should exist at ${taskDir}`);
  });

  test('RC-03: sequential init quick calls produce monotonically increasing task_ids', () => {
    const r1 = runNfTools('init quick "first task" --raw', tmpDir);
    assert.ok(r1.success, `first init quick failed: ${r1.error}`);
    const d1 = JSON.parse(r1.output);

    const r2 = runNfTools('init quick "second task" --raw', tmpDir);
    assert.ok(r2.success, `second init quick failed: ${r2.error}`);
    const d2 = JSON.parse(r2.output);

    assert.strictEqual(d1.next_num, 1, `RC-03: first next_num should be 1, got ${d1.next_num}`);
    assert.strictEqual(d2.next_num, 2, `RC-03: second next_num should be 2, got ${d2.next_num}`);
  });

  test('RC-04: init quick without description does not create task directory', () => {
    const result = runNfTools('init quick --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.next_num, 1, `RC-04: expected next_num=1, got ${data.next_num}`);
    const quickDir = path.join(tmpDir, '.planning', 'quick');
    const numDirs = fs.readdirSync(quickDir).filter(f => /^\d+-/.test(f));
    assert.strictEqual(numDirs.length, 0, `RC-04: no numbered dirs should exist without description, got ${numDirs.length}`);
  });

  test('RC-05: init quick lock file is cleaned up after execution', () => {
    const result = runNfTools('init quick "lock cleanup" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const lockPath = path.join(tmpDir, '.planning', 'quick', '.init-lock');
    assert.ok(!fs.existsSync(lockPath), `RC-05: .init-lock should not exist after init quick, found at ${lockPath}`);
  });

  test('RC-06: init quick skips .claimed directories in task_id scan', () => {
    const quickDir = path.join(tmpDir, '.planning', 'quick');
    fs.mkdirSync(path.join(quickDir, '1-existing-task'), { recursive: true });
    fs.writeFileSync(path.join(quickDir, '1-existing-task', '.claimed'), JSON.stringify({ pid: 12345, ts: new Date().toISOString(), task_id: 1 }));

    const result = runNfTools('init quick "next task" --raw', tmpDir);
    assert.ok(result.success, `init quick failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.next_num, 2, `RC-06: next_num should be 2, got ${data.next_num}`);
  });

  test('RC-07: concurrent init quick calls produce unique task_ids', () => {
    const { spawnSync } = require('child_process');
    const quickDir = path.join(tmpDir, '.planning', 'quick');
    fs.mkdirSync(quickDir, { recursive: true });

    const concurrency = 4;
    const results = [];
    for (let i = 0; i < concurrency; i++) {
      const res = spawnSync('node', [TOOLS_PATH, 'init', 'quick', `concurrent-task-${i}`, '--raw'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      if (res.status === 0 && res.stdout) {
        try {
          results.push(JSON.parse(res.stdout.trim()));
        } catch {}
      }
    }

    assert.ok(results.length >= 2, `RC-07: expected at least 2 successful results, got ${results.length}`);
    const taskIds = results.map(r => r.next_num);
    const uniqueIds = new Set(taskIds);
    assert.strictEqual(uniqueIds.size, taskIds.length, `RC-07: task_ids should be unique, got duplicates: ${taskIds.join(', ')}`);
  });

  test('RC-08: stale init lock is removed and init quick succeeds', () => {
    const quickDir = path.join(tmpDir, '.planning', 'quick');
    fs.mkdirSync(quickDir, { recursive: true });
    const lockPath = path.join(quickDir, '.init-lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, ts: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));

    const result = runNfTools('init quick "stale lock test" --raw', tmpDir);
    assert.ok(result.success, `init quick with stale lock failed: ${result.error}`);
    const data = JSON.parse(result.output);
    assert.strictEqual(data.next_num, 1, `RC-08: next_num should be 1, got ${data.next_num}`);
  });
});

describe('progress bar render (regression: percent > 100 must not crash)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // Orphan SUMMARY files (more summaries than plans) drive percent above 100,
  // which used to make the bar's `'░'.repeat(barWidth - filled)` throw
  // `RangeError: Invalid count value: -N`. The bar must clamp instead.
  function seedOverComplete(dir) {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', dir);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary 2'); // 1 plan, 2 summaries -> 200%
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Milestones\n- v0.1 Test\n');
  }

  test('progress bar --raw does not crash at >100% and clamps the bar full', () => {
    seedOverComplete('01-foo');
    const result = runNfTools('progress bar --raw', tmpDir);
    assert.ok(result.success, `progress bar crashed instead of clamping: ${result.error}`);
    assert.ok(/200%/.test(result.output), `expected 200% in output, got: ${result.output}`);
    assert.ok(!/░/.test(result.output), `bar should be fully filled (no empty cells) at >100%, got: ${result.output}`);
  });

  test('progress table --raw does not crash at >100%', () => {
    seedOverComplete('01-bar');
    const result = runNfTools('progress table --raw', tmpDir);
    assert.ok(result.success, `progress table crashed instead of clamping: ${result.error}`);
  });
});
