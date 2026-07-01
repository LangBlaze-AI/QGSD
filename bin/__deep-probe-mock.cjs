#!/usr/bin/env node
'use strict';
// Test fixture — a fake provider CLI for deep-probe / stall integration tests.
// Behavior is chosen by MOCK_MODE; MOCK_DELAY_MS controls the slow/hang timing.
//   probe_ok (default) — print PROBE_OK, exit 0
//   quota              — print a 429/RESOURCE_EXHAUSTED line to stderr, exit 1
//   auth               — print a 401 unauthorized line to stderr, exit 1
//   slow_ok            — print a short preamble, wait MOCK_DELAY_MS, then PROBE_OK, exit 0
//   hang               — print a short preamble, then never output/exit (until killed)
const mode = process.env.MOCK_MODE || 'probe_ok';
const delay = Number(process.env.MOCK_DELAY_MS || 0);

function main() {
  if (mode === 'quota') {
    process.stderr.write('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 32h54m.\n');
    process.exit(1);
  } else if (mode === 'auth') {
    process.stderr.write('HTTP 401 unauthorized: invalid api key\n');
    process.exit(1);
  } else if (mode === 'hang') {
    process.stdout.write('PREAMBLE'.repeat(25)); // ~200-byte preamble, then silence forever
    setInterval(() => {}, 1 << 30);
  } else if (mode === 'slow_ok') {
    process.stdout.write('PREAMBLE'.repeat(25)); // small preamble (<500B), like the real slow slots
    setTimeout(() => { process.stdout.write('\nPROBE_OK\n'); process.exit(0); }, delay);
  } else {
    process.stdout.write('PROBE_OK\n');
    process.exit(0);
  }
}
main();
