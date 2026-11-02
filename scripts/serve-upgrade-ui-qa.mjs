import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import desktop from '../apps/desktop/proxy.cjs';
// A server fixture only. All rendered UI interactions are performed through cua_repl.
const root = process.env.LIGHTMAO_QA_DIR || (await mkdtemp(join(tmpdir(), 'lm-upgrade-ui-')));
const report = { root, startedAt: new Date().toISOString(), protocolCalls: 0, errors: [] };
const save = () => writeFile(join(root, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  report.protocolCalls++;
  await save();
  const names = new Set((body.tools || []).map((tool) => tool.function.name));
  const last = body.messages.at(-1),
    lastTool = body.messages.findLast((m) => m.role === 'tool');
  const lastToolName =
    lastTool?.name ||
    body.messages.flatMap((m) => m.tool_calls || []).find((t) => t.id === lastTool?.tool_call_id)
      ?.function.name;
  let tool;
  const child = JSON.stringify(body.messages.filter((m) => m.role === 'system')).includes(
    '你是 LightMao 的独立子 Agent，用中文',
  );
  const collaborationUi = !child && JSON.stringify(body.messages).includes('界面协作验证');
  let finalText;
  if (child) {
    if (!body.messages.some((m) => m.role === 'tool'))
      tool = [
        'write_file',
        {
          path: 'ui-subagent-notes.md',
          content:
            '# Sub-Agent UI verification\nCreated in an isolated child project, then checked and merged by the main Agent.\n',
        },
      ];
    else finalText = '独立副本中的说明文件已创建；主工程尚未合并，请主 Agent 核验当前文件版本。';
  } else if (collaborationUi) {
    if (last.role === 'user') report.collaborationPhase = 0;
    const phase = report.collaborationPhase++;
    const activeSession = local.store.list('session', login.user.id).find((s) => s.activeRunId);
    const task =
      activeSession &&
      local.collaboration
        .tasks(login.user.id, activeSession.id)
        .findLast((t) => t.objective === '创建界面验证说明文件');
    tool =
      phase === 0
        ? [
            'plan_subagents',
            {
              objective: '界面协作验证',
              milestones: ['独立副本写入说明', '主Agent校验并合并'],
              roles: [
                {
                  id: 'builder',
                  name: '文档子 Agent',
                  kind: 'implementer',
                  writePaths: ['ui-subagent-notes.md'],
                },
              ],
            },
          ]
        : phase === 1
          ? [
              'delegate_subagent',
              {
                roleId: 'builder',
                objective: '创建界面验证说明文件',
                acceptance: '只创建ui-subagent-notes.md；主Agent核验并合并',
                writePaths: ['ui-subagent-notes.md'],
                maxTurns: 3,
              },
            ]
          : phase === 2
            ? ['get_subagent_result', { taskId: task.id, waitSeconds: 25 }]
            : phase === 3
              ? ['verify_subagent_result', { taskId: task.id }]
              : phase === 4
                ? ['apply_subagent_changes', { taskId: task.id }]
                : undefined;
    if (!tool)
      finalText =
        '界面协作验证完成：独立 Pi 子 Agent 已在副本创建说明文件，主 Agent 核对当前版本后合并。此项只验证协作功能，不作为游戏玩法或模型能力验收。';
  } else if (last.role === 'user') {
    if (names.has('complete_goal'))
      tool = names.has('write_file')
        ? [
            'write_file',
            {
              path: 'qa-game-notes.md',
              content:
                '# Verified UI goal\nThis is a protocol QA artifact, not a generated playable game.\n',
            },
          ]
        : [
            'request_capability',
            { pluginId: 'writer', reason: '完成当前目标需要在此测试工程保存产物。' },
          ];
    else if (!names.has('write_file'))
      tool = [
        'update_plan',
        {
          objective: '制作星轨冲刺',
          steps: [
            {
              id: 'build',
              text: '实现移动、收集、躲避和重开',
              status: 'pending',
              acceptance: '实际输入改变位置，得分与重开状态可复验',
            },
            {
              id: 'test',
              text: '实际试玩并修复',
              status: 'pending',
              acceptance: '当前版本的输入和状态断言通过',
            },
          ],
        },
      ];
    else
      tool = [
        'write_file',
        { path: 'qa-game-notes.md', content: '# Approved plan\nThis is a protocol UI fixture.\n' },
      ];
  } else if (names.has('complete_goal') && lastToolName === 'write_file')
    tool = ['complete_goal', { evidence: [{ kind: 'file', ref: 'qa-game-notes.md' }] }];
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: randomUUID(),
            type: 'function',
            function: { name: tool[0], arguments: JSON.stringify(tool[1]) },
          },
        ],
      }
    : {
        role: 'assistant',
        content:
          finalText ||
          (names.has('complete_goal') ? '本轮证据已记录。' : '计划已保存，可确认后执行。'),
      };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [change, finish] of [
    [delta, null],
    [{}, tool ? 'tool_calls' : 'stop'],
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: change, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
            : {}),
        }) +
        '\n\n',
    );
  res.end('data: [DONE]\n\n');
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const api = await createApi({
  dataDir: root,
  demo: true,
  arkKey: 'protocol-ui-only',
  arkBase: `http://127.0.0.1:${upstream.address().port}`,
  adminEmail: 'ui-qa@example.test',
  adminPassword: 'UI-QA-fixture-2026',
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const local = await createLocalAgent({
  dataDir: root,
  apiUrl: `http://127.0.0.1:${api.app.server.address().port}`,
  godotPath: resolve('.lightmao/tools/godot/4.7.2/Godot.app'),
});
await local.app.listen({ host: '127.0.0.1', port: 0 });
const login = (await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })).json(),
  headers = { authorization: 'Bearer ' + login.token };
const bootstrap = (
  await local.app.inject({ method: 'GET', url: '/local/bootstrap', headers })
).json();
const project = bootstrap.projects[0];
if (process.env.LIGHTMAO_QA_MEDIA_RECEIPT) {
  const live = JSON.parse(await readFile(process.env.LIGHTMAO_QA_MEDIA_RECEIPT, 'utf8'));
  if (!live.passed || live.stage !== 'media')
    throw Error('Use a completed live media receipt only.');
  report.mediaSources = [];
  for (const source of live.results) {
    const original = source.job,
      bytes = await readFile(source.file);
    const asset = await api.assets.upload(
      login.user.id,
      original.asset.name,
      original.asset.mime,
      bytes,
      undefined,
      original.asset.id,
    );
    api.store.put('generation', login.user.id, {
      id: 'ui-' + original.id,
      ownerId: login.user.id,
      projectId: project.id,
      sessionId: bootstrap.sessions[0].id,
      kind: original.kind,
      model: original.model,
      name: original.name,
      status: 'completed',
      requestId: 'ui-import-' + original.requestId,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
      upstreamTaskId: original.upstreamTaskId,
      asset,
    });
    report.mediaSources.push({ jobId: original.id, sha256: asset.sha256 });
  }
}
await writeFile(
  join(project.root, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>可玩预览验证</title><style>body{margin:0;background:#111c30;color:#e8fff8;font:20px system-ui;text-align:center;padding:60px}button{padding:16px 30px;background:#99e9cf;border:0;border-radius:15px;font-size:22px}strong{color:#ffd37b}</style><h1>星光预览验证</h1><p>这是界面测试场景，点击开始后按空格收集星光。</p><button id="start">开始游戏</button><p id="score"></p><script>let active=false,score=0;const label=document.querySelector('#score');document.querySelector('#start').onclick=()=>{active=true;label.textContent='星光 0'};onkeydown=e=>{if(active&&e.key===' '){score++;label.textContent='星光 '+score}}</script>`,
);
const proxy = desktop.createDesktopServer({
  webRoot: resolve('dist/web'),
  apiBase: `http://127.0.0.1:${api.app.server.address().port}`,
  agentBase: `http://127.0.0.1:${local.app.server.address().port}`,
});
await new Promise((done) =>
  proxy.listen(Number(process.env.LIGHTMAO_QA_PORT) || 0, '127.0.0.1', done),
);
report.url = `http://127.0.0.1:${proxy.address().port}`;
report.projectId = project.id;
await save();
console.log(
  JSON.stringify({
    url: report.url,
    root,
    login:
      'Use 演示体验. Admin fixture ui-qa@example.test / UI-QA-fixture-2026 has no real account data.',
  }),
);
const stop = async () => {
  await local.app.close();
  await api.app.close();
  proxy.closeAllConnections();
  await new Promise((done) => proxy.close(done));
  await new Promise((done) => upstream.close(done));
  await save();
  process.exit();
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
