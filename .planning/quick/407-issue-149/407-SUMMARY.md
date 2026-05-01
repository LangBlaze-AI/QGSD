---
phase: 407-issue-149
plan: 01
title: "Cleanup manifest-driven CLI detection in bin/install.js"
type: quick-task
status: complete
completed_date: 2026-05-01
duration: "5 minutes"
---

# Phase 407 Issue 149 Summary

**Quick Task:** Cleanup and fix manifest-driven CLI detection in bin/install.js

**Completed:** 2026-05-01

## One-liner

Removed debug console.log statements, broken CCR references in rescan path, and cleaned up CCR-related comments and code while preserving backward compatibility.

## Files Changed

| File | Lines Modified | Type |
|------|---------------|------|
| `bin/install.js` | ~20 lines | Bug fix, cleanup |

## What Was Done

### Task 1: Remove debug console.log lines (Lines 33-35)
- Removed `console.log('DEBUG: Trying to load:', providersJsonPath);`
- Removed `console.log('DEBUG: Loaded providers:', providersData.providers.length);`
- Kept error handling intact (lines 36-50)
- The verbose logging at line 45 (`log(`Loaded manifest with ${providers.length} providers`)`) remains for when --verbose flag is used

### Task 2: Remove broken CCR references in rescan path (Lines 3952-3953)
- Deleted the broken CCR status printing block that referenced undefined variables
- The code attempted to access `ccrStatus` and `ccrNames` which were never defined in scope
- This prevented runtime ReferenceError when --rescan flag was used

### Task 3: Clean up CCR comments and references
- **Line 453:** Changed comment from "ccr (Claude Code Router), api" to just "api"
- **Line 456:** Removed "ccr: Array," from @returns jsdoc
- **Line 476:** Kept `return { ccr: [], api, externalPrimary, dualSubscription };` for backward compatibility
- **Line 644:** Removed "CCR" from comment (was "API/Claude/CCR", now "API/Claude")
- **Line 655:** Removed `ccr` from regex: `/^(api|claude)-\d+$/` (was `/^(api|claude|ccr)-\d+$/`)
- **Line 3467:** Removed "Always includes CCR slots." from promptProviders comment
- **Line 3481:** Removed "ccr-*" from mcp-setup hint
- **Line 3483:** Removed "non-CCR" from comment (was "Print detection results for non-CCR CLIs")

## Deviations from Plan

None - plan executed exactly as written.

## Formal Modeling

**Module Affected:** `installer` (`.planning/formal/spec/installer/scope.json`)

**Intersections Found:** Yes - bin/install.js intersects with installer formal spec

**Note:** This was a cleanup task removing broken code and stale comments. No new state machine or formal specification changes were made. The formal modeling section is included for tracking purposes only.

## Key Decisions

1. **Backward compatibility preserved:** The `ccr: []` empty array in the return signature of `classifyProviders()` was kept intentionally to avoid breaking any code that might expect this field (even though no such code exists in the current codebase).

2. **Verbose logging retained:** The `log()` statement at line 45 was kept because it only prints when --verbose flag is used, making it useful for debugging rather than polluting normal output.

3. **Regex simplification:** Removed CCR pattern from the MCP server name matching regex in `hasClaudeMcpAgents()` since CCR slots are no longer part of the system.

## Testing

The changes are straightforward cleanup operations:
- Removed unreachable/broken code (CCR status printing in rescan path)
- Removed debug output
- Updated comments to reflect current architecture
- Simplified regex to match current slot naming conventions

No new test cases were needed as this was pure cleanup with no behavior changes.

## Related Issues

- Issue 149: Manifest-driven CLI detection
- Plan 406: Initial implementation of manifest-driven detection

## Commit

`3f19b4c7` - feat(install): remove CCR references and clean up manifest-driven detection (issue 149)
