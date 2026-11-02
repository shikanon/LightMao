import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
process.loadEnvFile();
const dir = resolve(
    process.env.LIGHTMAO_GENERATED_CASE ||
      '.lightmao/verification/reference-game-e38dc0ec-1ccd-4363-96d1-96fa8c92833f',
  ),
  original = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8')),
  id = randomUUID(),
  out = join(dir, 'agent-repair-' + id);
await mkdir(out, { recursive: true });
const receipt = {
  id,
  trigger:
    'Small natural-language repair in the real Pi Agent, following an attested runtime failure; original full-game Goal remains separate.',
  caps: { chat: 10, decision: 6, vision: 1 },
  counts: { chat: 0, decision: 0, vision: 0 },
  passed: false,
};
const save = () =>
  writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
let api, local;
const base = new URL(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'),
  relay = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw),
        kind = req.url === '/api/v1/systemone' ? 'decision' : body.stream ? 'chat' : 'vision';
      if (receipt.counts[kind] >= receipt.caps[kind]) {
        res.writeHead(429).end('{"error":"targeted_repair_budget"}');
        return;
      }
      receipt.counts[kind]++;
      await save();
      console.log(JSON.stringify({ request: kind, counts: receipt.counts }));
      const url =
          kind === 'decision'
            ? new URL('/api/v1/systemone', base)
            : new URL(base.href.replace(/\/$/, '') + '/chat/completions'),
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + process.env.ARK_API_KEY,
            'content-type': 'application/json',
            ...(kind === 'decision' ? { 'ark-beta-systemone-api': 'true' } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180000),
        });
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') || 'application/json',
      });
      if (response.body)
        for await (const chunk of response.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
      res.end();
    })().catch((e) => {
      receipt.transportError = e.message;
      void save();
      if (!res.headersSent) res.writeHead(502);
      res.end('{"error":"repair_transport_incomplete"}');
    });
  });
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
try {
  api = await createApi({
    dataDir: join(dir, 'api'),
    demo: true,
    arkKey: 'local-backend-relay',
    arkBase: `http://127.0.0.1:${relay.address().port}/api/v3`,
    modelId: process.env.ARK_MODEL_ID,
    decisionModelId: process.env.ARK_SYSTEM_ONE_MODEL_ID,
    visionModelId: process.env.ARK_VISION_MODEL_ID,
  });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  local = await createLocalAgent({
    dataDir: join(dir, 'agent'),
    apiUrl: `http://127.0.0.1:${api.app.server.address().port}`,
    tickMs: 60000,
  });
  const login = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json(),
    owner = login.user.id;
  const response = await local.app.inject({
    method: 'POST',
    url: `/local/sessions/${original.sessionId}/runs`,
    headers: { authorization: 'Bearer ' + login.token },
    payload: {
      mode: 'ark',
      workMode: 'act',
      prompt:
        '修复这个游戏：真实浏览器运行报 game.js 第20行 Unexpected identifier 蓬莱琴师，初稿视觉评分11分。先按报错位置修复启动，再实际验证战前每轮选两个技能可以进入下一轮；如果选技计数或战中弹窗恢复有问题也做局部修复，保留战前五轮和战中随机构筑。只改必要片段，不重写全工程；修复后实际试玩核验，不能仅口头报告成功。',
    },
  });
  if (response.statusCode !== 200) throw Error(response.body);
  const run = response.json();
  receipt.runId = run.id;
  await save();
  const end = Date.now() + 8 * 60000;
  for (;;) {
    await delay(1000);
    const current = local.store.get('run', run.id, owner);
    if (current.status !== 'running') {
      receipt.run = current;
      break;
    }
    if (Date.now() > end) {
      await local.app.inject({
        method: 'POST',
        url: '/local/runs/' + run.id + '/stop',
        headers: { authorization: 'Bearer ' + login.token },
        payload: {},
      });
      throw Error('Targeted repair reached its wall-time budget');
    }
  }
  receipt.tools = local.store.list('tool-detail', owner).filter((d) => d.runId === run.id);
  receipt.playtests = local.playtests
    .list(owner, original.project.id)
    .filter((p) => p.runId === run.id);
  receipt.traceIntegrity = local.traces.page(owner, run.id).integrity;
  receipt.passed =
    receipt.run.status === 'completed' && receipt.playtests.some((p) => p.status === 'passed');
  await save();
  console.log(
    JSON.stringify({
      receipt: join(out, 'receipt.json'),
      passed: receipt.passed,
      counts: receipt.counts,
      status: receipt.run.status,
      tests: receipt.playtests.map((j) => ({ status: j.status, error: j.error })),
    }),
  );
} catch (e) {
  receipt.error = e.message;
  await save();
  console.log(JSON.stringify({ receipt: join(out, 'receipt.json'), error: e.message }));
} finally {
  await local?.app.close();
  await api?.app.close();
  relay.closeAllConnections();
  await new Promise((r) => relay.close(r));
  await save();
}
