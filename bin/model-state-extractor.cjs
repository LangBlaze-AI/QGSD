#!/usr/bin/env node
/**
 * Model state extractor for ITF JSON traces.
 * Extracts final states and analyzes state space from model checker output traces.
 */

const { parseITFTrace } = require('./parse-tlc-counterexample.cjs');
const fs = require('fs');

/**
 * Extract the final state(s) from a model's ITF trace.
 * For linear traces (no loop), returns the last state.
 * For lasso traces (with loop point), returns the states in the cycle.
 *
 * @param {string} traceJsonPath - Path to ITF JSON trace file
 * @returns {Array<Object>} Array of final state(s), or empty array on error
 */
function extractFinalStates(traceJsonPath) {
  try {
    const trace = parseITFTrace(traceJsonPath);
    const { states, loopPoint } = trace;

    if (!states || states.length === 0) {
      return [];
    }

    // If trace is a lasso (cycle), final states are those in the cycle
    if (typeof loopPoint === 'number' && Number.isInteger(loopPoint) && loopPoint >= 0 && loopPoint < states.length) {
      return states.slice(loopPoint);  // States in cycle
    }

    // Otherwise, return the last state
    return [states[states.length - 1]];
  } catch (err) {
    // Fail-open: log warning and return empty array
    console.error(`Warning: Failed to extract final states from ${traceJsonPath}: ${err.message}`);
    return [];
  }
}

/**
 * Analyze the state space of a model's ITF trace.
 * Returns structural information about the trace including initial state,
 * final states, all unique states, and state count.
 *
 * @param {string} traceJsonPath - Path to ITF JSON trace file
 * @returns {Object} State space analysis object:
 *   { initial_state, final_states, all_states, state_count }
 */
function analyzeStateSpace(traceJsonPath) {
  try {
    const trace = parseITFTrace(traceJsonPath);
    const { states } = trace;

    if (!states || states.length === 0) {
      return {
        initial_state: null,
        final_states: [],
        all_states: [],
        state_count: 0
      };
    }

    const initialState = states[0];

    // Deduplicate states using JSON.stringify for comparison
    const uniqueStatesMap = new Map();
    states.forEach((state, index) => {
      const stateKey = JSON.stringify(state);
      if (!uniqueStatesMap.has(stateKey)) {
        uniqueStatesMap.set(stateKey, state);
      }
    });

    // Extract final states using the same logic as extractFinalStates
    const finalStates = extractFinalStates(traceJsonPath);

    return {
      initial_state: initialState,
      final_states: finalStates,
      all_states: Array.from(uniqueStatesMap.values()),
      state_count: states.length
    };
  } catch (err) {
    // Fail-open: return empty state space on error
    console.error(`Warning: Failed to analyze state space from ${traceJsonPath}: ${err.message}`);
    return {
      initial_state: null,
      final_states: [],
      all_states: [],
      state_count: 0
    };
  }
}

module.exports = {
  extractFinalStates,
  analyzeStateSpace
};
