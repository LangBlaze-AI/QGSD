const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  handleGitHub,
  handleSentry,
  handleSentryFeedback,
  handleBash,
  mapSentryIssuesToSchema,
  mapSentryFeedbackToSchema,
  parseDuration,
  formatAge,
  classifySeverityFromLabels
} = require('./observe-handlers.cjs');

// Mock execFileSync that returns controlled output
function mockExecFile(responses) {
  return function (cmd, args, opts) {
    const key = `${cmd} ${args[0]}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error(`Unexpected command: ${key}`);
  };
}

describe('parseDuration', () => {
  it('parses days', () => assert.equal(parseDuration('7d'), 604800000));
  it('parses hours', () => assert.equal(parseDuration('24h'), 86400000));
  it('parses minutes', () => assert.equal(parseDuration('30m'), 1800000));
  it('returns 0 for invalid', () => assert.equal(parseDuration('abc'), 0));
  it('returns 0 for null', () => assert.equal(parseDuration(null), 0));
});

describe('formatAge', () => {
  it('formats minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    assert.equal(formatAge(fiveMinAgo), '5m');
  });

  it('formats hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    assert.equal(formatAge(twoHoursAgo), '2h');
  });

  it('formats days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    assert.equal(formatAge(threeDaysAgo), '3d');
  });

  it('returns unknown for null', () => assert.equal(formatAge(null), 'unknown'));
});

describe('classifySeverityFromLabels', () => {
  it('detects bug label', () => {
    assert.equal(classifySeverityFromLabels([{ name: 'bug' }]), 'bug');
  });

  it('detects error label', () => {
    assert.equal(classifySeverityFromLabels([{ name: 'error' }]), 'error');
  });

  it('detects warning label', () => {
    assert.equal(classifySeverityFromLabels(['warning']), 'warning');
  });

  it('returns info for no match', () => {
    assert.equal(classifySeverityFromLabels([{ name: 'feature' }]), 'info');
  });

  it('returns info for empty array', () => {
    assert.equal(classifySeverityFromLabels([]), 'info');
  });

  it('prioritizes higher severity', () => {
    assert.equal(classifySeverityFromLabels([{ name: 'bug' }, { name: 'critical' }]), 'critical');
  });
});

describe('handleGitHub', () => {
  const sampleGhOutput = JSON.stringify([
    {
      number: 42,
      title: 'TypeError in handler',
      url: 'https://github.com/owner/repo/issues/42',
      labels: [{ name: 'bug' }],
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      assignees: [{ login: 'dev1' }]
    },
    {
      number: 43,
      title: 'Feature request',
      url: 'https://github.com/owner/repo/issues/43',
      labels: [{ name: 'enhancement' }],
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      assignees: []
    }
  ]);

  it('maps gh CLI JSON to standard schema', () => {
    const execFn = mockExecFile({
      'git remote': 'git@github.com:owner/repo.git',
      'gh issue': sampleGhOutput
    });

    const result = handleGitHub({ type: 'github', label: 'GH' }, { execFn });
    assert.equal(result.status, 'ok');
    assert.equal(result.source_type, 'github');
    assert.equal(result.source_label, 'GH');
    assert.equal(result.issues.length, 2);
    assert.equal(result.issues[0].id, 'gh-42');
    assert.equal(result.issues[0].severity, 'bug');
    assert.equal(result.issues[0].source_type, 'github');
    assert.equal(result.issues[0].issue_type, 'issue');
  });

  it('uses repo from config', () => {
    let capturedArgs;
    const execFn = (cmd, args, opts) => {
      if (cmd === 'gh') {
        capturedArgs = args;
        return sampleGhOutput;
      }
      throw new Error('unexpected');
    };

    handleGitHub({ type: 'github', label: 'GH', repo: 'custom/repo' }, { execFn });
    assert.ok(capturedArgs.includes('custom/repo'));
  });

  it('returns error status on failure (not thrown)', () => {
    const execFn = () => { throw new Error('gh not found'); };
    const result = handleGitHub({ type: 'github', label: 'GH', repo: 'x/y' }, { execFn });
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('gh not found'));
    assert.deepEqual(result.issues, []);
  });

  it('applies since filter correctly', () => {
    const oldIssue = JSON.stringify([
      {
        number: 1,
        title: 'Old issue',
        url: '',
        labels: [],
        createdAt: new Date(Date.now() - 30 * 86400000).toISOString(), // 30 days ago
        assignees: []
      },
      {
        number: 2,
        title: 'New issue',
        url: '',
        labels: [],
        createdAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        assignees: []
      }
    ]);

    const execFn = mockExecFile({
      'git remote': 'git@github.com:owner/repo.git',
      'gh issue': oldIssue
    });

    const result = handleGitHub(
      { type: 'github', label: 'GH', filter: { since: '7d' } },
      { execFn }
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].title, 'New issue');
  });

  it('returns error when repo cannot be determined', () => {
    const execFn = mockExecFile({
      'git remote': ''
    });
    const result = handleGitHub({ type: 'github', label: 'GH' }, { execFn });
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('Could not determine repo'));
  });
});

describe('handleSentry', () => {
  it('returns pending_mcp status with correct _mcp_instruction', () => {
    const result = handleSentry(
      { type: 'sentry', label: 'Sentry', project: 'myorg/myproj', filter: { status: 'unresolved', since: '48h' } },
      {}
    );
    assert.equal(result.status, 'pending_mcp');
    assert.deepEqual(result.issues, []);
    assert.equal(result._mcp_instruction.type, 'mcp');
    assert.equal(result._mcp_instruction.tool, 'list_project_issues');
    assert.equal(result._mcp_instruction.params.organization_slug, 'myorg');
    assert.equal(result._mcp_instruction.params.project_slug, 'myproj');
    assert.ok(result._mcp_instruction.params.query.includes('unresolved'));
    assert.equal(result._mcp_instruction.mapper, 'mapSentryIssuesToSchema');
  });

  it('uses defaults for missing filter', () => {
    const result = handleSentry({ type: 'sentry', label: 'S' }, {});
    assert.equal(result.status, 'pending_mcp');
    assert.ok(result._mcp_instruction.params.query.includes('unresolved'));
    assert.ok(result._mcp_instruction.params.query.includes('24h'));
  });

  it('has standard schema fields', () => {
    const result = handleSentry({ type: 'sentry', label: 'S' }, {});
    assert.ok('source_label' in result);
    assert.ok('source_type' in result);
    assert.ok('status' in result);
    assert.ok('issues' in result);
  });
});

describe('mapSentryIssuesToSchema', () => {
  it('maps MCP result to standard schema', () => {
    const mcpResult = [
      {
        id: '12345',
        title: 'TypeError: undefined',
        level: 'error',
        permalink: 'https://sentry.io/issue/12345',
        firstSeen: new Date(Date.now() - 3600000).toISOString(),
        count: 42,
        userCount: 5
      }
    ];

    const result = mapSentryIssuesToSchema(mcpResult, { label: 'Sentry' });
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, 'sentry-12345');
    assert.equal(result.issues[0].severity, 'error');
    assert.ok(result.issues[0].meta.includes('42 events'));
    assert.equal(result.issues[0].source_type, 'sentry');
  });

  it('maps severity levels correctly', () => {
    const mcpResult = [
      { id: '1', title: 'Fatal', level: 'fatal', count: 1, userCount: 1 },
      { id: '2', title: 'Warn', level: 'warning', count: 1, userCount: 1 },
      { id: '3', title: 'Info', level: 'info', count: 1, userCount: 1 }
    ];

    const result = mapSentryIssuesToSchema(mcpResult, { label: 'S' });
    assert.equal(result.issues[0].severity, 'error'); // fatal -> error
    assert.equal(result.issues[1].severity, 'warning');
    assert.equal(result.issues[2].severity, 'info');
  });

  it('handles empty MCP result', () => {
    const result = mapSentryIssuesToSchema([], { label: 'S' });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.issues, []);
  });
});

describe('handleSentryFeedback', () => {
  it('returns pending_mcp status with correct _mcp_instruction', () => {
    const result = handleSentryFeedback(
      { type: 'sentry-feedback', label: 'FB', project: 'org/proj' },
      {}
    );
    assert.equal(result.status, 'pending_mcp');
    assert.equal(result._mcp_instruction.tool, 'list_user_feedback');
    assert.equal(result._mcp_instruction.params.organization_slug, 'org');
    assert.equal(result._mcp_instruction.params.project_slug, 'proj');
    assert.equal(result._mcp_instruction.mapper, 'mapSentryFeedbackToSchema');
  });

  it('has standard schema fields', () => {
    const result = handleSentryFeedback({ type: 'sentry-feedback', label: 'FB' }, {});
    assert.ok('source_label' in result);
    assert.ok('source_type' in result);
    assert.ok('status' in result);
    assert.ok('issues' in result);
  });
});

describe('mapSentryFeedbackToSchema', () => {
  it('maps feedback with title truncation and [Feedback] prefix', () => {
    const mcpResult = [
      {
        id: 'fb-1',
        comments: 'This is a short comment',
        email: 'user@test.com',
        dateCreated: new Date().toISOString()
      }
    ];

    const result = mapSentryFeedbackToSchema(mcpResult, { label: 'FB' });
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].title.startsWith('[Feedback] '));
    assert.equal(result.issues[0].severity, 'info');
    assert.ok(result.issues[0].meta.includes('user@test.com'));
  });

  it('truncates long comments to 80 chars', () => {
    const longComment = 'A'.repeat(100);
    const mcpResult = [{ id: 'fb-2', comments: longComment }];

    const result = mapSentryFeedbackToSchema(mcpResult, { label: 'FB' });
    assert.ok(result.issues[0].title.length < 100);
    assert.ok(result.issues[0].title.includes('...'));
  });

  it('handles anonymous feedback', () => {
    const mcpResult = [{ id: 'fb-3', comments: 'hello' }];
    const result = mapSentryFeedbackToSchema(mcpResult, { label: 'FB' });
    assert.equal(result.issues[0].meta, 'anonymous');
  });
});

describe('handleBash', () => {
  it('parses multiline output', () => {
    const execFn = (cmd, args, opts) => 'line one\nline two\nline three\n';
    const result = handleBash(
      { type: 'bash', label: 'TODO', command: 'echo test' },
      { execFn }
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 3);
    assert.equal(result.issues[0].id, 'bash-0');
    assert.equal(result.issues[0].title, 'line one');
    assert.equal(result.issues[0].severity, 'info');
  });

  it('parses JSON output', () => {
    const jsonOutput = JSON.stringify([
      { title: 'Issue A', severity: 'warning', url: 'http://example.com' },
      { title: 'Issue B' }
    ]);
    const execFn = () => jsonOutput;
    const result = handleBash(
      { type: 'bash', label: 'JSON', command: 'echo json', parser: 'json' },
      { execFn }
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 2);
    assert.equal(result.issues[0].title, 'Issue A');
    assert.equal(result.issues[0].severity, 'warning');
    assert.equal(result.issues[1].severity, 'info'); // default
  });

  it('returns error on failure (not thrown)', () => {
    const execFn = () => { throw new Error('command not found'); };
    const result = handleBash(
      { type: 'bash', label: 'Bad', command: 'nonexistent' },
      { execFn }
    );
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('command not found'));
    assert.deepEqual(result.issues, []);
  });

  it('returns error when no command configured', () => {
    const result = handleBash({ type: 'bash', label: 'Empty' }, {});
    assert.equal(result.status, 'error');
    assert.ok(result.error.includes('No command configured'));
  });
});

describe('standard schema compliance', () => {
  const requiredFields = ['source_label', 'source_type', 'status', 'issues'];

  it('handleGitHub returns all required fields', () => {
    const execFn = mockExecFile({
      'git remote': 'git@github.com:o/r.git',
      'gh issue': '[]'
    });
    const result = handleGitHub({ type: 'github', label: 'GH' }, { execFn });
    for (const field of requiredFields) {
      assert.ok(field in result, `Missing field: ${field}`);
    }
  });

  it('handleSentry returns all required fields', () => {
    const result = handleSentry({ type: 'sentry', label: 'S' }, {});
    for (const field of requiredFields) {
      assert.ok(field in result, `Missing field: ${field}`);
    }
  });

  it('handleSentryFeedback returns all required fields', () => {
    const result = handleSentryFeedback({ type: 'sentry-feedback', label: 'FB' }, {});
    for (const field of requiredFields) {
      assert.ok(field in result, `Missing field: ${field}`);
    }
  });

  it('handleBash returns all required fields', () => {
    const execFn = () => 'test\n';
    const result = handleBash({ type: 'bash', label: 'B', command: 'echo test' }, { execFn });
    for (const field of requiredFields) {
      assert.ok(field in result, `Missing field: ${field}`);
    }
  });
});

describe('mapSentryIssuesToSchema malformed-element resilience', () => {
  it('skips null entries and keeps valid issues instead of dropping all', () => {
    const mcpResult = [
      null,
      { id: '99', title: 'Real issue', level: 'error', firstSeen: new Date(Date.now() - 3600000).toISOString(), count: 1, userCount: 1 }
    ];
    const result = mapSentryIssuesToSchema(mcpResult, { label: 'S' });
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].id, 'sentry-99');
  });
});

describe('mapSentryFeedbackToSchema malformed-element resilience', () => {
  it('skips null feedback entries and keeps valid ones', () => {
    const mcpResult = [null, { id: 'fb-9', comments: 'real feedback' }];
    const result = mapSentryFeedbackToSchema(mcpResult, { label: 'FB' });
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.ok(result.issues[0].title.includes('real feedback'));
  });
});

describe('handleBash json malformed-element resilience', () => {
  it('skips null elements in JSON output instead of dropping all issues', () => {
    const jsonOutput = JSON.stringify([null, { title: 'Real issue' }]);
    const execFn = () => jsonOutput;
    const result = handleBash(
      { type: 'bash', label: 'JSON', command: 'echo json', parser: 'json' },
      { execFn }
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].title, 'Real issue');
  });
});
