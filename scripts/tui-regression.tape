# VHS regression tape for nForma TUI
# Usage: vhs scripts/tui-regression.tape
# Produces: test/golden/tui-{agents,reqs,reqs-coverage,config,solve}.txt
#
# These .txt captures are diffed by test/tui-regression.test.cjs
# to catch visual regressions in the TUI.
#
# Note: VHS does not support F1-F5, so we use Tab to cycle modules.
# Module order: Agents(0) → Reqs(1) → Config(2) → Sessions(3) → Solve(4)

Set Shell "zsh"
Set FontSize 14
Set Width 1920
Set Height 1080
Set Padding 0
Set TypingSpeed 0ms

# ── Launch TUI ───────────────────────────────────────────────────────────────
Type "cd ${NF_REPO:-$PWD} && node bin/nForma.cjs"
Enter
Sleep 6s

# ── 1. Agents module (default on launch) ─────────────────────────────────────
# The first item "List Agents" auto-renders the agent roster
Output test/golden/tui-agents.txt
Screenshot test/golden/tui-agents.png
Sleep 500ms

# ── 2. Reqs module > Browse Reqs ─────────────────────────────────────────────
Tab
Sleep 4s
# Browse Reqs is first item — auto-selected on module switch
Enter
Sleep 4s
Output test/golden/tui-reqs.txt
Screenshot test/golden/tui-reqs.png
Sleep 500ms

# ── 3. Reqs module > Coverage ────────────────────────────────────────────────
Down
Sleep 1s
Enter
Sleep 4s
Output test/golden/tui-reqs-coverage.txt
Screenshot test/golden/tui-reqs-coverage.png
Sleep 500ms

# ── 4. Config module ─────────────────────────────────────────────────────────
Tab
Sleep 4s
Output test/golden/tui-config.txt
Screenshot test/golden/tui-config.png
Sleep 500ms

# ── 5. Sessions module ───────────────────────────────────────────────────────
Tab
Sleep 4s
Output test/golden/tui-sessions.txt
Sleep 500ms

# ── 6. Solve module ──────────────────────────────────────────────────────────
Tab
Sleep 4s
Output test/golden/tui-solve.txt
Screenshot test/golden/tui-solve.png
Sleep 500ms

# ── Quit ─────────────────────────────────────────────────────────────────────
Type "q"
Sleep 1s
