# Quick Task 408 Summary

## Task
add river dependency check and install to install.js

## Changes

**File:** `bin/install.js` (lines 2749-2755)

Added explicit `uv` availability check before River ML installation block:

```javascript
// Check uv availability first — skip river install if not found
const uvCheck = _spawnRiver('which', ['uv'], { timeout: 3000 });
if (uvCheck.status !== 0) {
  log(`  ${yellow}⚠${reset} uv not found — skipping River ML`);
  return;
}
```

This replaces the implicit fail-open behavior (relying on try/catch when uv is missing) with an explicit early-return and user-facing warning message.

## Verification

- `grep -n "uvCheck" bin/install.js` → line 2750
- `which uv` → `/Users/jonathanborduas/.local/bin/uv` (available)
- River venv exists at `~/.claude/nf-python-env/` with River importable
- `node bin/install.js --claude --global` → completed successfully

## Formal Modeling

### Loop 2 Simulation
- **Status:** Not applicable (no formal coverage intersections)

## Issues Encountered
None.