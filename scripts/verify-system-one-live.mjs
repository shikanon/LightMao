import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { jevQuestions, jevDecision } from '../packages/shared/system-one.ts';

process.loadEnvFile();
const id = randomUUID();
const dir = await mkdtemp(join(tmpdir(), 'lm-ark-system-one-'));
await chmod(dir, 0o700);
await mkdir('.lightmao/verification', { recursive: true, mode: 0o700 });
const path = resolve(`.lightmao/verification/system-one-live-${id}.json`);
const receipt = {
  id,
  at: new Date().toISOString(),
  requestCap: 1,
  requestSent: false,
  passed: false,
  dir,
  scope:
    'One Ark System One decision over synthetic, nonprivate observed controls; no browser action, media generation or TypeSafe request.',
};
const save = () => writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await save();
if (!process.env.ARK_API_KEY) throw Error('ARK_API_KEY is not configured');
const api = await createApi({
  dataDir: dir,
  arkKey: process.env.ARK_API_KEY,
  arkBase: process.env.ARK_BASE_URL,
  decisionModelId: process.env.ARK_SYSTEM_ONE_MODEL_ID,
  modelId: process.env.ARK_MODEL_ID,
});
try {
  const registration = await api.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      name: 'System One verification',
      email: `system-one-${id}@example.test`,
      password: randomUUID() + '-Verify1',
    },
  });
  assert.equal(registration.statusCode, 200);
  const login = registration.json();
  const observation = {
    id: 'live-' + id,
    url: 'http://127.0.0.1/synthetic-game',
    title: '试玩入口',
    text: '当前位于游戏主菜单。可见按钮：开始游戏、设置。尚未开始。',
    actions: [
      { id: 'click:1', node: 'start-node', operation: 'CLICK', label: '开始游戏' },
      { id: 'click:2', node: 'settings-node', operation: 'CLICK', label: '设置' },
    ],
  };
  const request = jevQuestions(
    observation,
    '点击开始游戏按钮，进入游戏；现在尚在菜单，不应选择 DONE。',
  );
  receipt.requestSent = true;
  receipt.submissionIntentAt = new Date().toISOString();
  await save();
  const result = await api.app.inject({
    method: 'POST',
    url: '/api/v1/systemone',
    headers: { authorization: `Bearer ${login.token}` },
    payload: request,
  });
  receipt.status = result.statusCode;
  const usage = api.store
    .list('usage')
    .map(
      ({
        id,
        model,
        status,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        upstreamStatus,
      }) => ({
        id,
        model,
        status,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        upstreamStatus,
      }),
    );
  receipt.usage = usage;
  assert.equal(
    result.statusCode,
    200,
    'System One rejected the request; inspect metadata receipt, do not retry automatically.',
  );
  const response = result.json();
  const decision = jevDecision(request, response, observation);
  receipt.decision = decision;
  receipt.model = response.model;
  assert.equal(decision.operation, 'CLICK');
  assert.equal(decision.action.id, 'click:1');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].status, 'completed');
  receipt.passed = true;
} catch (error) {
  receipt.error =
    error instanceof assert.AssertionError
      ? 'Verification assertion failed; no automatic retry.'
      : 'Verification did not finish; inspect local metadata before another submission.';
  process.exitCode = 1;
} finally {
  await api.app.close();
  await save();
}
console.log(
  JSON.stringify({
    receipt: path,
    passed: receipt.passed,
    status: receipt.status,
    model: receipt.model,
    usage: receipt.usage,
  }),
);
