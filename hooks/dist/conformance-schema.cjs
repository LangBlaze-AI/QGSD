'use strict';
// bin/conformance-schema.cjs
// Single source of truth for conformance event field enumerations.
// Imported by hooks (nf-stop.js, nf-prompt.js, nf-circuit-breaker.js) and validate-traces.cjs.
// NEVER add external require() calls — hooks have zero runtime dependencies.

const VALID_ACTIONS  = ['quorum_start', 'quorum_complete', 'quorum_block', 'deliberation_round', 'circuit_break', 'cache_hit', 'budget_warn', 'budget_downgrade', 'stall_detected', 'security_sweep'];
const VALID_PHASES   = ['IDLE', 'COLLECTING_VOTES', 'DELIBERATING', 'DECIDED'];
const VALID_OUTCOMES = ['APPROVE', 'BLOCK', 'UNAVAILABLE', 'DELIBERATE'];
const schema_version = '1';

module.exports = { VALID_ACTIONS, VALID_PHASES, VALID_OUTCOMES, schema_version };
