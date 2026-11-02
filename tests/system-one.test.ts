import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import {
  checkedChoice,
  decisionRequest,
  jevDecision,
  jevQuestions,
  type DecisionObservation,
} from '../packages/shared/system-one.ts';

const observation: DecisionObservation = {
  id: 'observed-1',
  url: 'http://127.0.0.1/game/',
  title: '测试游戏',
  text: '开始游戏；难度普通',
  actions: [
    { id: 'click:1', node: 'node-1', operation: 'CLICK', label: '开始游戏' },
    { id: 'click:2', node: 'node-2', operation: 'CLICK', label: '设置' },
    { id: 'fill:3', node: 'node-3', operation: 'TYPE_TEXT', label: '玩家名称' },
  ],
};
const choice = (selected: string, ids: string[]) => ({
  type: 'choice',
  choice: selected,
  confidence: 0.98,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
});
test('Jev uses one shared observation, dynamic heads, observed actions only and validates only the selected target head', () => {
  const request = jevQuestions(observation, '开始游戏');
  assert.deepEqual(Object.keys(request.questions), [
    'operation',
    'click_target',
    'type_text_target',
  ]);
  const selected = jevDecision(
    request,
    {
      model: 'ark-decision',
      answers: {
        operation: choice('CLICK', ['CLICK', 'TYPE_TEXT', 'DONE', 'BLOCKED']),
        click_target: choice('click:1', ['click:1', 'click:2']),
        type_text_target: { malformedUnusedHead: true },
      },
    },
    observation,
  );
  assert.equal(selected.action?.id, 'click:1');
  assert.equal(selected.observationId, observation.id);
  assert.equal(selected.action?.node, 'node-1');
  assert.throws(() =>
    jevDecision(
      request,
      {
        model: 'ark',
        answers: {
          operation: choice('CLICK', ['CLICK', 'TYPE_TEXT', 'DONE', 'BLOCKED']),
          click_target: choice('click:99', ['click:99']),
        },
      },
      observation,
    ),
  );
  assert.throws(() =>
    jevQuestions(
      { ...observation, actions: [...observation.actions, observation.actions[0]] },
      '开始',
    ),
  );
});
test('invalid decision probabilities, nonmaximum choice and mismatched candidate sets never become actions', () => {
  for (const value of [
    { choice: 'a', confidence: 1, probabilities: { a: 0.1, b: 0.9 } },
    { choice: 'a', confidence: NaN, probabilities: { a: 1, b: 0 } },
    { choice: 'a', confidence: 1, probabilities: { a: 1, b: 1 } },
    { choice: 'a', confidence: 1, probabilities: { a: 1 } },
    { choice: 'a', confidence: 1, probabilities: { a: Infinity, b: 0 } },
  ])
    assert.throws(() => checkedChoice(value, ['a', 'b']));
  assert.throws(() => decisionRequest.parse({ model: 'system-one', state: 'x', questions: {} }));
});
test('Jev prioritizes observed effects over label-only history and carries wait/reversible-setting constraints into both heads', () => {
  const automated: DecisionObservation = {
    ...observation,
    id: 'after-observed-rate-change',
    gameState: { phase: 'playing', auto: true, playbackRate: 4, elapsed: 12 },
    actions: [
      { id: 'game:tempo', operation: 'PRESS_KEY', label: '切换播放速度', key: '2', holdMs: 20 },
      { id: 'wait', operation: 'WAIT', label: '等待1秒后重新观察' },
    ],
    recentActions: [
      {
        actionId: 'game:tempo',
        operation: 'PRESS_KEY',
        label: '切换播放速度',
        observationId: 'before-observed-rate-change',
        afterObservationId: 'after-observed-rate-change',
        at: '2026-11-02T10:00:00.000Z',
        elapsedMs: 52,
        beforeGameState: { phase: 'playing', auto: true, playbackRate: 1, elapsed: 11 },
        afterGameState: { phase: 'playing', auto: true, playbackRate: 4, elapsed: 12 },
        changedKeys: ['playbackRate', 'elapsed'],
      },
    ],
  };
  const request = jevQuestions(automated, '让自动流程推进直到结束', [
    { target: '只含过时标签的历史' },
  ]);
  const state = request.state as Record<string, any>;
  assert.equal(state.action_history_source, 'executor_observed_before_after');
  assert.equal(state.recent_actions[0].actionId, 'game:tempo');
  assert.equal(state.recent_actions[0].beforeGameState.playbackRate, 1);
  assert.equal(state.recent_actions[0].afterGameState.playbackRate, 4);
  const opRules = JSON.stringify(request.questions.operation.instructions),
    targetRules = JSON.stringify(request.questions.press_key_target.instructions);
  assert(opRules.includes('优先 WAIT'));
  assert(targetRules.includes('反复操作可能撤销'));
  const question = request.questions.press_key_target;
  assert.equal(question.type, 'choice');
  if (question.type !== 'choice') throw Error('Missing observed head');
  assert.deepEqual(Object.keys(question.criteria), ['game:tempo']);
  assert.deepEqual((question.criteria['game:tempo'] as any).recent_observed_use, {
    count: 1,
    afterObservationId: 'after-observed-rate-change',
    changedKeys: ['playbackRate', 'elapsed'],
  });
  const selected = jevDecision(
    request,
    {
      model: 'local-decision-fixture',
      answers: {
        operation: choice('WAIT', ['WAIT', 'PRESS_KEY', 'DONE', 'BLOCKED']),
        wait_target: choice('wait', ['wait']),
        press_key_target: { unusedAndUntrusted: true },
      },
    },
    automated,
  );
  assert.equal(selected.operation, 'WAIT');
  assert.equal(selected.action?.id, 'wait');
  assert(!JSON.stringify(selected).includes('selector'));
  assert(
    !('wait_target' in jevQuestions(observation, '开始游戏').questions),
    'No synthetic WAIT target when it was not observed',
  );
  const legacy = [{ operation: 'CLICK', target: '旧标签' }];
  const fallback = jevQuestions(observation, '开始游戏', legacy).state as Record<string, unknown>;
  assert.equal(fallback.action_history_source, 'caller_history_without_confirmed_effects');
  assert.deepEqual(
    fallback.recent_actions,
    legacy,
    'Legacy labels never become fabricated before/after evidence',
  );
});
test(
  'authenticated System One gateway replaces Jev model/provider, sends beta header once, accounts native usage and redacts upstream errors',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-system-one-'));
    const calls: { path: string; auth: string; beta: string; body: Record<string, unknown> }[] = [];
    let rejected = false;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({
        path: req.url!,
        auth: req.headers.authorization!,
        beta: String(req.headers['ark-beta-systemone-api']),
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (rejected) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'SECRET_UPSTREAM_BODY internal-token' }));
        return;
      }
      res.end(
        JSON.stringify({
          model: body.model,
          answers: { operation: choice('DONE', ['DONE', 'BLOCKED']) },
          usage: { input_tokens: 41, output_tokens: 0 },
        }),
      );
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'server-only-fixture-key',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v3`,
      decisionModelId: 'doubao-seed-2-1-lite-260915',
    });
    try {
      const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json();
      const headers = { authorization: `Bearer ${login.token}` };
      const request = {
        model: 'system-one',
        state: '观察到胜利界面',
        questions: {
          operation: { type: 'choice', criteria: { DONE: '胜利已展示', BLOCKED: '未展示' } },
        },
      };
      assert.equal(
        (await api.app.inject({ method: 'POST', url: '/api/v1/systemone', payload: request }))
          .statusCode,
        401,
      );
      const result = await api.app.inject({
        method: 'POST',
        url: '/api/v1/systemone',
        headers,
        payload: request,
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.json().answers.operation.choice, 'DONE');
      assert.equal(result.json().model, 'doubao-seed-2-1-lite-260915');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/api/v1/systemone');
      assert.equal(calls[0].auth, 'Bearer server-only-fixture-key');
      assert.equal(calls[0].beta, 'true');
      assert.equal(calls[0].body.model, 'doubao-seed-2-1-lite-260915');
      assert(!('stream' in calls[0].body));
      const deviceResult = await api.app.inject({
        method: 'POST',
        url: '/api/auth/device',
        headers,
        payload: { deviceId: randomUUID(), label: 'test' },
      });
      assert.equal(deviceResult.statusCode, 200, deviceResult.body);
      const device = deviceResult.json();
      const deviceResponse = await api.app.inject({
        method: 'POST',
        url: '/api/v1/systemone',
        headers: { authorization: `Bearer ${device.token}` },
        payload: request,
      });
      assert.equal(deviceResponse.statusCode, 200, deviceResponse.body);
      rejected = true;
      const failed = await api.app.inject({
        method: 'POST',
        url: '/api/v1/systemone',
        headers,
        payload: request,
      });
      assert.equal(failed.statusCode, 502);
      assert(!failed.body.includes('SECRET_UPSTREAM_BODY'));
      assert(!failed.body.includes('fixture-key'));
      assert.equal(calls.length, 3, 'No hidden provider retry');
      const usage = api.store.list<{
        status: string;
        totalTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
      }>('usage');
      assert.deepEqual(
        usage.map((v) => v.status),
        ['completed', 'completed', 'upstream_403'],
      );
      assert.equal(usage[0].totalTokens, 41);
      assert.equal(usage[0].completionTokens, 0);
      assert.equal(usage[2].totalTokens, undefined);
      assert(!JSON.stringify(usage).includes('观察到胜利界面'));
      assert(!JSON.stringify(usage).includes('internal-token'));
    } finally {
      await api.app.close();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
