/**
 * Consequence Model Generator Module
 * Applies normalized mutations to a reproducing model and generates a consequence model
 * representing the post-fix system state.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/**
 * Generate consequence model by applying mutations to reproducing model.
 * @param {string} reproducingModelPath - Path to bug-reproducing model file
 * @param {Array} mutations - Array of normalized mutations from intent-normalizer
 * @param {Object} options - { sessionId, formalism: 'tla'|'alloy' }
 * @returns {{
 *   consequenceModelPath: string,
 *   appliedMutations: Array,
 *   sessionDir: string,
 *   diagnostics: { totalMutations: number, appliedCount: number, skippedCount: number }
 * }}
 */
function generateConsequenceModel(reproducingModelPath, mutations, options = {}) {
  if (options === null || typeof options !== 'object') {
    options = {};
  }

  // Validate inputs
  if (!reproducingModelPath || !fs.existsSync(reproducingModelPath)) {
    throw new Error(`Reproducing model not found: ${reproducingModelPath}`);
  }

  if (!Array.isArray(mutations)) {
    throw new Error('Mutations must be an array');
  }

  // Step 1: Read reproducing model file content
  const modelContent = fs.readFileSync(reproducingModelPath, 'utf-8');

  // Step 2: Auto-detect formalism from file extension unless overridden
  let formalism = options.formalism;
  if (!formalism) {
    const ext = path.extname(reproducingModelPath).toLowerCase();
    if (ext === '.tla') {
      formalism = 'tla';
    } else if (ext === '.als') {
      formalism = 'alloy';
    } else {
      throw new Error(`Cannot detect formalism from extension: ${ext}`);
    }
  }

  // Step 3: Apply mutations sequentially
  let consequenceContent = modelContent;
  const appliedMutations = [];
  let appliedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    if (!mutation || typeof mutation !== 'object') {
      appliedMutations.push({
        iteration: i + 1,
        type: undefined,
        target: undefined,
        content: undefined,
        applied: false,
        error: 'Invalid mutation: expected object'
      });
      skippedCount++;
      continue;
    }
    const result = applyMutation(consequenceContent, mutation, formalism);

    if (result.success) {
      consequenceContent = result.content;
      appliedMutations.push({
        iteration: i + 1,
        type: mutation.type,
        target: mutation.target,
        content: mutation.content,
        applied: true
      });
      appliedCount++;
    } else {
      appliedMutations.push({
        iteration: i + 1,
        type: mutation.type,
        target: mutation.target,
        content: mutation.content,
        applied: false,
        error: result.error
      });
      skippedCount++;
    }
  }

  // Step 4: Create session directory
  const sessionId = options.sessionId || crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(os.tmpdir(), 'nf-cycle2-simulations', sessionId);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Step 5: Write consequence model file
  const fileExtension = formalism === 'tla' ? 'tla' : 'als';
  const consequenceModelPath = path.join(sessionDir, `consequence-model.${fileExtension}`);
  fs.writeFileSync(consequenceModelPath, consequenceContent, 'utf-8');

  // Step 6: Write normalized-mutations.json
  const mutationsJsonPath = path.join(sessionDir, 'normalized-mutations.json');
  fs.writeFileSync(mutationsJsonPath, JSON.stringify(appliedMutations, null, 2), 'utf-8');

  // Step 7: Return results with diagnostics
  return {
    consequenceModelPath,
    appliedMutations,
    sessionDir,
    diagnostics: {
      totalMutations: mutations.length,
      appliedCount,
      skippedCount
    }
  };
}

/**
 * Apply a single mutation to model content.
 * Implementation varies by formalism (TLA+, Alloy).
 * @param {string} modelContent - Current model content
 * @param {Object} mutation - { type, target, content, reasoning }
 * @param {string} formalism - 'tla' or 'alloy'
 * @returns {{ success: boolean, content: string, error: string|null }}
 */
function applyMutation(modelContent, mutation, formalism) {
  try {
    if (formalism === 'tla') {
      return applyTlaMutation(modelContent, mutation);
    } else if (formalism === 'alloy') {
      return applyAlloyMutation(modelContent, mutation);
    } else {
      return { success: false, content: modelContent, error: `Unknown formalism: ${formalism}` };
    }
  } catch (err) {
    return { success: false, content: modelContent, error: err.message };
  }
}

/**
 * Apply mutation for TLA+ formalism.
 * @param {string} modelContent - Current TLA+ spec content
 * @param {Object} mutation - { type, target, content }
 * @returns {{ success: boolean, content: string, error: string|null }}
 */
function applyTlaMutation(modelContent, mutation) {
  let updatedContent = modelContent;

  if (mutation.type === 'add_invariant') {
    // Find the Invariant section or create one
    // TLA+ pattern: look for existing INVARIANT or PROPERTY
    // If not found, append before terminal "====" or at end

    // Try to find existing invariant declarations
    const invariantMatch = updatedContent.match(/^(Invariant|INVARIANT|PROPERTY)\s*==/m);

    if (invariantMatch) {
      // Append to existing invariant section with AND
      updatedContent = updatedContent.replace(
        /^(Invariant|INVARIANT|PROPERTY)\s*==\s*(.+?)(?=^[A-Z]|\Z)/ms,
        (match, keyword, body) => {
          return `${keyword} ==\n  ${body.trim()} /\\ ${mutation.content}`;
        }
      );
    } else {
      // Create new invariant section before terminal marker or at end
      const terminalMatch = updatedContent.match(/^={4,}/m);
      if (terminalMatch) {
        const insertPoint = updatedContent.lastIndexOf(terminalMatch[0]);
        updatedContent = updatedContent.slice(0, insertPoint) +
          `Inv_${mutation.target} == ${mutation.content}\n\n` +
          updatedContent.slice(insertPoint);
      } else {
        updatedContent += `\n\nInv_${mutation.target} == ${mutation.content}`;
      }
    }
  } else if (mutation.type === 'add_state_variable') {
    // Find VARIABLES block and append new variable
    const varMatch = updatedContent.match(/^VARIABLES?\s+(.+?)(?=^[A-Z]|\Z)/ms);

    if (varMatch) {
      // Append to existing VARIABLES block
      updatedContent = updatedContent.replace(
        /^VARIABLES?\s+(.+?)(?=^[A-Z]|\Z)/ms,
        (match, vars) => {
          const lastComma = vars.trimRight().endsWith(',') ? '' : ',';
          return `${match.split(/VARIABLES?\s+/)[0]}VARIABLES ${vars.trimRight()}${lastComma}\n       ${mutation.target}`;
        }
      );
    } else {
      // Create new VARIABLES section
      const varContentMatch = updatedContent.match(/^VARIABLES?\s+\w+/m);
      if (varContentMatch) {
        const insertPoint = updatedContent.indexOf(varContentMatch[0]) + varContentMatch[0].length;
        updatedContent = updatedContent.slice(0, insertPoint) + `, ${mutation.target}` +
          updatedContent.slice(insertPoint);
      } else {
        updatedContent += `\n\nVARIABLE ${mutation.target}`;
      }
    }
  } else if (mutation.type === 'code_modification') {
    // Append as comment block before terminal marker
    const terminalMatch = updatedContent.match(/^={4,}/m);
    if (terminalMatch) {
      const insertPoint = updatedContent.lastIndexOf(terminalMatch[0]);
      updatedContent = updatedContent.slice(0, insertPoint) +
        `\\* User code modification: ${mutation.target}\n\\* ${mutation.content.replace(/\n/g, '\n\\* ')}\n\n` +
        updatedContent.slice(insertPoint);
    } else {
      updatedContent += `\n\n\\* User code modification: ${mutation.target}\n\\* ${mutation.content}`;
    }
  }

  return { success: true, content: updatedContent, error: null };
}

/**
 * Apply mutation for Alloy formalism.
 * @param {string} modelContent - Current Alloy spec content
 * @param {Object} mutation - { type, target, content }
 * @returns {{ success: boolean, content: string, error: string|null }}
 */
function applyAlloyMutation(modelContent, mutation) {
  let updatedContent = modelContent;

  if (mutation.type === 'add_invariant') {
    // Alloy: append fact block
    const closingBrace = updatedContent.lastIndexOf('}');
    if (closingBrace >= 0) {
      updatedContent = updatedContent.slice(0, closingBrace) +
        `\nfact ${mutation.target} {\n  ${mutation.content}\n}\n` +
        updatedContent.slice(closingBrace);
    } else {
      updatedContent += `\n\nfact ${mutation.target} {\n  ${mutation.content}\n}`;
    }
  } else if (mutation.type === 'add_state_variable') {
    // Alloy: append sig or add field to existing sig
    // Try to find State sig and add field, otherwise create new sig
    if (updatedContent.includes('sig State')) {
      updatedContent = updatedContent.replace(
        /(sig State\s*{[^}]*})/,
        (match) => {
          return match.slice(0, -1) + `, ${mutation.target}: one Object\n}`;
        }
      );
    } else {
      const closingBrace = updatedContent.lastIndexOf('}');
      if (closingBrace >= 0) {
        updatedContent = updatedContent.slice(0, closingBrace) +
          `\none sig ${mutation.target} extends State {}\n` +
          updatedContent.slice(closingBrace);
      } else {
        updatedContent += `\n\none sig ${mutation.target} extends State {}`;
      }
    }
  } else if (mutation.type === 'code_modification') {
    // Alloy: append as comment block before closing brace
    const closingBrace = updatedContent.lastIndexOf('}');
    if (closingBrace >= 0) {
      updatedContent = updatedContent.slice(0, closingBrace) +
        `\n// User code modification: ${mutation.target}\n// ${mutation.content.replace(/\n/g, '\n// ')}\n\n` +
        updatedContent.slice(closingBrace);
    } else {
      updatedContent += `\n\n// User code modification: ${mutation.target}\n// ${mutation.content}`;
    }
  }

  return { success: true, content: updatedContent, error: null };
}

module.exports = { generateConsequenceModel, applyMutation };
