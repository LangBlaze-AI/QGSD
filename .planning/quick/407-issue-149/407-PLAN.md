---
phase: 407-issue-149
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - bin/install.js
autonomous: true
requirements:
  - ISSUE-149-01
  - ISSUE-149-02
  - ISSUE-149-03
  - ISSUE-149-04
  - ISSUE-149-05
  - ISSUE-149-06
formal_artifacts: none

must_haves:
  truths:
    - "install.js reads providers.json manifest to define CLI detection rules"
    - "install.js runs detect commands from manifest for each entry"
    - "install.js prints clear found/not-found status per CLI before prompting"
    - "install.js prompts for confirmation per CLI before registering (y/N)"
    - "All CCR preset references are removed from install.js"
    - "install.js never writes back to providers.json or any state file"
    - "install.js exits with clear error when providers.json is missing"
  artifacts:
    - path: "bin/install.js"
      provides: "Manifest-driven CLI detection with user consent"
      min_lines: 4000
    - path: "bin/providers.json"
      provides: "Detection manifest defining install/detect commands"
      contains: "codex-1, gemini-1, opencode-1, copilot-1, claude-1"
  key_links:
    - from: "bin/install.js"
      to: "bin/providers.json"
      via: "require('./providers.json') at startup"
      pattern: "require\\(['\"`]providers\\.json"
    - from: "bin/install.js detectExternalClis()"
      to: "providers[].mainTool"
      via: "resolveCli() lookup"
      pattern: "resolveCli\\(.*\\.mainTool\\)"
    - from: "bin/install.js promptProviders()"
      to: "console.log() status output"
      via: "found/resolvedPath field display"
      pattern: "console\\.log.*found.*resolvedPath"
  consumers: []

---

<objective>
Replace hardcoded CLI detection in install.js with manifest-driven approach using providers.json, add detect+prompt UX for user consent, and remove all CCR preset references.

Purpose: Users should control which CLIs get registered to their quorum setup, and the installer should be maintainable by updating a JSON manifest rather than modifying code.

Output: install.js that reads providers.json, detects CLIs dynamically, prompts for consent, and has zero CCR preset logic.
</objective>

<execution_context>
@./.claude/nf/workflows/execute-plan.md
@./.claude/nf/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md

@bin/providers.json
@bin/install.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add manifest-driven CLI detection and user consent prompts</name>
  <files>bin/install.js</files>
  <action>
  Modify bin/install.js to use providers.json as the source of truth for CLI detection:

  1. **Add manifest validation at startup** (before CLI detection):
     - After parsing args, read providers.json using `require('./providers.json')`
     - If file missing or invalid, exit with clear error: "ERROR: providers.json not found at bin/providers.json. Cannot detect CLIs."
     - Extract `providers` array and validate it's an array with at least one entry

  2. **Refactor CLI_INSTALL_HINTS to read from manifest**:
     - Remove hardcoded `CLI_INSTALL_HINTS` object (lines ~23-29)
     - Replace with function `getInstallHint(mainTool)` that:
       - Searches providers.json for entry with matching `mainTool`
       - Returns `cli.install_command` if present, or constructs hint from provider name
       - Returns empty string if not found

  3. **Update detectExternalClis() to use manifest fields**:
     - Keep existing logic but ensure it reads from providers array
     - For each provider, use `mainTool` field for CLI name detection
     - Use `display_provider` field for status output
     - Use `description` field for CLI display

  4. **Enhance promptProviders() with per-CLI confirmation prompts**:
     - Keep existing detection and status output (already prints found/not-found)
     - Before the "Enable detected CLIs?" prompt (line ~3527), add per-CLI confirmation loop:
       ```javascript
       // Per-CLI confirmation (unless --auto or explicit flags used)
       const autoMode = hasAllProviders || explicitFlagsPresent();
       const confirmedClis = [];

       for (const cli of foundClis) {
         if (autoMode) {
           confirmedClis.push(cli.name);
           console.log(`  ${cyan}Auto-enabled${reset} ${cli.name} (--${cli.bareCli} or --all-providers)`);
         } else {
           const answer = await rl.question(`  Register ${cli.name}? [Y/n]: `);
           const a = answer.trim().toLowerCase();
           if (a === '' || a === 'y' || a === 'yes') {
             confirmedClis.push(cli.name);
           }
         }
       }
       ```
     - Update "Enable detected CLIs?" prompt to skip if `confirmedClis` already populated
     - If user chooses "2) Let me choose" but already confirmed individually, skip the per-CLI loop

  5. **Add explicit flag detection helper**:
     - Create `explicitFlagsPresent()` function that checks:
       - Returns true if any of `--codex`, `--gemini`, `--opencode`, `--copilot`, `--claude`, `--all-providers` flags are present
       - Returns false otherwise (default interactive mode)

  6. **Update CLI hint display**:
     - In detection status output (lines ~3484-3490), call `getInstallHint(cli.bareCli)` instead of `CLI_INSTALL_HINTS[cli.bareCli]`
     - Display install hint only if hint is non-empty

  **What to avoid:**
  - Do NOT write to providers.json from install.js (read-only manifest)
  - Do NOT create any state files for tracking CLI registrations
  - Do NOT change the existing CLI detection logic structure (keep `resolveCli` usage)
  - Do NOT add new dependencies (use existing fs/path/readline modules)
  - Do NOT modify providers.json schema (use existing fields)
  </action>
  <verify>
  1. Test manifest loading: `node bin/install.js --claude --global` should read providers.json without error
  2. Test missing manifest error: Rename providers.json temporarily and run install.js - should exit with clear error
  3. Test detection status: Run `node bin/install.js --claude --global` and verify CLI detection output shows found/not-found status
  4. Test per-CLI prompts: Run install interactively and verify "Register {name}? [Y/n]" prompt appears for each detected CLI
  5. Test auto mode: Run `node bin/install.js --claude --codex --global` and verify "Auto-enabled" message appears, no prompts
  </verify>
  <done>
  install.js reads providers.json manifest at startup and validates it exists. CLI install hints are derived dynamically from manifest entries. Detection output shows clear found/not-found status per CLI. Interactive mode prompts for confirmation per CLI before registering (y/N), while --auto or explicit flags skip prompts. install.js never writes to providers.json or creates state files.
  </done>
</task>

<task type="auto">
  <name>Task 2: Remove all CCR preset references from install.js</name>
  <files>bin/install.js</files>
  <action>
  Remove all CCR (Claude Code Router) preset references from install.js:

  1. **Remove sync-ccr-presets.cjs invocation** (lines ~3013-3025):
     - Delete the entire try-catch block that calls `sync-ccr-presets.cjs`
     - Remove the comment "Sync CCR presets from providers.json"
     - Delete the `syncScript` variable definition
     - Delete the `execFileSync(process.execPath, [syncScript], { stdio: 'inherit' })` call
     - Delete the `console.warn` fallback message

  2. **Remove CCR CLI install hint** from CLI_INSTALL_HINTS (line ~28):
     - The `ccr: 'npm install -g @musistudio/claude-code-router'` entry
     - Note: This entire object is removed in Task 1, but ensure CCR is not added back

  3. **Remove CCR detection and auto-include logic from promptProviders()** (lines ~3465-3478):
     - Delete the `const ccrStatus = detectCcrCli();` line
     - Delete the `const ccrSlots = classified.externalPrimary.filter(...)` line filtering by display_type
     - Delete the `const ccrSlotNames = ccrSlots.map(p => p.name);` line
     - Delete the CCR auto-include block:
       ```javascript
       // CCR slots: auto-include all when binary found
       const selected = [];
       if (ccrStatus.found && ccrSlotNames.length > 0) {
         for (const name of ccrSlotNames) selected.push(name);
       }
       ```
     - Replace `const selected = [];` with `const selected = [];` (keep initialization for non-CCR CLIs)

  4. **Remove CCR status printing** (lines ~3493-3499):
     - Delete the if/else block that prints ccr binary found/not-found status
     - Delete the hint: `const hint = CLI_INSTALL_HINTS.ccr || 'npm i -g @musistudio/claude-code-router';`

  5. **Remove detectCcrCli() function** if present:
     - Search for function definition `function detectCcrCli()` around line ~465
     - Delete entire function (approximately 6 lines)

  6. **Verify no CCR references remain**:
     - Search for any remaining 'ccr' references (case-insensitive grep)
     - Remove any comments mentioning CCR presets
     - Remove any conditional logic checking for CCR slots
     - Remove any display_type checks for 'claude-code-router'

  **What to avoid:**
  - Do NOT remove legitimate uses of 'ccr' string if it appears in variable names unrelated to CCR presets (verify context)
  - Do NOT break the classifyProviders() function - keep it but it should return empty ccr array
  - Do NOT modify ensureMcpSlotsFromProviders() - it reads providers.json and should work fine without CCR entries
  </action>
  <verify>
  1. Search for CCR references: `grep -i "ccr" bin/install.js` should return no results (or only in unrelated context)
  2. Run install.js: `node bin/install.js --claude --global` should complete without CCR-related output
  3. Run install.js and verify no CCR preset sync warnings appear
  4. Verify promptProviders() no longer references detectCcrCli or ccrStatus
  5. Verify no sync-ccr-presets.cjs invocation exists
  </verify>
  <done>
  All CCR preset references removed from install.js. No sync-ccr-presets.cjs invocation remains. No CCR detection, auto-include, or status printing logic exists. promptProviders() handles only non-CCR external CLIs. No CCR-related comments or conditional logic remain.
  </done>
</task>

<task type="auto">
  <name>Task 3: Clean up and verify manifest-driven CLI detection</name>
  <files>bin/install.js</files>
  <action>
  Final cleanup and verification of manifest-driven CLI detection:

  1. **Verify providers.json structure compatibility**:
     - Ensure detectExternalClis() correctly reads from providers array
     - Verify mainTool field is used for CLI name resolution (not display_type)
     - Ensure display_provider and description fields are used in status output
     - Check that cli field (if null) is handled correctly (fallback to mainTool)

  2. **Update non-CCR external CLI filter**:
     - In promptProviders(), line ~3471: `const nonCcrExternal = classified.externalPrimary.filter(p => p.display_type !== 'claude-code-router');`
     - Since CCR entries are removed from providers.json, this filter is now redundant
     - Replace with: `const nonCcrExternal = classified.externalPrimary;` (or rename variable to `externalPrimary`)

  3. **Clean up unused variables**:
     - Remove any variables that were only used for CCR detection (e.g., ccrSlots, ccrSlotNames if they still exist)
     - Remove unused imports if any (check for sync-ccr-presets related requires)

  4. **Add manifest error handling with context**:
     - In the providers.json validation step (Task 1), enhance error message:
       ```javascript
       if (!providersData || !Array.isArray(providersData.providers)) {
         console.error('ERROR: Invalid providers.json format. Expected { providers: [...] }');
         process.exit(1);
       }
       if (providersData.providers.length === 0) {
         console.error('ERROR: No providers found in providers.json. Cannot detect CLIs.');
         process.exit(1);
       }
       ```

  5. **Add verbose logging for manifest-driven detection** (when --verbose flag set):
     - Log manifest load: `log('Loaded manifest with ${providers.length} providers');`
     - Log detection results: `log('Detected ${foundClis.length} CLIs: ${foundClis.map(c => c.name).join(', ') || 'none'}');`

  6. **Verify providers.json is read-only**:
     - Search for any `fs.writeFileSync` or `fs.appendFileSync` calls targeting providers.json
     - If found, remove them (manifest should be read-only)
     - Ensure no code attempts to modify the providers array

  **What to avoid:**
  - Do NOT add new features beyond cleanup and verification
  - Do NOT modify providers.json schema or add new fields
  - Do NOT change the existing user consent prompt behavior
  - Do NOT remove error handling added in Task 1
  </action>
  <verify>
  1. Test with valid manifest: `node bin/install.js --claude --global --verbose` should show manifest load and detection logs
  2. Test with empty providers array: Temporarily modify providers.json to have empty providers array, run install.js - should exit with "No providers found" error
  3. Test invalid manifest: Temporarily corrupt providers.json (invalid JSON), run install.js - should exit with "Invalid providers.json format" error
  4. Verify no writes to providers.json: Run install.js and check git status - providers.json should be unchanged
  5. Run test suite: `npm test` should pass (if there are existing install.js tests)
  </verify>
  <done>
  install.js correctly uses providers.json as read-only manifest. All CCR-related cleanup is complete. Manifest validation errors provide clear guidance. Non-CCR external CLI filter is simplified. Verbose logging shows detection details. No code attempts to modify providers.json.
  </done>
</task>

</tasks>

<verification>
Overall verification of issue 149 completion:

1. **Manifest-driven detection**: install.js reads providers.json at startup and validates it exists
2. **Detect commands**: install.js runs resolveCli() for each provider's mainTool field
3. **Status output**: Clear found/not-found status printed per CLI before prompting
4. **User consent**: Per-CLI confirmation prompts (y/N) unless --auto or explicit flags used
5. **CCR removal**: All CCR preset references removed from install.js (no sync, no detection, no auto-include)
6. **Read-only manifest**: install.js never writes to providers.json or creates state files
7. **Error handling**: Clear error message when providers.json is missing or invalid

Run: `npm test` to verify existing tests still pass
Run: `node bin/install.js --claude --global` to verify end-to-end flow
</verification>

<success_criteria>
- install.js reads providers.json manifest and validates it at startup
- CLI detection uses mainTool field from manifest entries
- Found/not-found status displayed per CLI before prompting
- Per-CLI confirmation prompts appear in interactive mode
- Auto mode (--auto or explicit flags) skips prompts
- All CCR preset references removed (sync, detection, status)
- install.js never modifies providers.json
- Clear error message when manifest is missing or invalid
- Existing tests pass
</success_criteria>

<output>
After completion, create `.planning/quick/407-issue-149/407-SUMMARY.md`
</output>
