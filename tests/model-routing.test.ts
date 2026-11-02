import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { createApi } from '../apps/api/server.ts';
import { apiRuntime } from '../apps/api/config.ts';
import { gatewayModel, arkStream } from '../apps/agent/provider.ts';
import { ToolContextArchive } from '../apps/agent/tool-context.ts';
import { DEFAULT_AGENT_MODEL, DEFAULT_VISION_MODEL } from '../packages/shared/model-budget.ts';

test('actual Pi/gateway preserves the 128000 ceiling and DeepSeek tool reasoning; switching physical model drops old reasoning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lm-model-routing-'));
  const requests: any[] = [];
  const privateReplayFixture = 'fixture-reasoning-private-for-same-model-only';
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'OK' } }],
          usage: { total_tokens: 12 },
        }),
      );
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const delta =
      requests.length === 1
        ? {
            role: 'assistant',
            reasoning_content: privateReplayFixture,
            tool_calls: [
              {
                index: 0,
                id: 'fixture-observe',
                type: 'function',
                function: { name: 'observe', arguments: '{}' },
              },
            ],
          }
        : { role: 'assistant', content: 'TOOL_RESULT_VERIFIED' };
    const chunk = (delta: object, finish_reason: string | null) =>
      'data: ' +
      JSON.stringify({
        id: 'routing-fixture',
        model: body.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      '\n\n';
    res.write(chunk(delta, null));
    res.write(chunk({}, requests.length === 1 ? 'tool_calls' : 'stop'));
    res.end(
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const api = await createApi({
    dataDir: root,
    arkKey: 'routing-fixture-key',
    arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    adminEmail: 'routing@example.test',
    adminPassword: 'Routing-test-password-2026',
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const auth = (
      await api.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'routing@example.test', password: 'Routing-test-password-2026' },
      })
    ).json();
    const headers = { authorization: 'Bearer ' + auth.token };
    const patch = (payload: object) =>
      api.app.inject({ method: 'PATCH', url: '/api/admin/model', headers, payload });
    const saved = await patch({
      modelId: DEFAULT_AGENT_MODEL,
      maxOutputTokens: 128000,
      contextWindowTokens: 1024000,
      revision: 0,
    });
    assert.equal(saved.statusCode, 200);
    assert.equal((await patch({ maxOutputTokens: 384001, revision: 1 })).statusCode, 400);
    assert.equal((await patch({ contextWindowTokens: 64000, revision: 1 })).statusCode, 400);
    let observed = 0;
    const tool: AgentTool = {
      name: 'observe',
      label: 'observe',
      description: 'Read actual fixture',
      parameters: Type.Object({}),
      execute: async () => {
        observed++;
        return { content: [{ type: 'text', text: 'actual-fixture-result' }], details: {} };
      },
    };
    const url = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
    const archive = new ToolContextArchive(api.store);
    const agent = new Agent({
      initialState: {
        systemPrompt: 'Read the fixture before answering.',
        model: gatewayModel(url, 1024000, 128000, DEFAULT_AGENT_MODEL),
        tools: [tool],
      },
      streamFn: arkStream(auth.token),
      prepareRequest: ({ context }) => ({
        context: {
          ...context,
          messages: archive.normalize(context.messages, {
            ownerId: auth.user.id,
            projectId: 'routing-fixture-project',
            sessionId: 'routing-fixture-session',
            runId: 'routing-fixture-run',
          }),
        },
      }),
    });
    await agent.prompt('Observe the fixture.');
    assert.equal(observed, 1);
    assert.equal(requests.length, 2);
    for (const body of requests) {
      assert.equal(body.model, DEFAULT_AGENT_MODEL);
      assert.equal(body.max_tokens, 128000);
      assert.equal(body.max_completion_tokens, undefined);
      assert.equal(body.thinking.type, 'enabled');
      assert.equal(body.reasoning_effort, 'high');
    }
    assert.equal(
      requests[1].messages.find((m: any) => m.role === 'assistant')?.reasoning_content,
      privateReplayFixture,
    );
    const compatibility = await api.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers,
      payload: {
        model: 'doubao',
        messages: [{ role: 'user', content: 'Length alias' }],
        max_completion_tokens: 384000,
      },
    });
    assert.equal(compatibility.statusCode, 200);
    assert.equal(
      requests[2].max_tokens,
      128000,
      'backend configured ceiling remains authoritative',
    );
    assert.equal(requests[2].max_completion_tokens, undefined);
    assert.equal(
      (
        await api.app.inject({
          method: 'POST',
          url: '/api/v1/chat/completions',
          headers,
          payload: {
            model: 'doubao',
            messages: [{ role: 'user', content: 'ambiguous' }],
            max_tokens: 1,
            max_completion_tokens: 1,
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await patch({ modelId: DEFAULT_VISION_MODEL, maxOutputTokens: 4096, revision: 1 }))
        .statusCode,
      200,
    );
    agent.state.model = gatewayModel(url, 1024000, 4096, DEFAULT_VISION_MODEL);
    await agent.prompt('Confirm the prior observed result.');
    assert.equal(requests.length, 4);
    assert.equal(requests[3].model, DEFAULT_VISION_MODEL);
    assert.equal(requests[3].thinking.type, 'disabled');
    assert(
      !JSON.stringify(requests[3]).includes(privateReplayFixture),
      'cross-model thoughts must not enter visible or hidden replay',
    );
  } finally {
    await api.app.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test('deployment accepts the requested DeepSeek budget and rejects invalid output settings before launch', () => {
  const env = {
    ARK_MODEL_ID: DEFAULT_AGENT_MODEL,
    ARK_CONTEXT_WINDOW_TOKENS: '1024000',
    ARK_MAX_OUTPUT_TOKENS: '128000',
  };
  const cfg = apiRuntime(env);
  assert.equal(cfg.options.maxOutputTokens, 128000);
  assert.equal(cfg.options.contextWindowTokens, 1024000);
  for (const change of [
    { ARK_MAX_OUTPUT_TOKENS: '384001' },
    { ARK_CONTEXT_WINDOW_TOKENS: '64000' },
    { ARK_MAX_OUTPUT_TOKENS: '128000.5' },
    { ARK_MAX_OUTPUT_TOKENS: 'NaN' },
  ])
    assert.throws(() => apiRuntime({ ...env, ...change }));
});
