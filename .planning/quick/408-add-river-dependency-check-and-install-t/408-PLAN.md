---
phase: quick
plan: 408
type: execute
wave: 1
depends_on: []
files_modified: [bin/install.js]
autonomous: true
formal_artifacts: none

must_haves:
  truths:
    - "River ML installation is skipped when uv is not available on the system"
    - "River ML installation proceeds normally when uv is available"
  artifacts:
    - path: "bin/install.js"
      provides: "River ML dependency check and install step"
      min_lines: 25
      contains: "uvCheck"
  key_links:
    - from: "bin/install.js"
      to: "~/.claude/nf-python-env"
      via: "nfPythonEnv variable"
      pattern: "nfPythonEnv.*=.*path\\.join"
---

<objective>
Add uv availability check before attempting River ML installation in install.js.
</objective>

<context>
@bin/install.js (lines 2740-2790 — River ML installation block)

The current code uses `uv` directly without checking if it's available. It relies on try/catch fail-open behavior. This plan adds an explicit uv availability check upfront so the installation is skipped gracefully with a clear message when uv is not found.
</context>

<tasks>

<task type="auto">
  <name>Add uv availability check before river installation</name>
  <files>bin/install.js</files>
  <action>
    In the River ML installation block (around line 2744), add a check for uv availability using `spawnSync('which', ['uv'])` before any uv operations.

    Current code structure (lines 2744-2768):
    ```javascript
    {
      const { spawnSync: _spawnRiver } = require('child_process');
      const nfPythonEnv = path.join(os.homedir(), '.claude', 'nf-python-env');
      const nfPython = path.join(nfPythonEnv, 'bin', 'python');
      try {
        if (!fs.existsSync(nfPythonEnv)) {
          _spawnRiver('uv', ['venv', nfPythonEnv], { timeout: 30000 });
        }
        const riverCheck = _spawnRiver(nfPython, ['-c', 'import river'], { timeout: 3000 });
        if (riverCheck.status !== 0) {
          console.log(`  ${cyan}↓${reset} Installing River ML (uv)...`);
          const riverInstall = _spawnRiver('uv', ['pip', 'install', '--python', nfPythonEnv, 'river'], { timeout: 60000 });
          ...
        }
      } catch (e) { /* fail-open */ }
    }
    ```

    Change to:
    ```javascript
    {
      const { spawnSync: _spawnRiver } = require('child_process');
      const nfPythonEnv = path.join(os.homedir(), '.claude', 'nf-python-env');
      const nfPython = path.join(nfPythonEnv, 'bin', 'python');
      try {
        // Check uv availability first — skip river install if not found
        const uvCheck = _spawnRiver('which', ['uv'], { timeout: 3000 });
        if (uvCheck.status !== 0) {
          log(`  ${yellow}⚠${reset} uv not found — skipping River ML`);
          return;
        }
        if (!fs.existsSync(nfPythonEnv)) {
          _spawnRiver('uv', ['venv', nfPythonEnv], { timeout: 30000 });
        }
        const riverCheck = _spawnRiver(nfPython, ['-c', 'import river'], { timeout: 3000 });
        if (riverCheck.status !== 0) {
          console.log(`  ${cyan}↓${reset} Installing River ML (uv)...`);
          const riverInstall = _spawnRiver('uv', ['pip', 'install', '--python', nfPythonEnv, 'river'], { timeout: 60000 });
          ...
        }
      } catch (e) { /* fail-open */ }
    }
    ```
  </action>
  <verify>grep -n "uvCheck\|which.*uv" bin/install.js</verify>
  <done>River ML installation is skipped when uv is not available, with a log message</done>
</task>

</tasks>

<verification>
- `uvCheck.status !== 0` branch returns early from the block when uv is missing
- River installation proceeds normally through the existing path when uvCheck returns status 0
</verification>

<success_criteria>
- uv availability is checked before any uv spawn calls
- When uv is not found, a warning message is logged and river installation is skipped
- When uv is available, existing river installation logic runs unchanged
</success_criteria>

<output>
After completion, create `.planning/quick/408-add-river-dependency-check-and-install-t/408-SUMMARY.md`
</output>