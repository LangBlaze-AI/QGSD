# VHS tape for capturing nForma TUI screenshots
# Usage: vhs scripts/tui-screenshot.tape
# Captures 11 screenshots across all modules, sub-views, and modals.
# Output: docs/assets/tui-*.png
# Note: VHS does not support F1-F5 keys, so we use Tab to cycle modules.
# Module order: Agents(0) → Reqs(1) → Config(2) → Sessions(3) → Solve(4)

Set Shell "zsh"
Set FontSize 36
Set Width 3600
Set Height 2000
Set Theme {"name":"nForma","black":"#1a1b26","red":"#f7768e","green":"#9ece6a","yellow":"#e0af68","blue":"#7aa2f7","magenta":"#bb9af7","cyan":"#7dcfff","white":"#a9b1d6","brightBlack":"#414868","brightRed":"#f7768e","brightGreen":"#9ece6a","brightYellow":"#e0af68","brightBlue":"#7aa2f7","brightMagenta":"#bb9af7","brightCyan":"#7dcfff","brightWhite":"#c0caf5","background":"#1a1a1a","foreground":"#a9b1d6","selection":"#283457","cursor":"#c0caf5"}
Set Padding 0
Set TypingSpeed 0ms

# Launch TUI
Type@500ms "export PATH=$PATH:$(ls -d ~/Library/Application\\ Support/Claude/claude-code/*/ 2>/dev/null | tail -1) && unset CLAUDECODE"
Enter
Sleep 500ms
Type `cd "${NF_REPO:-$PWD}" && node bin/nForma.cjs`
Enter
Sleep 8s

# ──────────────────────────────────────────────
# 1. Agents > List Agents (default on launch)
# ──────────────────────────────────────────────
Screenshot docs/assets/tui-agents.png
Sleep 500ms

# ──────────────────────────────────────────────
# 2. Agents > Live Health (item index 13)
#    Navigate 13 items down from List Agents
# ──────────────────────────────────────────────
Down
Down
Down
Down
Down
Down
Down
Down
Down
Down
Down
Down
Down
Sleep 500ms
Enter
Sleep 5s
Screenshot docs/assets/tui-agents-health.png
Sleep 500ms

# ──────────────────────────────────────────────
# 3. Agents > Scoreboard (item index 14)
#    Navigate down 1 from Live Health
# ──────────────────────────────────────────────
Down
Sleep 500ms
Enter
Sleep 2s
Screenshot docs/assets/tui-agents-scoreboard.png
Sleep 500ms

# ──────────────────────────────────────────────
# 9. Modal: Add Agent (item index 1)
#    Navigate back to top, then down 1
# ──────────────────────────────────────────────
Up
Up
Up
Up
Up
Up
Up
Up
Up
Up
Up
Up
Up
Up
Sleep 500ms
Down
Sleep 500ms
Enter
Sleep 2s
Screenshot docs/assets/tui-modal-add-agent.png
Sleep 500ms
Escape
Sleep 1s

# ──────────────────────────────────────────────
# 4. Reqs > Browse Reqs (Tab to next module)
# ──────────────────────────────────────────────
Tab
Sleep 2s
Screenshot docs/assets/tui-reqs.png
Sleep 500ms

# ──────────────────────────────────────────────
# 5. Reqs > Coverage (item index 1)
# ──────────────────────────────────────────────
Down
Sleep 500ms
Enter
Sleep 2s
Screenshot docs/assets/tui-reqs-coverage.png
Sleep 500ms

# ──────────────────────────────────────────────
# 6. Config > Settings (Tab to next module)
# ──────────────────────────────────────────────
Tab
Sleep 2s
Screenshot docs/assets/tui-config.png
Sleep 500ms

# ──────────────────────────────────────────────
# 10. Modal: Settings (Enter on Settings item 0)
# ──────────────────────────────────────────────
Enter
Sleep 2s
Screenshot docs/assets/tui-modal-settings.png
Sleep 500ms
Escape
Sleep 1s

# ──────────────────────────────────────────────
# 7. Sessions overview (Tab to next module)
# ──────────────────────────────────────────────
Tab
Sleep 2s
Screenshot docs/assets/tui-sessions.png
Sleep 500ms

# ──────────────────────────────────────────────
# 8. Solve > Browse Items (Tab to next module)
# ──────────────────────────────────────────────
Tab
Sleep 2s
Screenshot docs/assets/tui-solve.png
Sleep 500ms

# ──────────────────────────────────────────────
# 11. Sessions > Real Claude Code session
#     Tab 4x from Solve → Agents → Reqs → Config → Sessions
# ──────────────────────────────────────────────
Tab
Sleep 1s
Tab
Sleep 1s
Tab
Sleep 1s
Tab
Sleep 2s
# Enter on "New Session" to open name prompt
Enter
Sleep 2s
# Type session name and confirm
Type "demo"
Enter
Sleep 2s
# Accept default working directory
Enter
Sleep 12s
# Claude should be loaded — take screenshot
Screenshot docs/assets/tui-session-claude.png
Sleep 500ms

# ──────────────────────────────────────────────
# Disconnect from session and quit
# ──────────────────────────────────────────────
# Ctrl+\ disconnects from terminal back to menu
Ctrl+\
Sleep 2s
Type "q"
Sleep 500ms
