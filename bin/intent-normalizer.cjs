/**
 * Intent Normalizer Module
 * Converts fix ideas from three input channels (constraints, variables, code snippets)
 * into structured mutation format for consequence model generation.
 */

/**
 * Normalize fix intent from various input formats to structured mutations.
 * @param {string} intentText - Natural language, constraints, or code sketch
 * @param {Object} context - Optional context { bugDescription, reproducingModelPath, affectedCode }
 * @returns {{
 *   mutations: Array<{type: string, target: string, content: string, reasoning: string}>,
 *   confidence: number,
 *   ambiguities: Array<string>
 * }}
 */
function normalizeFixIntent(intentText, context = {}) {
  if (!intentText || typeof intentText !== 'string') {
    return { mutations: [], confidence: 0, ambiguities: [] };
  }

  // Fail-open: a null / non-object context must behave like no context.
  // The `context = {}` default only fires for `undefined`, so an explicit
  // `null` would otherwise crash on `context.bugDescription` below.
  if (!context || typeof context !== 'object') {
    context = {};
  }

  const mutations = [];
  const ambiguities = [];

  // Channel 1: Constraint syntax patterns
  // Parse patterns like "if X then Y", "when X, Y must hold", "X unless Y"
  const constraintPattern = /(?:if|when)\s+([^,]+?)(?:then|,?)\s+([^.;]+?)(?:\.|;|$)/gi;
  let match;
  while ((match = constraintPattern.exec(intentText)) !== null) {
    const condition = match[1].trim();
    const consequent = match[2].trim();
    mutations.push({
      type: 'add_invariant',
      target: `UserConstraint_${mutations.length}`,
      content: `${condition} => ${consequent}`,
      reasoning: context.bugDescription
        ? `User constraint addressing "${context.bugDescription}": "${match[0].trim()}"`
        : `User constraint: "${match[0].trim()}"`
    });
  }

  // Channel 2: Variable/state modifications
  // Parse patterns like "add timeout variable", "track retryCount", "set field X"
  const varPattern = /(?:add|set|track|initialize)\s+(?:state\s+)?(?:variable|field)?\s*(\w+)/gi;
  const varMatches = new Set();
  while ((match = varPattern.exec(intentText)) !== null) {
    const varName = match[1];
    if (!varMatches.has(varName.toLowerCase())) {
      varMatches.add(varName.toLowerCase());
      mutations.push({
        type: 'add_state_variable',
        target: varName,
        content: `VARIABLE ${varName}`,
        reasoning: context.bugDescription
          ? `Track "${varName}" to address "${context.bugDescription}"`
          : `User requested to track: ${varName}`
      });
    }
  }

  // Channel 3: Code snippets
  // Parse ```code blocks``` as code modifications
  const codePattern = /```([^`]+?)```/g;
  let codeBlockIndex = 0;
  while ((match = codePattern.exec(intentText)) !== null) {
    mutations.push({
      type: 'code_modification',
      target: `UserCode_${codeBlockIndex++}`,
      content: match[1].trim(),
      reasoning: context.bugDescription
        ? `User-provided code to fix "${context.bugDescription}"`
        : 'User-provided code snippet'
    });
  }

  // Detect ambiguity markers in hedging language
  if (/\b(?:maybe|might|could|possibly|perhaps)\b/i.test(intentText)) {
    ambiguities.push('Intent contains hedging language (maybe, might, could, possibly, perhaps); consider confirming specifics');
  }

  // Detect ambiguity markers in multiple options
  if (/\bor\s+(?:else|alternatively)\b/i.test(intentText)) {
    ambiguities.push('Intent presents multiple options (or else, or alternatively); select one for simulation');
  }

  // Compute confidence score
  // More mutations = higher confidence (max 3 channels → confidence 1.0)
  const confidence = mutations.length > 0 ? Math.min(1.0, mutations.length / 3) : 0;

  return {
    mutations,
    confidence,
    ambiguities
  };
}

module.exports = { normalizeFixIntent };
