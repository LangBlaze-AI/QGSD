'use strict';
// bin/execution-progress.test.cjs
// Tests for file-based execution progress tracking.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
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
} = require('./execution-progress.cjs');

let tmpDir;

function freshTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-progress-'));
  return tmpDir;
}

function cleanTmp() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

describe('execution-progress', () => {

  describe('constants', () => {
    it('exports expected constants', () => {
      assert.equal(PROGRESS_FILE, '.planning/execution-progress.json');
      assert.equal(DEFAULT_MAX_ITERATIONS, 5);
      assert.equal(STUCK_THRESHOLD, 3);
    });
  });

  describe('getProgressPath', () => {
    it('returns path joining cwd with PROGRESS_FILE', () => {
      const result = getProgressPath('/some/dir');
      assert.equal(result, '/some/dir/.planning/execution-progress.json');
    });
  });

  describe('initProgress', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('creates valid JSON file matching schema', () => {
      const result = initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 3,
        taskNames: ['Task 1: Create module', 'Task 2: Extend hook', 'Task 3: Wire workflow'],
      });

      assert.equal(result.version, 1);
      assert.equal(result.total_tasks, 3);
      assert.equal(result.status, 'in_progress');
      assert.equal(result.iteration_count, 0);
      assert.equal(result.max_iterations, 5);
      assert.equal(result.last_known_commit, null);
      assert.equal(result.tasks.length, 3);
      assert.equal(result.tasks[0].number, 1);
      assert.equal(result.tasks[0].status, 'pending');
      assert.equal(result.tasks[0].commit_hash, null);
      assert.equal(result.tasks[0].completed_at, null);
      assert.equal(result.tasks[0].resume_attempts, 0);
      assert.ok(result.started_at);
      assert.ok(result.updated_at);

      // Verify file was written
      const filePath = getProgressPath(tmpDir);
      assert.ok(fs.existsSync(filePath));
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(written.version, 1);
    });

    it('extracts phase/plan from planFile string', () => {
      const result = initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      assert.equal(result.phase, 'v0.30-02');
      assert.equal(result.plan, '01');
    });

    it('overwrites stale progress from a different plan (idempotent)', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-01-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Old Task 1', 'Old Task 2'],
      });

      const result = initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 3,
        taskNames: ['New Task 1', 'New Task 2', 'New Task 3'],
      });

      assert.equal(result.plan_file, 'v0.30-02-01-PLAN.md');
      assert.equal(result.total_tasks, 3);
      assert.equal(result.tasks.length, 3);
      assert.equal(result.iteration_count, 0);
    });
  });

  describe('completeTask', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('marks task complete with commit hash and timestamp', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 3,
        taskNames: ['Task 1', 'Task 2', 'Task 3'],
      });

      const result = completeTask(tmpDir, { taskNumber: 1, commitHash: 'abc1234' });

      assert.equal(result.tasks[0].status, 'complete');
      assert.equal(result.tasks[0].commit_hash, 'abc1234');
      assert.ok(result.tasks[0].completed_at);
      assert.equal(result.last_known_commit, 'abc1234');
      assert.equal(result.status, 'in_progress');
    });

    it('sets root status to "complete" when ALL tasks are done', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      completeTask(tmpDir, { taskNumber: 1, commitHash: 'abc1234' });
      const result = completeTask(tmpDir, { taskNumber: 2, commitHash: 'def5678' });

      assert.equal(result.status, 'complete');
    });

    it('returns null when file does not exist', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-nofile-'));
      try {
        const result = completeTask(dir, { taskNumber: 1, commitHash: 'abc1234' });
        assert.equal(result, null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns null when task number not found', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const result = completeTask(tmpDir, { taskNumber: 99, commitHash: 'abc1234' });
      assert.equal(result, null);
    });
  });

  describe('getStatus', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('returns { status: "no_progress_file" } when file missing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-nostatus-'));
      try {
        const result = getStatus(dir);
        assert.deepStrictEqual(result, { status: 'no_progress_file' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns full progress object when file exists', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const result = getStatus(tmpDir);
      assert.equal(result.version, 1);
      assert.equal(result.status, 'in_progress');
      assert.equal(result.tasks.length, 2);
    });

    it('does NOT modify the file (read-only)', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const filePath = getProgressPath(tmpDir);
      const contentBefore = fs.readFileSync(filePath, 'utf8');
      getStatus(tmpDir);
      const contentAfter = fs.readFileSync(filePath, 'utf8');

      assert.equal(contentAfter, contentBefore);
    });
  });

  describe('incrementIteration', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('increments counter and writes updated file', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const result = incrementIteration(tmpDir);
      assert.equal(result.iteration_count, 1);
      assert.equal(result.status, 'in_progress');

      const onDisk = JSON.parse(fs.readFileSync(getProgressPath(tmpDir), 'utf8'));
      assert.equal(onDisk.iteration_count, 1);
    });

    it('sets status to "failed" with reason "iteration_cap_exhausted" when counter reaches max_iterations', () => {
      const progress = initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const filePath = getProgressPath(tmpDir);
      progress.iteration_count = DEFAULT_MAX_ITERATIONS - 1;
      fs.writeFileSync(filePath, JSON.stringify(progress, null, 2), 'utf8');

      const result = incrementIteration(tmpDir);
      assert.equal(result.iteration_count, DEFAULT_MAX_ITERATIONS);
      assert.equal(result.status, 'failed');
      assert.equal(result.failure_reason, 'iteration_cap_exhausted');
    });

    it('detects stuck-on-task: same task in_progress across 3 increments', () => {
      const progress = initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 3,
        taskNames: ['Task 1', 'Task 2', 'Task 3'],
      });

      progress.tasks[1].status = 'in_progress';
      fs.writeFileSync(getProgressPath(tmpDir), JSON.stringify(progress, null, 2), 'utf8');

      incrementIteration(tmpDir);
      incrementIteration(tmpDir);
      const result = incrementIteration(tmpDir);

      assert.equal(result.status, 'failed');
      assert.equal(result.failure_reason, 'stuck_on_task');
      assert.equal(result.stuck_task, 2);
      assert.equal(result.tasks[1].resume_attempts, 3);
    });

    it('returns null when file does not exist', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-noiter-'));
      try {
        const result = incrementIteration(dir);
        assert.equal(result, null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('clearProgress', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('removes the file', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-02-01-PLAN.md',
        totalTasks: 1,
        taskNames: ['Task 1'],
      });

      const filePath = getProgressPath(tmpDir);
      assert.ok(fs.existsSync(filePath));

      clearProgress(tmpDir);
      assert.ok(!fs.existsSync(filePath));
    });

    it('is a no-op when file does not exist (no throw)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-noclear-'));
      try {
        assert.doesNotThrow(() => clearProgress(dir));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('done_conditions', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('initProgress with doneConditions stores conditions on tasks', () => {
      const result = initProgress(tmpDir, {
        planFile: 'v0.30-05-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
        doneConditions: [[{ type: 'file_exists', path: 'foo.txt' }], []],
      });

      assert.equal(result.tasks[0].done_conditions.length, 1);
      assert.equal(result.tasks[0].done_conditions[0].type, 'file_exists');
      assert.equal(result.tasks[1].done_conditions.length, 0);
    });

    it('initProgress without doneConditions defaults to empty arrays', () => {
      const result = initProgress(tmpDir, {
        planFile: 'v0.30-05-01-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      assert.deepStrictEqual(result.tasks[0].done_conditions, []);
      assert.deepStrictEqual(result.tasks[1].done_conditions, []);
    });

    it('completeTask with passing done_conditions marks complete', () => {
      // Create a temp file that the condition will check for
      const testFile = path.join(tmpDir, 'condition-target.txt');
      fs.writeFileSync(testFile, 'exists', 'utf8');

      initProgress(tmpDir, {
        planFile: 'v0.30-05-01-PLAN.md',
        totalTasks: 1,
        taskNames: ['Task 1'],
        doneConditions: [[{ type: 'file_exists', path: 'condition-target.txt' }]],
      });

      const result = completeTask(tmpDir, { taskNumber: 1, commitHash: 'abc1234' });
      assert.equal(result.tasks[0].status, 'complete');
      assert.equal(result.tasks[0].commit_hash, 'abc1234');
    });

    it('completeTask with failing done_conditions sets blocked status', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-05-01-PLAN.md',
        totalTasks: 1,
        taskNames: ['Task 1'],
        doneConditions: [[{ type: 'file_exists', path: 'nonexistent-file-xyz.txt' }]],
      });

      const result = completeTask(tmpDir, { taskNumber: 1, commitHash: 'abc1234' });
      assert.equal(result.tasks[0].status, BLOCKED_STATUS);
      assert.equal(result.tasks[0].block_reason, 'done_conditions_failed');
    });

    it('BLOCKED_STATUS constant is exported', () => {
      assert.equal(BLOCKED_STATUS, 'blocked');
    });
  });

  describe('aggregateParallelProgress', () => {
    before(() => freshTmp());
    after(() => cleanTmp());

    it('merges task statuses from two worktree progress files correctly', () => {
      // Initialize main progress with 3 tasks
      initProgress(tmpDir, {
        planFile: 'v0.30-07-02-PLAN.md',
        totalTasks: 3,
        taskNames: ['Task 1', 'Task 2', 'Task 3'],
      });

      // Create worktree progress data (simulating two worktrees)
      const wt1Progress = {
        tasks: [
          { number: 1, status: 'complete', commit_hash: 'aaa1111', completed_at: '2026-03-08T10:00:00Z' },
          { number: 2, status: 'pending', commit_hash: null, completed_at: null },
          { number: 3, status: 'pending', commit_hash: null, completed_at: null },
        ],
      };
      const wt2Progress = {
        tasks: [
          { number: 1, status: 'pending', commit_hash: null, completed_at: null },
          { number: 2, status: 'complete', commit_hash: 'bbb2222', completed_at: '2026-03-08T10:01:00Z' },
          { number: 3, status: 'pending', commit_hash: null, completed_at: null },
        ],
      };

      const result = aggregateParallelProgress(tmpDir, [
        { worktreePath: '/tmp/wt1', progressData: wt1Progress },
        { worktreePath: '/tmp/wt2', progressData: wt2Progress },
      ]);

      assert.equal(result.tasks[0].status, 'complete');
      assert.equal(result.tasks[0].commit_hash, 'aaa1111');
      assert.equal(result.tasks[1].status, 'complete');
      assert.equal(result.tasks[1].commit_hash, 'bbb2222');
      assert.equal(result.tasks[2].status, 'pending');
      assert.equal(result.status, 'in_progress'); // Not all tasks complete
    });

    it('handles missing worktree progress (skip with no crash)', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-07-02-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const result = aggregateParallelProgress(tmpDir, [
        null,
        { worktreePath: '/tmp/bad', progressData: null },
        { worktreePath: '/tmp/ok', progressData: {
          tasks: [{ number: 1, status: 'complete', commit_hash: 'ccc3333', completed_at: '2026-03-08T10:02:00Z' }],
        }},
      ]);

      assert.equal(result.tasks[0].status, 'complete');
      assert.equal(result.tasks[0].commit_hash, 'ccc3333');
      assert.equal(result.tasks[1].status, 'pending');
    });

    it('handles empty worktree list (returns unchanged main progress)', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-07-02-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const result = aggregateParallelProgress(tmpDir, []);

      assert.equal(result.tasks[0].status, 'pending');
      assert.equal(result.tasks[1].status, 'pending');
      assert.equal(result.status, 'in_progress');
    });

    it('marks overall status as complete when all tasks are done after aggregation', () => {
      initProgress(tmpDir, {
        planFile: 'v0.30-07-02-PLAN.md',
        totalTasks: 2,
        taskNames: ['Task 1', 'Task 2'],
      });

      const wtProgress = {
        tasks: [
          { number: 1, status: 'complete', commit_hash: 'ddd4444', completed_at: '2026-03-08T10:03:00Z' },
          { number: 2, status: 'complete', commit_hash: 'eee5555', completed_at: '2026-03-08T10:04:00Z' },
        ],
      };

      const result = aggregateParallelProgress(tmpDir, [
        { worktreePath: '/tmp/wt', progressData: wtProgress },
      ]);

      assert.equal(result.status, 'complete');
      assert.equal(result.tasks[0].commit_hash, 'ddd4444');
      assert.equal(result.tasks[1].commit_hash, 'eee5555');
    });

    it('returns null when main progress file does not exist', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-noagg-'));
      try {
        const result = aggregateParallelProgress(dir, []);
        assert.equal(result, null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('getStatus corrupt-file hardening', () => {
    it('returns safe sentinel on corrupt JSON instead of throwing (fail-open)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-corrupt-'));
      try {
        const p = getProgressPath(dir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{ "version": 1, "tas', 'utf8'); // truncated/corrupt
        let result;
        assert.doesNotThrow(() => { result = getStatus(dir); });
        assert.deepStrictEqual(result, { status: 'no_progress_file' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('completeTask shape hardening', () => {
    it('returns null (no crash) when progress file has no tasks array', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-notasks-'));
      try {
        const p = getProgressPath(dir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ version: 1, status: 'in_progress' }), 'utf8');
        let result;
        assert.doesNotThrow(() => { result = completeTask(dir, { taskNumber: 1, commitHash: 'abc1234' }); });
        assert.equal(result, null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('initProgress null planFile hardening', () => {
    it('does not crash when planFile is null; defaults phase/plan', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-nullplan-'));
      try {
        let result;
        assert.doesNotThrow(() => {
          result = initProgress(dir, { planFile: null, totalTasks: 1, taskNames: ['Task 1'] });
        });
        assert.equal(result.phase, 'unknown');
        assert.equal(result.plan, '01');
        assert.equal(result.tasks.length, 1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
