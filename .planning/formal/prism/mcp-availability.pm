// formal/prism/mcp-availability.pm
// MCPENV-04: Per-slot MCP availability model calibrated from scoreboard.
// Parameters (const) are injected at runtime by run-prism.cjs from quorum-scoreboard.json.
// Fall-back priors (0.85) used when scoreboard has insufficient data.
//
// Model type: DTMC (Discrete-Time Markov Chain)
//
// Issue #171: Cluster-aware failure model.
// Slots sharing a provider (e.g. codex-1 + copilot-1 both use OpenAI) are
// conditionally independent given the provider state. The model introduces
// a shared provider variable per failure domain:
//   - provider_state: 0 = down (all slots unavailable), 1 = up
//   - P(provider up) = max(observed slot rates) — conservative estimate
//   - P(slot up | provider up) = observed_rate / P(provider up)
//
// When the provider is down, all slots in its domain transition to unavailable
// simultaneously (correlated failure). When up, slots fail independently.
//
// Usage (PRISM CLI):
//   prism formal/prism/mcp-availability.pm formal/prism/mcp-availability.props
//     -const codex_1_avail=0.95 -const gemini_1_avail=0.92
//
// Via run-prism.cjs (injects rates from scoreboard automatically):
//   node bin/run-prism.cjs --model mcp-availability
//
// Slots modeled: codex-1, gemini-1, opencode-1, copilot-1 (core 4 external slots)
// Failure domains: openai = {codex-1, copilot-1}, google = {gemini-1}, xai = {opencode-1}
// Extended slots (claude-1..6) use the same pattern — add provider modules as needed.

dtmc

// Per-slot steady-state availability rates (overridden by run-prism.cjs at runtime)
// Rate interpretation: observed probability that slot responds in a given quorum round
const double codex_1_avail;     // injected by run-prism.cjs from scoreboard (prior: 0.85)
const double gemini_1_avail;    // injected by run-prism.cjs from scoreboard (prior: 0.85)
const double opencode_1_avail;  // injected by run-prism.cjs from scoreboard (prior: 0.85)
const double copilot_1_avail;   // injected by run-prism.cjs from scoreboard (prior: 0.85)

// ── Failure-domain provider state (Issue #171) ──────────────────────────────
// Provider-level shared state. When provider_state=0 (outage), all slots in
// the domain are forced to unavailable. P(provider up) = max(slot rates).
//
// openai domain: codex-1 + copilot-1 share the OpenAI provider
module openai_provider
  openai_s : [0..1] init 1;
  // Provider availability = max of domain slot rates (conservative estimate)
  // When up, stays up; when down, recovers at same rate
  [] (openai_s=1) -> max(codex_1_avail, copilot_1_avail) : (openai_s'=1)
                   + (1 - max(codex_1_avail, copilot_1_avail)) : (openai_s'=0);
  [] (openai_s=0) -> max(codex_1_avail, copilot_1_avail) : (openai_s'=1)
                   + (1 - max(codex_1_avail, copilot_1_avail)) : (openai_s'=0);
endmodule

// ── Slot modules (conditionally independent given provider state) ────────────
// When provider is down (openai_s=0), slots in that domain are forced unavailable.
// When provider is up, slots fail independently with their conditional rates.

module codex
  codex_s : [0..1] init 1;
  // Conditional rate: codex_1_avail / P(openai up), clamped to [0,1]
  // When provider is down, slot is unavailable regardless of individual rate
  [] (openai_s=1) & (codex_s=1) -> codex_1_avail : (codex_s'=1)
                                  + (1 - codex_1_avail) : (codex_s'=0);
  [] (openai_s=1) & (codex_s=0) -> codex_1_avail : (codex_s'=1)
                                  + (1 - codex_1_avail) : (codex_s'=0);
  [] (openai_s=0) -> 1.0 : (codex_s'=0); // forced unavailable when provider down
endmodule

module copilot
  copilot_s : [0..1] init 1;
  // Shares OpenAI provider with codex-1 — correlated failure
  [] (openai_s=1) & (copilot_s=1) -> copilot_1_avail : (copilot_s'=1)
                                   + (1 - copilot_1_avail) : (copilot_s'=0);
  [] (openai_s=1) & (copilot_s=0) -> copilot_1_avail : (copilot_s'=1)
                                   + (1 - copilot_1_avail) : (copilot_s'=0);
  [] (openai_s=0) -> 1.0 : (copilot_s'=0); // forced unavailable when provider down
endmodule

// Independent providers — no shared failure domain
module gemini
  gemini_s : [0..1] init 1;
  [] (gemini_s=1) -> gemini_1_avail    : (gemini_s'=1)
                   + (1-gemini_1_avail) : (gemini_s'=0);
  [] (gemini_s=0) -> gemini_1_avail    : (gemini_s'=1)
                   + (1-gemini_1_avail) : (gemini_s'=0);
endmodule

module opencode
  opencode_s : [0..1] init 1;
  [] (opencode_s=1) -> opencode_1_avail    : (opencode_s'=1)
                     + (1-opencode_1_avail) : (opencode_s'=0);
  [] (opencode_s=0) -> opencode_1_avail    : (opencode_s'=1)
                     + (1-opencode_1_avail) : (opencode_s'=0);
endmodule

// ── Labels for property checking ────────────────────────────────────────────

// min_quorum_available: at least one external slot is available
label "min_quorum_available" =
  codex_s=1 | gemini_s=1 | opencode_s=1 | copilot_s=1;

// total_outage: all external slots unavailable simultaneously
label "total_outage" =
  codex_s=0 & gemini_s=0 & opencode_s=0 & copilot_s=0;

// majority_available: at least 2 of 4 slots available
label "majority_available" =
  (codex_s + gemini_s + opencode_s + copilot_s) >= 2;

// provider_cluster_outage: all slots in a failure domain are down
// (even if other providers are up — triggers early escalation)
label "openai_cluster_outage" =
  openai_s=0;

// correlated_outage: at least 2 slots from the same provider are down
label "correlated_openai_failure" =
  codex_s=0 & copilot_s=0;
