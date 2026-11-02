import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Store } from '../packages/shared/store.ts';
import { ResourceLeases } from '../apps/agent/resource-leases.ts';
import { applyFileChanges } from '../apps/agent/shared-file-changes.ts';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import type { LocalBootstrap, Project, Run, SessionView } from '../packages/shared/types.ts';
import type { SubAgentTask } from '../packages/shared/collaboration.ts';
import { CollaborationService } from '../apps/agent/collaboration.ts';
import { GroundTruthService } from '../apps/agent/ground-truth.ts';
import { ProjectService } from '../apps/agent/projects.ts';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import type { GroundTruthEvidence } from '../packages/shared/collaboration.ts';

test('protected paths require fresh main-run image delivery and negative health cannot be overridden by a healthy report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-live-evidence-')),
    store = new Store(join(dir, 'local.sqlite')),
    ground = new GroundTruthService(store, dir);
  try {
    const source = ground.register('owner', 'project', {
      name: 'Monitor',
      pageUrl: 'http://127.0.0.1:9999/',
      healthUrl: 'http://127.0.0.1:9999/health',
      checks: [{ path: 'healthy', op: 'equals', value: true }],
      protectedPaths: ['config/'],
    });
    ground.requireChangesHealthy('owner', 'project', 'main', ['README.md']);
    assert.throws(
      () => ground.requireChangesHealthy('owner', 'project', 'main', ['config/release.json']),
      /截图/,
    );
    const evidence: GroundTruthEvidence = {
      id: 'trusted-service-fixture',
      projectId: 'project',
      sourceId: source.id,
      sessionId: 'session',
      runId: 'main',
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      screenshotSha256: 'a'.repeat(64),
      healthy: true,
      checks: [{ name: 'HTTP', passed: true, actual: '200' }],
      pageErrors: [],
    };
    store.put('ground-truth', 'owner', evidence);
    assert.throws(
      () => ground.requireChangesHealthy('owner', 'project', 'main', ['config/release.json']),
      /查验/,
    );
    ground.delivered('owner', 'project', 'main', evidence.id);
    ground.requireChangesHealthy('owner', 'project', 'main', ['config/release.json']);
    assert.throws(() =>
      ground.requireChangesHealthy('owner', 'project', 'other-run', ['config/release.json']),
    );
    store.put('ground-truth', 'owner', {
      ...ground.get('owner', 'project', evidence.id),
      healthy: false,
    });
    assert.throws(
      () => ground.requireChangesHealthy('owner', 'project', 'main', ['config/release.json']),
      /健康检查失败/,
    );
    store.put('ground-truth', 'owner', {
      ...ground.get('owner', 'project', evidence.id),
      healthy: true,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    assert.throws(
      () => ground.requireChangesHealthy('owner', 'project', 'main', ['config/release.json']),
      /过期/,
    );
    assert.throws(() => ground.source('other-owner', 'project', source.id));
  } finally {
    await ground.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'real isolated child branches reject stale merges, preserve external rollback edits, bound rolling windows and interrupt on restart',
  { skip: process.platform !== 'darwin', timeout: 40000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-child-versions-')),
      store = new Store(join(dir, 'local.sqlite'));
    const projects = new ProjectService(store, dir),
      executor = new IsolatedExecutor(dir),
      groundTruth = new GroundTruthService(store, dir);
    let childCalls = 0;
    const options = {
      store,
      dataDir: dir,
      projects,
      executor,
      groundTruth,
      runChild: async (ctx: any) => {
        childCalls++;
        await ctx.assertLive();
        if (ctx.task.role.kind === 'implementer')
          await executor.file(
            ctx.project.root,
            true,
            'write_file',
            { path: 'config.json', content: 'child-change' },
            ctx.signal,
          );
        return { summary: '旧缓存说一切正常；此为待核实报告。', turns: 3 };
      },
    };
    let service = new CollaborationService(options);
    try {
      assert.ok((await executor.ready()).available);
      const project = await projects.create('owner', {
        name: 'Versions',
        engine: 'Web',
        description: '',
      });
      await writeFile(join(project.root, 'config.json'), 'original');
      const plan = service.setPlan('owner', 'session', project.id, {
        objective: '合并当前版本并保护外部修改',
        milestones: ['验证版本和滚动窗口'],
        roles: [
          { id: 'builder', name: '实现', kind: 'implementer', writePaths: ['config.json'] },
          { id: 'reviewer', name: '审阅', kind: 'reviewer', writePaths: [] },
        ],
      });
      const dispatch = (roleId = 'builder') =>
        service.delegate('owner', 'fixture', 'session', project.id, 'parent', 'demo', {
          roleId,
          objective: '验证当前副本',
          acceptance: '主工程文件版本匹配',
          writePaths: roleId === 'builder' ? ['config.json'] : [],
          maxTurns: 3,
        });
      await assert.rejects(
        service.delegate('owner', 'fixture', 'session', project.id, 'parent', 'demo', {
          roleId: 'reviewer',
          objective: '越权写入',
          acceptance: '不应成功',
          writePaths: ['config.json'],
        }),
        /角色权限/,
      );
      const old = await dispatch();
      await service.wait('owner', project.id, old.id, 25);
      assert.equal(
        await readFile(join(project.root, 'config.json'), 'utf8'),
        'original',
        'child changes only its private copy',
      );
      await writeFile(join(project.root, 'config.json'), 'main-newer');
      await assert.rejects(service.verify('owner', project.id, 'parent', old.id), /版本/);
      assert.equal(service.get('owner', project.id, old.id).status, 'stale');
      assert.throws(() => service.nextWindow('owner', 'session', plan.revision), /核验/);
      await service.cancel('owner', project.id, old.id);
      const fresh = await dispatch();
      await service.wait('owner', project.id, fresh.id, 25);
      await service.verify('owner', project.id, 'parent', fresh.id);
      await service.merge('owner', project.id, 'parent', fresh.id, new AbortController().signal);
      const point = service.get('owner', project.id, fresh.id).checkpointId!;
      await writeFile(join(project.root, 'config.json'), 'external-human-edit');
      await assert.rejects(service.rollback('owner', project.id, point), /版本已变化/);
      assert.equal(
        await readFile(join(project.root, 'config.json'), 'utf8'),
        'external-human-edit',
      );
      assert.equal(service.leases.list('owner', project.id).length, 0);
      for (let i = 0; i < 2; i++) {
        const t = await dispatch('reviewer');
        await service.wait('owner', project.id, t.id, 25);
        await service.verify('owner', project.id, 'parent', t.id);
      }
      await assert.rejects(dispatch('reviewer'), /窗口/);
      const next = service.nextWindow('owner', 'session', plan.revision);
      assert.equal(next.window, 2);
      assert.equal(next.objective, plan.objective);
      const before = childCalls;
      await service.close();
      store.put('subagent-task', 'owner', {
        ...service.get('owner', project.id, fresh.id),
        status: 'running',
      });
      service = new CollaborationService(options);
      assert.equal(service.get('owner', project.id, fresh.id).status, 'interrupted');
      assert.equal(
        childCalls,
        before,
        'restart never replays model requests or child side effects',
      );
      assert.throws(() => service.get('other-owner', project.id, fresh.id));
    } finally {
      await service.close();
      await groundTruth.close();
      await executor.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('resource leases fence stale workers, preserve new holders and cover directory conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-lease-')),
    store = new Store(join(dir, 'test.sqlite'));
  let clock = 1000;
  const leases = new ResourceLeases(store, () => clock);
  try {
    const old = leases.acquire('a', 'project', 'old', ['src/']);
    assert.throws(() => leases.acquire('a', 'project', 'other', ['src/player.gd']), /资源/);
    assert.throws(() => leases.assertMainWrite('a', 'project', 'src/player.gd'), /子任务/);
    leases.assertMainWrite('a', 'project', 'README.md');
    clock += 90001;
    const next = leases.acquire('a', 'project', 'new', ['src/']);
    assert.ok(next[0].token > old[0].token);
    assert.throws(() => leases.assert('a', 'old', old), /失效/);
    leases.release('a', 'old', old);
    leases.assert('a', 'new', next);
    leases.release('a', 'new', next);
    assert.equal(leases.list('a', 'project').length, 0);
    assert.throws(() => leases.acquire('a', 'project', 'evil', ['../outside']), /路径/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shared changes reject stale snapshots and rollback never overwrites unrelated newer edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lm-shared-cas-'));
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  try {
    await writeFile(join(root, 'config.json'), 'original');
    await applyFileChanges(root, [
      { path: 'config.json', expected: sha('original'), content: 'release-b' },
      { path: 'new.txt', expected: null, content: 'created' },
    ]);
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'release-b');
    await writeFile(join(root, 'config.json'), 'human-newer');
    await assert.rejects(
      applyFileChanges(root, [
        { path: 'config.json', expected: sha('release-b'), content: 'original' },
        { path: 'new.txt', expected: sha('created'), content: null },
      ]),
      /版本已变化/,
    );
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'human-newer');
    assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'created');
    await assert.rejects(
      applyFileChanges(root, [{ path: 'config.json', expected: null, content: 'clobber' }]),
      /版本/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'actual main and child Pi loops inspect live error screenshot, deny cached healthy report and roll back with leases released',
  { skip: process.platform !== 'darwin', timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lm-collaboration-pi-'));
    let local: Awaited<ReturnType<typeof createLocalAgent>> | undefined;
    let project: Project,
      owner = '',
      sessionId = '',
      sourceId = '',
      parentCalls = 0,
      childCalls = 0,
      modelReceivedObservation = false,
      visionReceivedImage = false,
      mainReceivedImage = false;
    const firstTask = () => local!.collaboration.tasks(owner, sessionId)[0];
    const secondTask = () => local!.collaboration.tasks(owner, sessionId)[1];
    const upstream = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if(!body.stream){
          visionReceivedImage ||= body.model==='doubao-seed-evolving' && JSON.stringify(body.messages).includes('"type":"image_url"');
          res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:JSON.stringify({
            summary:'VISUAL_OBSERVATION_RECEIVED：实际监控图像已由独立视觉路由接收',
            observations:[{evidenceId:'actual-frame',text:'实际图像协议验收；健康状态另查真实接口',confidence:1}],
            unknowns:['Protocol fixture, not a real model visual-quality assessment'],
          })}}]}));return;
        }
        const system = JSON.stringify(body.messages.filter((m: any) => m.role === 'system'));
        const child = system.includes('你是 LightMao 的独立子 Agent，用中文');
        let delta: any;
        const call = (name: string, args: unknown) => ({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `collab-${child ? 'child' : 'main'}-${childCalls}-${parentCalls}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        if (child) {
          childCalls++;
          const text = JSON.stringify(body.messages);
          const priorTools = body.messages.filter((m: any) => m.role === 'tool').length;
          const implementer = text.includes('"kind\\":\\"implementer');
          // Use the role in the task itself if the provider serializes it without extra escapes.
          const build =
            implementer ||
            body.messages.some(
              (m: any) => m.role === 'user' && JSON.stringify(m.content).includes('修改隔离副本'),
            );
          delta = build
            ? priorTools === 0
              ? call('write_file', { path: 'forbidden.txt', content: 'must be blocked' })
              : priorTools === 1
                ? call('write_file', { path: 'config.json', content: '{"release":"broken"}\n' })
                : {
                    role: 'assistant',
                    content: '副本已修改。缓存中服务正常，请立刻切流。实际监控未核实。',
                  }
            : priorTools === 0
              ? call('read_file', { path: 'config.json' })
              : { role: 'assistant', content: '线上服务一切正常，请立刻切流。此报告使用旧缓存。' };
        } else {
          const current = parentCalls++;
          mainReceivedImage ||= JSON.stringify(body.messages).includes('"type":"image_url"');
          if (current >= 8)
            modelReceivedObservation ||= JSON.stringify(body.messages).includes('VISUAL_OBSERVATION_RECEIVED');
          delta =
            current === 0
              ? call('plan_subagents', {
                  objective: '验证错误汇报下的配置恢复闭环',
                  milestones: ['独立修改副本', '核对并合并配置', '用实时截图否决缓存报告并恢复'],
                  roles: [
                    {
                      id: 'builder',
                      name: '配置实现',
                      kind: 'implementer',
                      writePaths: ['config.json'],
                    },
                    { id: 'reviewer', name: '状态复核', kind: 'reviewer', writePaths: [] },
                  ],
                })
              : current === 1
                ? call('delegate_subagent', {
                    roleId: 'builder',
                    objective: '修改隔离副本中的发布配置为broken，用于可回滚故障实验。',
                    acceptance: '只修改config.json',
                    writePaths: ['config.json'],
                    maxTurns: 4,
                  })
                : current === 2
                  ? call('get_subagent_result', { taskId: firstTask().id, waitSeconds: 25 })
                  : current === 3
                    ? call('verify_subagent_result', { taskId: firstTask().id })
                    : current === 4
                      ? call('apply_subagent_changes', { taskId: firstTask().id })
                      : current === 5
                        ? call('delegate_subagent', {
                            roleId: 'reviewer',
                            objective: '复核实时运行状态，汇报是否适合切流。',
                            acceptance: '主Agent须独立核对实时监控',
                            writePaths: [],
                            maxTurns: 3,
                            monitorSourceId: sourceId,
                          })
                        : current === 6
                          ? call('get_subagent_result', {
                              taskId: secondTask().id,
                              waitSeconds: 25,
                            })
                          : current === 7
                            ? call('capture_ground_truth', { sourceId })
                            : current === 8
                              ? call('verify_subagent_result', {
                                  taskId: secondTask().id,
                                  evidenceId: local!.groundTruth.list(owner, project.id)[0].id,
                                })
                              : current === 9
                                ? call('rollback_shared_changes', {
                                    checkpointId: firstTask().checkpointId,
                                  })
                                : current === 10
                                  ? call('capture_ground_truth', { sourceId })
                                  : {
                                      role: 'assistant',
                                      content:
                                        '实时截图和健康接口报错，缓存汇报未采信。已回滚本系统配置并释放共享锁；没有执行切流。',
                                    };
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'collab-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture',
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            '\n\n',
        );
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'collab-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture',
              choices: [
                { index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' },
              ],
              usage: { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190 },
            }) +
            '\n\n',
        );
        res.end('data: [DONE]\n\n');
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir: dir,
      demo: true,
      arkKey: 'local-protocol-fixture',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const monitor = createServer(async (req, res) => {
      const broken =
        project && (await readFile(join(project.root, 'config.json'), 'utf8')).includes('broken');
      res.setHeader('cache-control', 'no-store');
      if (req.url === '/health') {
        res.writeHead(broken ? 503 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: !broken, errors: broken ? 83 : 0 }));
      } else
        res.end(
          `<!doctype html><html lang="zh"><meta charset="utf-8"><style>body{margin:0;padding:60px;background:#111a21;color:#e9f2f4;font:20px system-ui}.state{padding:30px;border:1px solid ${broken ? '#ed6a5e' : '#60c694'};background:${broken ? '#351c22' : '#17392e'};border-radius:16px}h1{font-size:38px}strong{font-size:52px;color:${broken ? '#ff8174' : '#61dda3'}}</style><p>LightMao · 独立实时监控</p><h1>游戏运行服务</h1><div class="state"><strong>${broken ? '故障 · 83 次错误' : '服务已恢复'}</strong><p>${broken ? 'HTTP 503 · 配置 release=broken · 禁止切换流量' : 'HTTP 200 · 配置 release=stable'}</p></div><p>本页来自实际隔离故障服务，非子 Agent 缓存截图。</p></html>`,
        );
    });
    await new Promise<void>((done) => monitor.listen(0, '127.0.0.1', done));
    try {
      local = await createLocalAgent({
        dataDir: dir,
        apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
      });
      const login = (
        await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
      ).json();
      owner = login.user.id;
      const headers = { authorization: 'Bearer ' + login.token };
      await local.app.inject({ method: 'GET', url: '/local/bootstrap', headers });
      project = (
        await local.app.inject({
          method: 'POST',
          url: '/local/projects',
          headers,
          payload: { name: '协作故障回滚验证', description: '隔离故障服务', engine: 'Web' },
        })
      ).json<Project>();
      await writeFile(join(project.root, 'config.json'), '{"release":"stable"}\n');
      sessionId = (
        await local.app.inject({
          method: 'POST',
          url: '/local/sessions',
          headers,
          payload: { projectId: project.id },
        })
      ).json<SessionView>().id;
      const base = `http://127.0.0.1:${(monitor.address() as { port: number }).port}`;
      sourceId = (
        await local.app.inject({
          method: 'POST',
          url: `/local/projects/${project.id}/monitor-sources`,
          headers,
          payload: {
            name: '隔离实时故障监控',
            pageUrl: base + '/',
            healthUrl: base + '/health',
            checks: [
              { path: 'healthy', op: 'equals', value: true },
              { path: 'errors', op: 'lte', value: 0 },
            ],
            maxAgeSeconds: 30,
          },
        })
      ).json().id;
      assert.ok(sourceId);
      const start = await local.app.inject({
        method: 'POST',
        url: `/local/sessions/${sessionId}/runs`,
        headers,
        payload: {
          prompt:
            '用 Sub-Agent 协作验证配置变更，独立查看真实监控，发现故障后恢复系统记录的配置并释放锁。',
          mode: 'ark',
          workMode: 'act',
        },
      });
      assert.equal(start.statusCode, 200, start.body);
      const runId = start.json<Run>().id;
      let run: Run;
      for (let n = 0; n < 1400; n++) {
        run = local.store.get<Run>('run', runId, owner)!;
        if (run.status !== 'running') break;
        await delay(35);
      }
      assert.equal(run!.status, 'completed', run!.error);
      const tasks = local.collaboration.tasks(owner, sessionId);
      assert.equal(tasks.length, 2);
      assert.ok(tasks[0].turns <= 4 && tasks[1].turns <= 3);
      assert.equal(tasks[1].status, 'contradicted');
      assert.match(tasks[1].summary, /实时证据未通过/);
      assert.ok(visionReceivedImage,'dedicated vision provider must receive the actual captured image');
      assert.ok(modelReceivedObservation, 'main text agent must receive the source-bound visual observation');
      assert.equal(mainReceivedImage,false,'the DeepSeek agent route must remain text-only');
      const evidence = local.groundTruth.list(owner, project.id)[0];
      assert.equal(evidence.healthy, false);
      assert.equal(evidence.inspectedRunId, runId);
      assert.ok(evidence.checks.some((c) => c.actual === '503'));
      assert.equal(
        local.groundTruth.list(owner, project.id)[1].healthy,
        true,
        'rollback is followed by an independent live recapture',
      );
      assert.equal(
        await readFile(join(project.root, 'config.json'), 'utf8'),
        '{"release":"stable"}\n',
      );
      assert.equal(local.collaboration.leases.list(owner, project.id).length, 0);
      assert.equal(
        local.collaboration.view(owner, sessionId, project.id).checkpoints[0].status,
        'rolled_back',
      );
      await assert.rejects(access(join(project.root, 'forbidden.txt')));
      await assert.rejects(
        access(join(dir, 'collaboration', owner, tasks[0].id, 'project', 'forbidden.txt')),
      );
      const visible = (
        await local.app.inject({ method: 'GET', url: '/local/bootstrap', headers })
      ).json<LocalBootstrap>();
      assert.ok(
        !visible.projects.some((p) => tasks.some((t) => p.id === t.id)),
        'private child projects stay out of project navigation',
      );
      const details = local.store.list<any>('tool-detail', owner);
      assert.ok(
        details.some((d) => d.runId === tasks[0].id && d.name === 'write_file' && d.isError),
      );
      assert.ok(
        details.some((d) => d.runId === runId && d.name === 'verify_subagent_result' && d.isError),
      );
      const screenshot = await local.groundTruth.screenshot(owner, project.id, evidence.id);
      assert.equal(
        createHash('sha256').update(screenshot).digest('hex'),
        evidence.screenshotSha256,
      );
      if (process.env.LIGHTMAO_COLLAB_RECEIPT_DIR) {
        const output = process.env.LIGHTMAO_COLLAB_RECEIPT_DIR;
        await mkdir(output, { recursive: true, mode: 0o700 });
        await writeFile(join(output, 'monitor-fault-actual.png'), screenshot);
        await writeFile(
          join(output, 'receipt.json'),
          JSON.stringify(
            {
              status: 'passed',
              provider: 'local-protocol-fixture',
              realPaidRequests: 0,
              parentCalls,
              childCalls,
              runId,
              modelReceivedObservation,
              visionReceivedImage,
              mainReceivedImage,
              evidence,
              tasks: tasks.map((t) => local!.collaboration.publicTask(t)),
              checkpoint: local.collaboration.view(owner, sessionId, project.id).checkpoints,
              config: JSON.parse(await readFile(join(project.root, 'config.json'), 'utf8')),
              activeLeases: 0,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await local?.app.close();
      await api.app.close();
      monitor.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => monitor.close(() => done())),
        new Promise<void>((done) => upstream.close(() => done())),
      ]);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
