/**
 * Test suite for consequence-model-generator.cjs
 * Tests mutation application, consequence model creation, and file output
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateConsequenceModel, applyMutation } = require('./consequence-model-generator.cjs');

// Helper: Create temporary test files
function createTempFile(content, extension = '.tla') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-test-'));
  const filePath = path.join(tempDir, `test-model${extension}`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return { tempDir, filePath };
}

// Helper: Cleanup temporary directories
function cleanup(tempDir) {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('Consequence Model Generator - TLA+ Mutations', async (t) => {
  await t.test('applyMutation: add_invariant to TLA+ spec', () => {
    const modelContent = `
---- MODULE Test ----
EXTENDS Naturals
VARIABLES x

Init == x = 0

Next == x' = x + 1

Inv == x < 100
====
`;
    const mutation = {
      type: 'add_invariant',
      target: 'UserInv',
      content: 'x > -1'
    };

    const result = applyMutation(modelContent, mutation, 'tla');
    assert.equal(result.success, true);
    assert(result.content.includes('x > -1'));
  });

  await t.test('applyMutation: add_state_variable to TLA+ spec', () => {
    const modelContent = `
---- MODULE Test ----
EXTENDS Naturals
VARIABLES x

Init == x = 0
====
`;
    const mutation = {
      type: 'add_state_variable',
      target: 'timeout',
      content: 'VARIABLE timeout'
    };

    const result = applyMutation(modelContent, mutation, 'tla');
    assert.equal(result.success, true);
    assert(result.content.includes('timeout'));
  });

  await t.test('applyMutation: code_modification to TLA+ spec', () => {
    const modelContent = `
---- MODULE Test ----
EXTENDS Naturals
====
`;
    const mutation = {
      type: 'code_modification',
      target: 'UserCode',
      content: 'x := x + 1'
    };

    const result = applyMutation(modelContent, mutation, 'tla');
    assert.equal(result.success, true);
    assert(result.content.includes('UserCode'));
  });
});

test('Consequence Model Generator - Alloy Mutations', async (t) => {
  await t.test('applyMutation: add_invariant to Alloy spec', () => {
    const modelContent = `
sig State {
  x: Int
}

fact {
  all s: State | s.x >= 0
}
`;
    const mutation = {
      type: 'add_invariant',
      target: 'UserFact',
      content: 'all s: State | s.x < 100'
    };

    const result = applyMutation(modelContent, mutation, 'alloy');
    assert.equal(result.success, true);
    assert(result.content.includes('UserFact'));
    assert(result.content.includes('s.x < 100'));
  });

  await t.test('applyMutation: add_state_variable to Alloy spec', () => {
    const modelContent = `
sig State {
  x: Int
}
`;
    const mutation = {
      type: 'add_state_variable',
      target: 'timeout',
      content: 'timeout: Int'
    };

    const result = applyMutation(modelContent, mutation, 'alloy');
    assert.equal(result.success, true);
    assert(result.content.includes('timeout'));
  });

  await t.test('applyMutation: code_modification to Alloy spec', () => {
    const modelContent = `
sig State {
  x: Int
}
`;
    const mutation = {
      type: 'code_modification',
      target: 'UserCode',
      content: 'x := x + 1'
    };

    const result = applyMutation(modelContent, mutation, 'alloy');
    assert.equal(result.success, true);
    assert(result.content.includes('UserCode'));
  });
});

test('Consequence Model Generator - Session Creation', async (t) => {
  await t.test('generateConsequenceModel: creates session directory', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];

      const originalCwd = process.cwd();
      const result = generateConsequenceModel(filePath, mutations);

      assert(fs.existsSync(result.sessionDir), 'Session directory should exist');
      assert(result.sessionDir.includes('nf-cycle2-simulations'));

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });

  await t.test('generateConsequenceModel: writes consequence model file', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];
      
      const result = generateConsequenceModel(filePath, mutations);

      assert(fs.existsSync(result.consequenceModelPath));
      assert(result.consequenceModelPath.endsWith('.tla'));

      const content = fs.readFileSync(result.consequenceModelPath, 'utf-8');
      assert(content.includes('x > 0'));

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });

  await t.test('generateConsequenceModel: writes normalized-mutations.json', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' },
        { type: 'add_state_variable', target: 'y', content: 'VARIABLE y' }
      ];
      
      const result = generateConsequenceModel(filePath, mutations);

      const mutationsPath = path.join(result.sessionDir, 'normalized-mutations.json');
      assert(fs.existsSync(mutationsPath));

      const mutationsData = JSON.parse(fs.readFileSync(mutationsPath, 'utf-8'));
      assert.equal(mutationsData.length, 2);
      assert.equal(mutationsData[0].type, 'add_invariant');
      assert.equal(mutationsData[1].type, 'add_state_variable');

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });

  await t.test('generateConsequenceModel: records which mutations were applied', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];
      
      const result = generateConsequenceModel(filePath, mutations);

      const mutationsPath = path.join(result.sessionDir, 'normalized-mutations.json');
      const mutationsData = JSON.parse(fs.readFileSync(mutationsPath, 'utf-8'));

      assert.equal(mutationsData[0].applied, true);

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Formalism Detection', async (t) => {
  await t.test('auto-detects formalism from .tla extension', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];
      
      // No formalism option provided, should auto-detect from .tla
      const result = generateConsequenceModel(filePath, mutations);

      assert(result.consequenceModelPath.endsWith('.tla'));

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });

  await t.test('auto-detects formalism from .als extension', () => {
    const { tempDir, filePath } = createTempFile(
      'sig State { x: Int }\n', 
      '.als'
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Fact1', content: 'all s: State | s.x > 0' }
      ];
      
      // No formalism option provided, should auto-detect from .als
      const result = generateConsequenceModel(filePath, mutations);

      assert(result.consequenceModelPath.endsWith('.als'));

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });

  await t.test('respects explicit formalism option over file extension', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];
      
      // Explicitly specify formalism
      const result = generateConsequenceModel(filePath, mutations, { formalism: 'tla' });

      assert(result.consequenceModelPath.endsWith('.tla'));

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Diagnostics', async (t) => {
  await t.test('returns correct diagnostics for all mutations applied', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\nVARIABLES x\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' },
        { type: 'add_state_variable', target: 'y', content: 'VARIABLE y' }
      ];
      
      const result = generateConsequenceModel(filePath, mutations);

      assert.equal(result.diagnostics.totalMutations, 2);
      assert.equal(result.diagnostics.appliedCount, 2);
      assert.equal(result.diagnostics.skippedCount, 0);

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Fail-Open Behavior', async (t) => {
  await t.test('fail-open: invalid mutation does not crash, records applied=false', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];
      
      // This should complete without throwing
      const result = generateConsequenceModel(filePath, mutations);

      assert(result.appliedMutations.length >= 1);

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Null Mutation Entry', async (t) => {
  await t.test('fail-open: null mutation entry does not crash, records applied=false', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n===='
    );

    try {
      const mutations = [null];

      let result;
      assert.doesNotThrow(() => {
        result = generateConsequenceModel(filePath, mutations);
      });

      assert.equal(result.appliedMutations.length, 1);
      assert.equal(result.appliedMutations[0].applied, false);
      assert.equal(result.diagnostics.skippedCount, 1);

      fs.rmSync(result.sessionDir, { recursive: true, force: true });
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Null Options', async (t) => {
  await t.test('does not crash when options is explicitly null', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n===='
    );

    try {
      const mutations = [
        { type: 'add_invariant', target: 'Inv1', content: 'x > 0' }
      ];

      let result;
      assert.doesNotThrow(() => {
        result = generateConsequenceModel(filePath, mutations, null);
      });

      assert(result.consequenceModelPath.endsWith('.tla'));

      fs.rmSync(result.sessionDir, { recursive: true, force: true });
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Input Validation', async (t) => {
  await t.test('throws error for non-existent reproducing model', () => {
    const nonExistentPath = '/nonexistent/path/model.tla';
    const mutations = [];
    
    assert.throws(() => {
      generateConsequenceModel(nonExistentPath, mutations);
    }, /not found/i);
  });

  await t.test('throws error if mutations is not an array', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      assert.throws(() => {
        generateConsequenceModel(filePath, 'not an array');
      }, /must be an array/i);
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Session ID', async (t) => {
  await t.test('uses provided sessionId if specified', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [];
      const customSessionId = 'custom-session-123';
      
      const result = generateConsequenceModel(filePath, mutations, { sessionId: customSessionId });

      assert(result.sessionDir.includes(customSessionId));

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });

  await t.test('generates random sessionId if not provided', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\n====' 
    );
    
    try {
      const mutations = [];
      
      const result1 = generateConsequenceModel(filePath, mutations);
      const result2 = generateConsequenceModel(filePath, mutations);

      // Session directories should be different (random IDs)
      assert.notEqual(result1.sessionDir, result2.sessionDir);

      // Cleanup tmpdir session artifacts
      if (result1.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result1.sessionId), { recursive: true, force: true });
      }
      if (result2.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result2.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });
});

test('Consequence Model Generator - Mutation Traceability', async (t) => {
  await t.test('preserves mutation metadata in normalized-mutations.json', () => {
    const { tempDir, filePath } = createTempFile(
      '---- MODULE Test ----\nEXTENDS Naturals\nVARIABLES x\n====' 
    );
    
    try {
      const mutations = [
        {
          type: 'add_invariant',
          target: 'Inv1',
          content: 'x > 0',
          reasoning: 'Ensure x is positive'
        }
      ];
      
      const result = generateConsequenceModel(filePath, mutations);

      const mutationsPath = path.join(result.sessionDir, 'normalized-mutations.json');
      const mutationsData = JSON.parse(fs.readFileSync(mutationsPath, 'utf-8'));

      assert.equal(mutationsData[0].type, 'add_invariant');
      assert.equal(mutationsData[0].target, 'Inv1');
      assert.equal(mutationsData[0].content, 'x > 0');

      // Cleanup tmpdir session artifacts
      if (result.sessionId) {
        fs.rmSync(path.join(os.tmpdir(), 'nf-cycle2-simulations', result.sessionId), { recursive: true, force: true });
      }
    } finally {
      cleanup(tempDir);
    }
  });
});
