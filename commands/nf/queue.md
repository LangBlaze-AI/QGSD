---
name: nf:queue
description: Queue a skill or command to auto-invoke after the next /clear
argument-hint: <command to queue, e.g. "/nf:quick --full">
allowed-tools:
  - Bash
  - Write
---

<objective>
Write a pending-task file so the specified command auto-invokes on the next user prompt
after a `/clear`. Uses session-scoped file naming to prevent cross-session delivery.
</objective>

<process>
1. Get the task from `$ARGUMENTS`. If empty, show usage and stop.

2. Determine the session-scoped filename:
   - Use `CLAUDE_SESSION_ID` env var if set, else use `CLAUDE_INSTANCE_ID`, else fall back to the generic name.
   - Session-scoped: `.claude/pending-task-<sessionId>.txt`
   - Generic fallback: `.claude/pending-task.txt`

3. Write the task text to the file (create `.claude/` dir if needed).
   Overwrite any existing pending task for this session.

4. Confirm to the user:
   ```
   Queued: <task>
   File:   .claude/pending-task-<sessionId>.txt (or pending-task.txt)

   Now run /clear. Your next prompt will auto-invoke: <task>
   ```

5. Do NOT run the task now. Just write the file and confirm.
</process>

<implementation>
Run this bash to determine the file path and write it:

```bash
SESSION_ID="${CLAUDE_SESSION_ID:-${CLAUDE_INSTANCE_ID:-}}"
CLAUDE_DIR=".claude"
mkdir -p "$CLAUDE_DIR"
if [ -n "$SESSION_ID" ]; then
  FILE="$CLAUDE_DIR/pending-task-$SESSION_ID.txt"
else
  FILE="$CLAUDE_DIR/pending-task.txt"
fi
cat > "$FILE" <<'NF_QUEUE_TASK'
$ARGUMENTS
NF_QUEUE_TASK
echo "file=$FILE"
```

Then confirm to the user with the file path and next step.
</implementation>
