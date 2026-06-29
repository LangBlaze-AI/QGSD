#!/usr/bin/env node
/**
 * Diagnostic proposal generator for model correction guidance.
 * Converts state divergence diffs into structured correction proposals
 * with evidence-based reasoning citing concrete trace values.
 */

/**
 * Generate correction proposals from a state divergence diff.
 * Each proposal targets a specific model element that needs addition/modification.
 *
 * Proposals include:
 * - add_state_variable: For each diverged field in the trace
 * - add_invariant: For state(s) where divergence first occurs
 * - add_temporal_property: For final state correctness
 *
 * Reasoning cites CONCRETE EVIDENCE from per_state_diffs (oldValue/newValue pairs),
 * not just field names. Confidence scoring is context-aware based on whether fields
 * appear in bugContext.
 *
 * @param {Object} stateDiff - Result from generateStateDiff with shape:
 *   {
 *     summary: {
 *       changed_fields: string[],
 *       first_divergence_index: number | null,
 *       total_changes: number
 *     },
 *     per_state_diffs: Array<{
 *       index: number,
 *       changes: Array<{ key, oldValue, newValue }>
 *     }>
 *   }
 * @param {string} bugContext - Bug description text (used for confidence scoring)
 * @returns {Array} Array of proposal objects sorted by priority (ascending), each with:
 *   {
 *     id: string,           // e.g., "PROP-SV-0", "PROP-INV-1", "PROP-TEMP-1"
 *     type: string,         // "add_state_variable" | "add_invariant" | "add_temporal_property"
 *     target: string,       // The specific element to add (field name, invariant name, etc.)
 *     confidence: number,   // 0.0–1.0
 *     reasoning: string,    // Evidence-based explanation citing concrete values
 *     example: string,      // TLA+/Alloy skeleton showing what to add
 *     priority: number,     // 1=highest, 2=medium, 3=lower
 *     effort: string        // "low" | "medium" | "high"
 *   }
 */
function generateCorrectionProposals(stateDiff, bugContext) {
  // Handle missing or invalid input
  if (!stateDiff || typeof stateDiff !== 'object') {
    return [];
  }

  const summary = (stateDiff.summary && typeof stateDiff.summary === 'object') ? stateDiff.summary : {};
  const per_state_diffs = Array.isArray(stateDiff.per_state_diffs) ? stateDiff.per_state_diffs : [];
  const { changed_fields = [], first_divergence_index = null, total_changes = 0 } = summary;

  // Early return: no changes detected
  if (per_state_diffs.length === 0 || changed_fields.length === 0) {
    return [];
  }

  // Normalize bugContext to string, default to empty string
  const bugContextStr = (bugContext || '').toString().toLowerCase();

  const proposals = [];

  // ==========================================
  // Category 1: add_state_variable proposals
  // ==========================================
  // Generate one proposal per diverged field
  for (let i = 0; i < changed_fields.length; i++) {
    const field = changed_fields[i];

    // Find the first per_state_diff entry containing this field to extract concrete values
    let fieldOldValue = undefined;
    let fieldNewValue = undefined;
    let fieldStateIndex = null;

    for (const stateDiffEntry of per_state_diffs) {
      if (!stateDiffEntry || !Array.isArray(stateDiffEntry.changes)) continue;
      const changeForField = stateDiffEntry.changes.find(c => c.key === field);
      if (changeForField) {
        fieldOldValue = changeForField.oldValue;
        fieldNewValue = changeForField.newValue;
        fieldStateIndex = stateDiffEntry.index;
        break;
      }
    }

    // Determine confidence: 0.9 if field appears in bugContext, 0.7 otherwise
    const fieldInBugContext = bugContextStr.includes(String(field).toLowerCase());
    const confidence = fieldInBugContext ? 0.9 : 0.7;

    // Build evidence-based reasoning using concrete values
    let reasoning = `Field '${field}' diverges: model produces ${JSON.stringify(fieldOldValue)} `;
    reasoning += `but bug trace shows ${JSON.stringify(fieldNewValue)}`;
    if (fieldStateIndex !== null) {
      reasoning += ` at state ${fieldStateIndex}`;
    }
    reasoning += `. Model does not track this variable correctly.`;

    // Append field relevance note if in bugContext
    if (fieldInBugContext) {
      reasoning += ` Field is explicitly mentioned in the bug description, confirming relevance.`;
    }

    // Infer type from actual values
    let inferredType = 'STRING';
    if (typeof fieldOldValue === 'number' && typeof fieldNewValue === 'number') {
      inferredType = 'Nat';
    } else if (typeof fieldOldValue === 'boolean' && typeof fieldNewValue === 'boolean') {
      inferredType = 'BOOLEAN';
    } else if (typeof fieldOldValue === 'string' && typeof fieldNewValue === 'string') {
      inferredType = 'STRING';
    } else if (fieldOldValue !== undefined && fieldNewValue !== undefined) {
      // Explicit set of observed values
      inferredType = `{${JSON.stringify(fieldOldValue)}, ${JSON.stringify(fieldNewValue)}}`;
    }

    const example = `VARIABLE ${field} \\in ${inferredType} \\\\ ` +
                    `Bug expects ${JSON.stringify(fieldNewValue)}, model produces ${JSON.stringify(fieldOldValue)}`;

    proposals.push({
      id: `PROP-SV-${i}`,
      type: 'add_state_variable',
      target: field,
      confidence,
      reasoning,
      example,
      priority: 1,
      effort: 'low'
    });
  }

  // ==========================================
  // Category 2: add_invariant proposal
  // ==========================================
  // Generate one proposal if per_state_diffs is non-empty AND first_divergence_index is not null
  if (per_state_diffs.length > 0 && first_divergence_index !== null) {
    const firstDiff = per_state_diffs[0];
    const firstChanges = (firstDiff && Array.isArray(firstDiff.changes)) ? firstDiff.changes : [];
    const changeCount = firstChanges.length;

    // Confidence: 0.8 for 1-2 changed fields (focused), 0.6 for 3+ (diffuse)
    const invariantConfidence = changeCount <= 2 ? 0.8 : 0.6;

    // Build evidence-based reasoning with concrete field:oldValue->newValue pairs
    let reasoningParts = [];
    for (let j = 0; j < Math.min(3, firstChanges.length); j++) {
      const change = firstChanges[j];
      reasoningParts.push(`${change.key}:${JSON.stringify(change.oldValue)}->${JSON.stringify(change.newValue)}`);
    }

    let reasoning = `Divergence first occurs at state ${first_divergence_index} with ${changeCount} field(s) changing: `;
    reasoning += reasoningParts.join(', ');
    reasoning += `. Add invariant constraining valid transitions at this state.`;

    // Build example with actual field names and values
    let exampleConditions = [];
    for (let j = 0; j < Math.min(2, firstChanges.length); j++) {
      const change = firstChanges[j];
      const op = typeof change.newValue === 'number' ? '=' : '=';
      exampleConditions.push(`${change.key} ${op} ${JSON.stringify(change.newValue)}`);
    }

    const example = exampleConditions.length > 0
      ? `Inv_${first_divergence_index} == pc = ${first_divergence_index} => ${exampleConditions.join(' /\\\\ ')}`
      : `Inv_${first_divergence_index} == pc = ${first_divergence_index} => TRUE`;

    proposals.push({
      id: 'PROP-INV-1',
      type: 'add_invariant',
      target: `Inv_StateConstraint_${first_divergence_index}`,
      confidence: invariantConfidence,
      reasoning,
      example,
      priority: 2,
      effort: 'medium'
    });
  }

  // ==========================================
  // Category 3: add_temporal_property proposal
  // ==========================================
  // Generate one proposal if changed_fields is non-empty
  if (changed_fields.length > 0 && per_state_diffs.length > 0) {
    const firstField = changed_fields[0];

    // Find the concrete values for this field from the first divergence
    let sampleOldValue = undefined;
    let sampleNewValue = undefined;

    for (const stateDiffEntry of per_state_diffs) {
      if (!stateDiffEntry || !Array.isArray(stateDiffEntry.changes)) continue;
      const changeForField = stateDiffEntry.changes.find(c => c.key === firstField);
      if (changeForField) {
        sampleOldValue = changeForField.oldValue;
        sampleNewValue = changeForField.newValue;
        break;
      }
    }

    const reasoning = `Model's final state has ${firstField}=${JSON.stringify(sampleOldValue)} ` +
                      `but bug trace ends with ${firstField}=${JSON.stringify(sampleNewValue)}. ` +
                      `Add temporal property ensuring model eventually reaches the correct terminal state.`;

    const example = `Prop_FinalCorrect == <>[](${firstField} = ${JSON.stringify(sampleNewValue)})`;

    proposals.push({
      id: 'PROP-TEMP-1',
      type: 'add_temporal_property',
      target: 'FinalStateCorrectness',
      confidence: 0.6,
      reasoning,
      example,
      priority: 3,
      effort: 'high'
    });
  }

  // Sort by priority ascending (1 before 2 before 3)
  proposals.sort((a, b) => a.priority - b.priority);

  return proposals;
}

module.exports = {
  generateCorrectionProposals
};
