#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROGRESS_FILE = '.planning/execution-progress.json';
const DEFAULT_MAX_ITERATIONS = 5;
const STUCK_THRESHOLD = 3;
const BLOCKED_STATUS = 'blocked';

function getProgressPath(cwd) {
  return path.join(cwd, PROGRESS_FILE);
}

function initProgress(cwd, { planFile, totalTasks, taskNames, doneConditions }) {
  const safePlanFile = typeof planFile === 'string' ? planFile : '';
  const progress = {
    version: 1,
    phase: safePlanFile.match(/v[\d.]+-\d+/)?.[0] || 'unknown',
    plan: safePlanFile.match(/-(\d+)-PLAN/)?.[1] || '01',
    plan_file: planFile,
    total_tasks: totalTasks,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    iteration_count: 0,
    max_iterations: DEFAULT_MAX_ITERATIONS,
    last_known_commit: null,
    tasks: taskNames.map((name, i) => ({
      number: i + 1,
      name,
      status: 'pending',
      commit_hash: null,
      completed_at: null,
      resume_attempts: 0,
      done_conditions: (doneConditions && doneConditions[i]) || [],
    })),
  };
  const progressPath = getProgressPath(cwd);
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');
  return progress;
}

function loadContinuousVerify() {
  try { return require(path.join(__dirname, 'continuous-verify.cjs')); } catch (_) { return null; }
}

function completeTask(cwd, { taskNumber, commitHash }) {
  const progressPath = getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return null;

  let progress;
  try {
    progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  } catch (_) { return null; }
  if (!progress || !Array.isArray(progress.tasks)) return null;
  const task = progress.tasks.find(t => t.number === taskNumber);
  if (!task) return null;

  // Evaluate done_conditions if present
  if (task.done_conditions && task.done_conditions.length > 0) {
    try {
      const cv = loadContinuousVerify();
      if (cv) {
        const { all_pass, results } = cv.evaluateAllConditions(cwd, task.done_conditions);
        if (!all_pass) {
          task.status = BLOCKED_STATUS;
          task.block_reason = 'done_conditions_failed';
          task.condition_results = results;
          progress.updated_at = new Date().toISOString();
          fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');
          return progress;
        }
      }
    } catch (_) {
      // fail-open: proceed with marking complete
    }
  }

  task.status = 'complete';
  task.commit_hash = commitHash;
  task.completed_at = new Date().toISOString();
  progress.updated_at = new Date().toISOString();
  progress.last_known_commit = commitHash;

  if (progress.tasks.every(t => t.status === 'complete' || t.status === 'skipped')) {
    progress.status = 'complete';
  }

  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');
  return progress;
}

function getStatus(cwd) {
  const progressPath = getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return { status: 'no_progress_file' };
  try {
    return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  } catch (_) {
    return { status: 'no_progress_file' };
  }
}

function incrementIteration(cwd) {
  const progressPath = getProgressPath(cwd);
  if (!fs.existsSync(progressPath)) return null;

  const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  progress.iteration_count += 1;
  progress.updated_at = new Date().toISOString();

  // Check iteration cap
  if (progress.iteration_count >= progress.max_iterations) {
    progress.status = 'failed';
    progress.failure_reason = 'iteration_cap_exhausted';
  }

  // Check stuck detection: same task in_progress for STUCK_THRESHOLD iterations
  const inProgressTask = progress.tasks.find(t => t.status === 'in_progress');
  if (inProgressTask) {
    inProgressTask.resume_attempts = (inProgressTask.resume_attempts || 0) + 1;
    if (inProgressTask.resume_attempts >= STUCK_THRESHOLD) {
      progress.status = 'failed';
      progress.failure_reason = 'stuck_on_task';
      progress.stuck_task = inProgressTask.number;
    }
  }

  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');
  return progress;
}

function clearProgress(cwd) {
  const progressPath = getProgressPath(cwd);
  if (fs.existsSync(progressPath)) {
    fs.unlinkSync(progressPath);
  }
}

function aggregateParallelProgress(mainCwd, worktreeProgressFiles) {
  const progressPath = getProgressPath(mainCwd);
  if (!fs.existsSync(progressPath)) {
    process.stderr.write('[execution-progress] No main progress file to aggregate into\n');
    return null;
  }

  const mainProgress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));

  if (!Array.isArray(worktreeProgressFiles) || worktreeProgressFiles.length === 0) {
    return mainProgress;
  }

  for (const entry of worktreeProgressFiles) {
    if (!entry || !entry.progressData) {
      process.stderr.write('[execution-progress] Skipping invalid worktree progress entry\n');
      continue;
    }

    const wtProgress = entry.progressData;
    if (!wtProgress.tasks || !Array.isArray(wtProgress.tasks)) {
      process.stderr.write('[execution-progress] Skipping worktree with no tasks array: ' + (entry.worktreePath || 'unknown') + '\n');
      continue;
    }

    for (const wtTask of wtProgress.tasks) {
      const mainTask = mainProgress.tasks.find(t => t.number === wtTask.number);
      if (!mainTask) continue;

      // Update from worktree version if task is complete there
      if (wtTask.status === 'complete') {
        mainTask.status = 'complete';
        mainTask.commit_hash = wtTask.commit_hash || mainTask.commit_hash;
        mainTask.completed_at = wtTask.completed_at || mainTask.completed_at;
      } else if (wtTask.status === 'in_progress' && mainTask.status === 'pending') {
        mainTask.status = 'in_progress';
      }
    }
  }

  // Check if all tasks are now complete
  if (mainProgress.tasks.every(t => t.status === 'complete' || t.status === 'skipped')) {
    mainProgress.status = 'complete';
  }

  mainProgress.updated_at = new Date().toISOString();
  fs.writeFileSync(progressPath, JSON.stringify(mainProgress, null, 2), 'utf8');
  return mainProgress;
}

// CLI interface
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const command = args[0];
    const cwd = process.cwd();

    function getArg(name) {
      const idx = args.indexOf('--' + name);
      if (idx === -1 || idx + 1 >= args.length) return null;
      return args[idx + 1];
    }

    switch (command) {
      case 'init': {
        const planFile = getArg('plan');
        const tasks = parseInt(getArg('tasks'), 10);
        const namesStr = getArg('names');
        const taskNames = namesStr ? namesStr.split(',').map(n => n.trim()) : [];
        // Pad or truncate taskNames to match tasks count
        while (taskNames.length < tasks) taskNames.push(`Task ${taskNames.length + 1}`);
        // Parse optional done_conditions (JSON string of array-of-arrays)
        const doneCondStr = getArg('done-conditions');
        let doneConditions;
        if (doneCondStr) {
          try { doneConditions = JSON.parse(doneCondStr); } catch (_) { doneConditions = undefined; }
        }
        const result = initProgress(cwd, { planFile, totalTasks: tasks, taskNames, doneConditions });
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'complete-task': {
        const number = parseInt(getArg('number'), 10);
        const commit = getArg('commit');
        const result = completeTask(cwd, { taskNumber: number, commitHash: commit });
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'get-status': {
        const result = getStatus(cwd);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'increment-iteration': {
        const result = incrementIteration(cwd);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      case 'clear': {
        clearProgress(cwd);
        process.stdout.write(JSON.stringify({ cleared: true }) + '\n');
        break;
      }
      case 'aggregate-parallel': {
        const worktreePaths = args.slice(1);
        const worktreeData = worktreePaths.map(p => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(p, PROGRESS_FILE), 'utf8'));
            return { worktreePath: p, progressData: data };
          } catch (_) { return null; }
        }).filter(Boolean);
        const result = aggregateParallelProgress(cwd, worktreeData);
        process.stdout.write(JSON.stringify(result) + '\n');
        break;
      }
      default:
        process.stderr.write('Unknown command: ' + command + '\n');
        process.stderr.write('Usage: execution-progress.cjs <init|complete-task|get-status|increment-iteration|clear>\n');
        process.exit(0);
    }
  } catch (e) {
    process.stderr.write('[execution-progress] Error: ' + e.message + '\n');
    process.exit(0); // Fail open
  }
}

module.exports = {
  getProgressPath,
  initProgress,
  completeTask,
  getStatus,
  incrementIteration,
  clearProgress,
  aggregateParallelProgress,
  PROGRESS_FILE,
  DEFAULT_MAX_ITERATIONS,
  STUCK_THRESHOLD,
  BLOCKED_STATUS,
};
