'use strict';

/**
 * Session insights handler for /nf:observe
 * Analyzes Claude session JSONL transcripts for friction patterns:
 * 1. Repeated tool failures (same tool failing 3+ times)
 * 2. Long sessions (50+ assistant turns)
 * 3. Circuit breaker triggers
 * 4. Repeated file edits (same file edited 5+ times)
 * 5. Hook failures (progress events with error status)
 *
 * Returns standard observe schema: { source_label, source_type, status, issues[] }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { formatAgeFromMtime } = require('./observe-utils.cjs');

/**
 * Session insights handler
 * Scans recent JSONL transcripts for friction patterns.
 *
 * @param {object} sourceConfig - { label?, max_sessions?, max_file_size_bytes? }
 * @param {object} options - { projectRoot? }
 * @returns {object} Standard observe schema result
 */
function handleSessionInsights(sourceConfig, options) {
  // Tolerate a null/missing sourceConfig (dogfood: deref of null.label crashed the
  // handler before its try/catch).
  sourceConfig = sourceConfig || {};
  const label = sourceConfig.label || 'Session Insights';
  const maxSessions = validateMaxSessions(sourceConfig.max_sessions);
  const maxFileSize = sourceConfig.max_file_size_bytes || 5242880; // 5MB default

  try {
    const projectRoot = (options && options.projectRoot) || process.cwd();
    const issues = [];

    // Discover the project-specific session directory
    const projectDir = findProjectSessionDir(projectRoot);
    if (!projectDir || !fs.existsSync(projectDir)) {
      return {
        source_label: label,
        source_type: 'session-insights',
        status: 'ok',
        issues: []
      };
    }

    // List .jsonl files sorted by mtime descending, take top N
    const sessionFiles = listSessionFiles(projectDir, maxSessions, maxFileSize);

    // Analyze each session file
    for (const fileInfo of sessionFiles) {
      const sessionIssues = analyzeSession(fileInfo, maxFileSize);
      issues.push(...sessionIssues);
    }

    return {
      source_label: label,
      source_type: 'session-insights',
      status: 'ok',
      issues
    };
  } catch (err) {
    return {
      source_label: label,
      source_type: 'session-insights',
      status: 'error',
      error: `Session insights failed: ${err.message}`,
      issues: []
    };
  }
}

/**
 * Validate max_sessions parameter — must be a positive integer, defaults to 20
 */
function validateMaxSessions(val) {
  if (val === undefined || val === null) return 20;
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || Math.floor(num) !== num) return 20;
  return num;
}

/**
 * Find the project-specific session directory under ~/.claude/projects/
 * The directory name is the URL-encoded project root path.
 */
function findProjectSessionDir(projectRoot) {
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return null;

    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Decode the directory name and compare with projectRoot
      try {
        const decoded = decodeURIComponent(entry.name);
        if (decoded === projectRoot) {
          return path.join(projectsDir, entry.name);
        }
      } catch (_) {
        // If decode fails, try direct comparison
      }
      // Also try matching the raw name (path separators encoded as hyphens or similar)
      const normalized = projectRoot.replace(/\//g, '-').replace(/^-/, '');
      if (entry.name === normalized || entry.name.includes(normalized)) {
        return path.join(projectsDir, entry.name);
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * List .jsonl files in a directory, sorted by mtime descending, limited to maxSessions.
 * Skips files smaller than 500 bytes.
 */
function listSessionFiles(dir, maxSessions, maxFileSize) {
  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const fileInfos = [];

    for (const name of entries) {
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size < 500) continue; // Skip tiny files
        if (stat.size > maxFileSize) continue; // Skip oversized files
        fileInfos.push({ name, path: fullPath, mtime: stat.mtime, size: stat.size });
      } catch (_) {
        continue;
      }
    }

    // Sort by mtime descending (newest first)
    fileInfos.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return fileInfos.slice(0, maxSessions);
  } catch (_) {
    return [];
  }
}

/**
 * Analyze a single session JSONL file for friction patterns.
 * Returns an array of issues found.
 */
function analyzeSession(fileInfo) {
  const issues = [];
  // Guard a missing `name` and a null/invalid `mtime`: both used to throw — the
  // mtime `.toISOString()` threw INSIDE the try/catch, silently discarding every
  // detected issue for the session (dogfood: silent issue-drop).
  fileInfo = fileInfo || {};
  if (!(fileInfo.mtime instanceof Date) || Number.isNaN(fileInfo.mtime.getTime())) {
    fileInfo.mtime = new Date(0);
  }
  const sessionHash = (fileInfo.name || '').slice(0, 8);

  try {
    const content = fs.readFileSync(fileInfo.path, 'utf8');
    const lines = content.split('\n');

    // Tracking structures
    const toolFailures = {}; // tool name -> { count, lastError }
    let assistantTurns = 0;
    let circuitBreakerTriggered = false;
    const fileEdits = {}; // file path -> count
    const hookFailures = []; // hook names

    // Correlate tool_use IDs to tool names
    const toolUseMap = {}; // tool_use_id -> tool name

    for (const line of lines) {
      if (!line.trim()) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue; // Skip malformed lines
      }

      // Count assistant turns
      if (msg.type === 'assistant') {
        assistantTurns++;

        // Check assistant content for circuit breaker
        if (Array.isArray(msg.message && msg.message.content)) {
          for (const block of msg.message.content) {
            // Tool use entries
            if (block.type === 'tool_use') {
              toolUseMap[block.id] = block.name;

              // Track file edits from Edit/Write tool use
              const filePath = (block.input && block.input.file_path) || (block.input && block.input.path);
              if (filePath && (block.name === 'Edit' || block.name === 'Write')) {
                fileEdits[filePath] = (fileEdits[filePath] || 0) + 1;
              }
            }
            // Check text blocks for OSCILLATION_DETECTED
            if (block.type === 'text' && typeof block.text === 'string') {
              if (block.text.includes('OSCILLATION_DETECTED')) {
                circuitBreakerTriggered = true;
              }
            }
          }
        }

        // Also check top-level content array (some formats)
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolUseMap[block.id] = block.name;
              const filePath = (block.input && block.input.file_path) || (block.input && block.input.path);
              if (filePath && (block.name === 'Edit' || block.name === 'Write')) {
                fileEdits[filePath] = (fileEdits[filePath] || 0) + 1;
              }
            }
            if (block.type === 'text' && typeof block.text === 'string') {
              if (block.text.includes('OSCILLATION_DETECTED')) {
                circuitBreakerTriggered = true;
              }
            }
          }
        }
      }

      // Check tool results (user messages)
      if (msg.type === 'user') {
        const contentArr = (msg.message && msg.message.content) || msg.content;
        if (Array.isArray(contentArr)) {
          for (const block of contentArr) {
            if (block.type === 'tool_result' && block.is_error) {
              const toolName = toolUseMap[block.tool_use_id] || 'unknown';
              if (!toolFailures[toolName]) {
                toolFailures[toolName] = { count: 0, lastError: '' };
              }
              toolFailures[toolName].count++;
              const errContent = typeof block.content === 'string' ? block.content : '';
              if (errContent) {
                toolFailures[toolName].lastError = errContent.slice(0, 120);
              }
            }
          }
        }
      }

      // Check progress events for circuit breaker and hook failures
      if (msg.type === 'progress' && msg.data) {
        if (msg.data.type === 'hook_progress') {
          // Circuit breaker detection
          if (typeof msg.data.hook === 'string' && msg.data.hook.includes('nf-circuit-breaker')) {
            circuitBreakerTriggered = true;
          }
          // Hook failure detection
          const hookStatus = msg.data.status || msg.data.state || '';
          if (/error|fail/i.test(hookStatus)) {
            const hookName = msg.data.hook || msg.data.name || 'unknown';
            hookFailures.push(hookName);
          }
        }
      }
    }

    // Category 1: Repeated tool failures (3+ times)
    for (const [toolName, data] of Object.entries(toolFailures)) {
      if (data.count >= 3) {
        issues.push({
          id: `session-insights-tool-failure-${sessionHash}`,
          category: 'Tool Failures',
          title: `Tool '${toolName}' failed ${data.count} times in session ${fileInfo.name}`,
          severity: 'warning',
          url: '',
          age: formatAgeFromMtime(fileInfo.mtime),
          created_at: fileInfo.mtime.toISOString(),
          meta: data.lastError || 'Repeated tool failures detected',
          source_type: 'session-insights',
          issue_type: 'issue'
        });
      }
    }

    // Category 2: Long sessions (50+ assistant turns)
    if (assistantTurns >= 50) {
      issues.push({
        id: `session-insights-long-session-${sessionHash}`,
        category: 'Long Sessions',
        title: `Long session (${assistantTurns} turns): ${fileInfo.name}`,
        severity: 'info',
        url: '',
        age: formatAgeFromMtime(fileInfo.mtime),
        created_at: fileInfo.mtime.toISOString(),
        meta: `${assistantTurns} assistant turns detected`,
        source_type: 'session-insights',
        issue_type: 'issue'
      });
    }

    // Category 3: Circuit breaker triggers
    if (circuitBreakerTriggered) {
      issues.push({
        id: `session-insights-circuit-breaker-${sessionHash}`,
        category: 'Circuit Breaker',
        title: `Circuit breaker triggered in session ${fileInfo.name}`,
        severity: 'warning',
        url: '',
        age: formatAgeFromMtime(fileInfo.mtime),
        created_at: fileInfo.mtime.toISOString(),
        meta: 'Oscillation or circuit breaker event detected',
        source_type: 'session-insights',
        issue_type: 'issue'
      });
    }

    // Category 4: Repeated file edits (5+ times)
    for (const [filePath, count] of Object.entries(fileEdits)) {
      if (count >= 5) {
        issues.push({
          id: `session-insights-file-churn-${sessionHash}`,
          category: 'File Churn',
          title: `File '${filePath}' edited ${count} times in session ${fileInfo.name}`,
          severity: 'warning',
          url: '',
          age: formatAgeFromMtime(fileInfo.mtime),
          created_at: fileInfo.mtime.toISOString(),
          meta: 'Suggests iteration churn',
          source_type: 'session-insights',
          issue_type: 'issue'
        });
      }
    }

    // Category 5: Hook failures
    if (hookFailures.length > 0) {
      const uniqueHooks = [...new Set(hookFailures)];
      for (const hookName of uniqueHooks) {
        issues.push({
          id: `session-insights-hook-failure-${sessionHash}`,
          category: 'Hook Failures',
          title: `Hook failure in session ${fileInfo.name}`,
          severity: 'info',
          url: '',
          age: formatAgeFromMtime(fileInfo.mtime),
          created_at: fileInfo.mtime.toISOString(),
          meta: `Hook: ${hookName}`,
          source_type: 'session-insights',
          issue_type: 'issue'
        });
      }
    }
  } catch (_) {
    // Fail-open per session — skip this file
  }

  return issues;
}

// Export internals for testing
module.exports = {
  handleSessionInsights,
  validateMaxSessions,
  findProjectSessionDir,
  listSessionFiles,
  analyzeSession
};
