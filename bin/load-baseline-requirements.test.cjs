'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBaselineRequirements, loadBaselineRequirementsFromIntent } = require('./load-baseline-requirements.cjs');

// Test 1: web profile includes all 34 requirements
test('loadBaselineRequirements("web") returns all 34 requirements', () => {
  const result = loadBaselineRequirements('web');
  assert.equal(result.profile, 'web');
  assert.equal(result.total, 34);
  assert.equal(result.categories.length, 6);
});

// Test 2: mobile profile includes all 34 requirements
test('loadBaselineRequirements("mobile") returns all 34 requirements', () => {
  const result = loadBaselineRequirements('mobile');
  assert.equal(result.profile, 'mobile');
  assert.equal(result.total, 34);
  assert.equal(result.categories.length, 6);
});

// Test 3: library profile includes only security and ci-cd (6 requirements: 3 + 3)
test('loadBaselineRequirements("library") returns only security and ci-cd categories', () => {
  const result = loadBaselineRequirements('library');
  assert.equal(result.profile, 'library');
  assert.equal(result.total, 6);
  assert.equal(result.categories.length, 2);
  const categoryNames = result.categories.map(c => c.name);
  assert(categoryNames.includes('Security'));
  assert(categoryNames.includes('CI/CD'));
});

// Test 4: api profile includes only those requirements that have api in their profiles array
test('loadBaselineRequirements("api") includes only api-compatible requirements', () => {
  const result = loadBaselineRequirements('api');
  // API should have 18 requirements based on per-requirement profiles array
  assert.equal(result.total, 18);
  const uxCategory = result.categories.find(c => c.name === 'UX Heuristics');
  assert(uxCategory);
  // Only error-messages has api in its profiles array, so 1 UX requirement
  assert.equal(uxCategory.requirements.length, 1);
});

// Test 5: cli profile has 13 requirements based on per-requirement profiles array
test('loadBaselineRequirements("cli") returns 13 requirements', () => {
  const result = loadBaselineRequirements('cli');
  // cli has 13 requirements based on per-requirement profiles array
  assert.equal(result.total, 13);
  const uxCategory = result.categories.find(c => c.name === 'UX Heuristics');
  assert(uxCategory);
  // cli UX should have 3 requirements based on their profiles arrays
  assert.equal(uxCategory.requirements.length, 3);
});

// Test 6: desktop profile has 20 requirements based on per-requirement profiles array
test('loadBaselineRequirements("desktop") returns 20 requirements', () => {
  const result = loadBaselineRequirements('desktop');
  // desktop should have 20 requirements based on per-requirement profiles array
  assert.equal(result.total, 20);
  // desktop has no observability category because none of the observability requirements have desktop in their profiles
  const obsCategory = result.categories.find(c => c.name === 'Observability');
  assert(!obsCategory);
});

// Test 7: All returned requirements have required fields
test('All requirements have id, text, intent, verifiable_by fields', () => {
  const result = loadBaselineRequirements('web');
  for (const category of result.categories) {
    for (const req of category.requirements) {
      assert(typeof req.id === 'string', 'id must be string');
      assert(typeof req.text === 'string', 'text must be string');
      assert(typeof req.intent === 'string', 'intent must be string');
      assert(typeof req.verifiable_by === 'string', 'verifiable_by must be string');
    }
  }
});

// Test 8: IDs follow template pattern with zero-padded 2-digit numbers
test('IDs follow template pattern (UX-01, SEC-01, etc.)', () => {
  const result = loadBaselineRequirements('web');
  const idPattern = /^[A-Z]{2,4}-\d{2}$/;
  for (const category of result.categories) {
    for (const req of category.requirements) {
      assert(idPattern.test(req.id), `ID ${req.id} does not match pattern`);
    }
  }
});

// Test 9: IDs within a category are sequential with no gaps
test('IDs within each category are sequential with no gaps', () => {
  const result = loadBaselineRequirements('web');
  for (const category of result.categories) {
    for (let i = 0; i < category.requirements.length; i++) {
      const expectedNumber = String(i + 1).padStart(2, '0');
      const actualId = category.requirements[i].id;
      const actualNumber = actualId.split('-')[1];
      assert.equal(actualNumber, expectedNumber, `Category ${category.name}: expected ${expectedNumber}, got ${actualNumber}`);
    }
  }
});

// Test 10: Invalid profile throws error
test('loadBaselineRequirements("invalid") throws error', () => {
  assert.throws(() => {
    loadBaselineRequirements('invalid');
  }, /Invalid profile/);
});

// Test 11: Total count matches index.json total_requirements for web
test('Web profile total count matches index.json total_requirements (34)', () => {
  const result = loadBaselineRequirements('web');
  assert.equal(result.total, 34);
});

// Test 12: Each category has name and description fields
test('Each category has name and description fields', () => {
  const result = loadBaselineRequirements('web');
  for (const category of result.categories) {
    assert(typeof category.name === 'string', 'category.name must be string');
    assert(typeof category.description === 'string', 'category.description must be string');
    assert(Array.isArray(category.requirements), 'category.requirements must be array');
  }
});

// Test 13: All 6 profiles can be loaded
test('All 6 profiles can be loaded successfully', () => {
  const profiles = ['web', 'mobile', 'desktop', 'api', 'cli', 'library'];
  for (const profile of profiles) {
    const result = loadBaselineRequirements(profile);
    assert.equal(result.profile, profile);
  }
});

// Test 14: Profile metadata is correct
test('Profile metadata (label, description) is populated', () => {
  const result = loadBaselineRequirements('web');
  assert.equal(result.label, 'Web Application');
  assert(result.description.length > 0);
});

// Test 15: Library profile only includes security and ci-cd categories
test('Library profile respects includes_only constraint', () => {
  const result = loadBaselineRequirements('library');
  const categoryNames = result.categories.map(c => c.name);
  assert.deepEqual(categoryNames.sort(), ['CI/CD', 'Security'].sort());
});

// Test 16: Desktop has no observability requirements
test('Desktop has no observability category', () => {
  const webResult = loadBaselineRequirements('web');
  const desktopResult = loadBaselineRequirements('desktop');

  const webObs = webResult.categories.find(c => c.name === 'Observability');
  const desktopObs = desktopResult.categories.find(c => c.name === 'Observability');

  // web should have observability, desktop should not
  assert(webObs);
  assert(!desktopObs);
});

// Test 17: Verify specific requirements for security category across profiles
test('Security category is included in all profiles', () => {
  const profiles = ['web', 'mobile', 'desktop', 'api', 'cli', 'library'];
  for (const profile of profiles) {
    const result = loadBaselineRequirements(profile);
    const securityCategory = result.categories.find(c => c.name === 'Security');
    assert(securityCategory, `Security category missing for profile ${profile}`);
    assert(securityCategory.requirements.length > 0);
  }
});

// Test 18: Verify CI/CD category is included in all profiles
test('CI/CD category is included in all profiles', () => {
  const profiles = ['web', 'mobile', 'desktop', 'api', 'cli', 'library'];
  for (const profile of profiles) {
    const result = loadBaselineRequirements(profile);
    const cicdCategory = result.categories.find(c => c.name === 'CI/CD');
    assert(cicdCategory, `CI/CD category missing for profile ${profile}`);
    assert(cicdCategory.requirements.length > 0);
  }
});

// Test 19: API includes only one UX requirement (error-messages)
test('API profile includes only error-messages from UX category', () => {
  const result = loadBaselineRequirements('api');
  // API should include only requirements that have api in their profiles array
  // Only error-messages has api in its profiles
  const uxCategory = result.categories.find(c => c.name === 'UX Heuristics');
  assert.equal(uxCategory.requirements.length, 1);
  assert(uxCategory.requirements[0].text.includes('Error messages'));
});

// Test 20: Desktop profile total is 20 based on per-requirement profiles
test('Desktop profile has 20 requirements based on per-requirement profiles', () => {
  const result = loadBaselineRequirements('desktop');
  assert.equal(result.total, 20);
});

// Test 21: loadBaselineRequirementsFromIntent with web profile returns 34 reqs
test('loadBaselineRequirementsFromIntent({base_profile:"web"}) returns 34 requirements', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'web' });
  assert.equal(result.total, 34);
  assert.equal(result.profile, 'web');
});

// Test 22: loadBaselineRequirementsFromIntent with cli profile returns 13 reqs
test('loadBaselineRequirementsFromIntent({base_profile:"cli"}) returns 13 requirements', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'cli' });
  assert.equal(result.total, 13);
  assert.equal(result.profile, 'cli');
});

// Test 23: loadBaselineRequirementsFromIntent with web+iac returns 46 reqs
test('loadBaselineRequirementsFromIntent({base_profile:"web", iac:true}) returns 46 requirements', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'web', iac: true });
  assert.equal(result.total, 46);
});

// Test 24: loadBaselineRequirementsFromIntent with library+iac returns 6 (no IaC for library)
test('loadBaselineRequirementsFromIntent({base_profile:"library", iac:true}) returns 6 requirements', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'library', iac: true });
  assert.equal(result.total, 6);
  // library only has security and ci-cd, so IaC should not be included since library is not in IaC profiles
});

// Test 25: web+iac intent packs_applied contains all 7 pack names
test('web+iac intent packs_applied contains all expected packs', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'web', iac: true });
  assert.ok(Array.isArray(result.packs_applied));
  assert.deepEqual(result.packs_applied.sort(), [
    'ci-cd',
    'iac',
    'observability',
    'performance',
    'reliability',
    'security',
    'ux-heuristics',
  ].sort());
});

// Test 26: cli intent packs_applied does not include conditional iac pack
test('cli intent packs_applied contains always packs, excludes conditional iac', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'cli' });
  assert.ok(Array.isArray(result.packs_applied));
  // CLI should have: security, reliability, observability, ci-cd, ux-heuristics
  // (performance is filtered out by per-requirement profiles array)
  assert.equal(result.packs_applied.length, 5);
  assert(!result.packs_applied.includes('iac'));
});

// Test 27: Missing base_profile throws error
test('loadBaselineRequirementsFromIntent missing base_profile throws error', () => {
  assert.throws(() => {
    loadBaselineRequirementsFromIntent({ iac: true });
  }, /base_profile is required/);
});

// Test 28: Minimal intent {base_profile:"api"} works with defaults applied
test('loadBaselineRequirementsFromIntent({base_profile:"api"}) returns 18 requirements', () => {
  const result = loadBaselineRequirementsFromIntent({ base_profile: 'api' });
  assert.equal(result.total, 18);
  assert.equal(result.profile, 'api');
});

// Test 29: Intent result has enriched intent field with has_ui derived
test('Intent result has enriched intent field with has_ui derived correctly', () => {
  const webResult = loadBaselineRequirementsFromIntent({ base_profile: 'web' });
  assert.ok(webResult.intent);
  assert.equal(webResult.intent.has_ui, true);
  assert.equal(webResult.intent.iac, false);

  const cliResult = loadBaselineRequirementsFromIntent({ base_profile: 'cli' });
  assert.ok(cliResult.intent);
  assert.equal(cliResult.intent.has_ui, false);
  assert.equal(cliResult.intent.base_profile, 'cli');
});

// Test 30: prototype-chain keys must be rejected, not silently treated as empty profiles (LBR-1)
test('loadBaselineRequirements("__proto__") throws Invalid profile instead of returning empty result', () => {
  assert.throws(() => {
    loadBaselineRequirements('__proto__');
  }, /Invalid profile/);
});

test('loadBaselineRequirements("constructor") throws Invalid profile instead of returning empty result', () => {
  assert.throws(() => {
    loadBaselineRequirements('constructor');
  }, /Invalid profile/);
});

// Test 31: prototype-chain base_profile must be rejected, not silently treated as empty (LBR-2)
test('loadBaselineRequirementsFromIntent({base_profile:"__proto__"}) throws Invalid base_profile', () => {
  assert.throws(() => {
    loadBaselineRequirementsFromIntent({ base_profile: '__proto__' });
  }, /Invalid base_profile/);
});

test('loadBaselineRequirementsFromIntent({base_profile:"constructor"}) throws Invalid base_profile', () => {
  assert.throws(() => {
    loadBaselineRequirementsFromIntent({ base_profile: 'constructor' });
  }, /Invalid base_profile/);
});
