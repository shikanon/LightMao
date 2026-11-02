import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolOutput, TOOL_CONTEXT_LIMITS } from '../apps/agent/tool-context.ts';
import { engineDiagnostics } from '../apps/agent/engine-runner.ts';
test('large engine output retains the actionable error, source location and log reference ahead of generic job metadata', () => {
  const diagnosed = engineDiagnostics(
    '',
    'SCRIPT ERROR: Parse Error: Cannot infer variable type.\n  at: GDScript::reload (res://main.gd:42)\nERROR: Failed to load script.',
  );
  const job = {
    id: 'actual-job-id',
    projectId: 'project',
    runId: 'run',
    action: 'validate',
    frames: 180,
    timeoutSeconds: 120,
    requestId: 'request',
    status: 'failed',
    stage: 'finished',
    version: '4.7',
    executableSha256: '0'.repeat(64),
    startedAt: 'date',
    endedAt: 'date',
    error: 'engine reported errors',
    code: 'engine_failed',
    snapshot: { files: 3000 },
    phases: [{ name: 'import', errorCount: 2, code: 0 }],
    artifacts: [],
    diagnostics: diagnosed.diagnostics,
    verification: 'not_run',
    logRef: 'actual-job-id',
    noise: 'irrelevant'.repeat(3000),
  };
  const summary = summarizeToolOutput('run_godot', JSON.stringify(job), true);
  assert(summary.length <= TOOL_CONTEXT_LIMITS.result);
  assert(summary.includes('res://main.gd:42'));
  assert(summary.includes('Cannot infer variable type'));
  assert(summary.includes('actual-job-id'));
  assert(summary.includes('engine_failed'));
  assert(!summary.includes('irrelevant'.repeat(100)));
});
