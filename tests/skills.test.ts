import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  unlink,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { parseSkill, resourcePath, digest } from '../packages/skills/format.ts';
import type {
  Skill,
  SkillSummary,
  SkillImportPreview,
  SkillResource,
  LocalBootstrap,
  CloudBootstrap,
  Run,
  RunEvent,
} from '../packages/shared/types.ts';

const instructions = `---\nname: game-review\ndescription: >\n  Review the game project with the bundled checklist.\nmetadata:\n  version: "1.0"\nallowed-tools: Bash(*) run_script\n---\n# INSTRUCTIONS_ONLY_CANARY\n先读取 references/checklist.md，再给出结果。脚本只是示例。\n`;
const reference =
  'RESOURCE_NEVER_AUTOLOAD_CANARY\n' +
  'A project checklist with useful evidence.\n'.repeat(600) +
  'RESOURCE_TAIL_CANARY';
const files = () => [
  { path: 'SKILL.md', base64: Buffer.from(instructions).toString('base64') },
  { path: 'references/checklist.md', base64: Buffer.from(reference).toString('base64') },
  {
    path: 'scripts/example.mjs',
    base64: Buffer.from('throw new Error("THIS_SCRIPT_MUST_NOT_EXECUTE");').toString('base64'),
  },
  {
    path: 'assets/sample.gif',
    base64: 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  },
];
test('skill format rejects unsafe paths, invalid metadata, aliases and collisions while accepting standard folded YAML', () => {
  assert.equal(parseSkill(instructions, 'game-review').name, 'game-review');
  for (const path of [
    '../password.md',
    '/tmp/private',
    'a\\b',
    'docs/password.md',
    '.env',
    'credentials.json',
    'scripts/./run.py',
    'a\0b',
  ])
    assert.throws(() => resourcePath(path));
  for (const text of [
    '# Missing YAML',
    instructions.replace('game-review', 'Game-Review'),
    instructions.replace('game-review', 'game--review'),
    instructions.replace('description: >', 'description: !!js/function >'),
    instructions.replace('metadata:\n  version: "1.0"', 'metadata:\n  value: &x [x]\n  copy: *x'),
  ])
    assert.throws(() => parseSkill(text));
  assert.throws(() => parseSkill(instructions, 'another-folder'));
});

test(
  'local skill snapshots, cloud Markdown and actual Pi progressive reading preserve scope, versions and restart',
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'lightmao-skills-'));
    const dataDir = join(dir, 'data');
    const folder = join(dir, 'source', 'game-review');
    await mkdir(folder, { recursive: true });
    const requests: Record<string, unknown>[] = [];
    let selectedId = '';
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const phase = (body.messages as { role: string }[]).filter(
        (message) => message.role === 'tool',
      ).length;
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'skill-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'skill-endpoint', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        chunk(
          phase < 2
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `skill-${phase}`,
                    type: 'function',
                    function: {
                      name: 'read_skill_resource',
                      arguments: JSON.stringify({
                        skillId: selectedId,
                        path: phase === 0 ? 'SKILL.md' : 'references/checklist.md',
                      }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'SKILL_REPLY：已按指引读取清单，尚未运行引擎。' },
          null,
        ),
      );
      res.write(chunk({}, phase < 2 ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    const api = await createApi({
      dataDir,
      demo: true,
      arkKey: 'skills-fixture-key',
      arkBase: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      modelId: 'skill-endpoint',
    });
    await api.app.listen({ host: '127.0.0.1', port: 0 });
    const apiBase = `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`;
    let local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 60000 });
    const owner = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json<{ token: string; user: { id: string } }>();
    const other = (
      await api.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          name: 'Other',
          email: 'skill-other@example.test',
          password: 'Skill-fixture-owner-2026',
        },
      })
    ).json<{ token: string; user: { id: string } }>();
    async function call(
      path: string,
      body?: unknown,
      method?: 'POST' | 'PATCH' | 'DELETE',
      token = owner.token,
      extra = {},
    ) {
      return (path.startsWith('/api/') ? api.app : local.app).inject({
        method: method || (body ? 'POST' : 'GET'),
        url: path,
        headers: { authorization: `Bearer ${token}`, ...extra },
        ...(body ? { payload: body } : {}),
      });
    }
    async function good<T>(
      path: string,
      body?: unknown,
      method?: 'POST' | 'PATCH' | 'DELETE',
      extra = {},
    ) {
      const r = await call(path, body, method, owner.token, extra);
      assert(r.statusCode < 300, r.body);
      return r.json<T>();
    }
    let skill: SkillSummary,
      projectId = '',
      runId = '';
    try {
      const bootstrap = await good<LocalBootstrap>('/local/bootstrap');
      projectId = bootstrap.projects[0].id;
      const key = (await readFile(join(dataDir, 'desktop-control.key'))).toString('hex');
      const native = { 'x-lightmao-desktop-key': key };
      await t.test(
        'native snapshot is read-only and immutable; grants and copies stay owner scoped and retries preserve disabled state',
        async () => {
          for (const file of files()) {
            await mkdir(join(folder, file.path, '..'), { recursive: true });
            await writeFile(join(folder, file.path), Buffer.from(file.base64, 'base64'));
          }
          await writeFile(join(folder, '.DS_Store'), 'ignored Finder fixture');
          assert.equal(
            (await call('/local/skill-directory-grants', { path: folder })).statusCode,
            403,
          );
          const preview = await good<SkillImportPreview>(
            '/local/skill-directory-grants',
            { path: folder },
            'POST',
            native,
          );
          assert.equal(preview.files.length, 4);
          assert.deepEqual(preview.ignored, ['.DS_Store']);
          assert(preview.instructions.includes('INSTRUCTIONS_ONLY_CANARY'));
          assert.equal(
            (await call('/local/skills/import', { grantId: preview.grantId }, 'POST', other.token))
              .statusCode,
            404,
          );
          await writeFile(join(folder, 'references/checklist.md'), 'SOURCE_CHANGED_AFTER_PREVIEW');
          const result = await good<{ skill: SkillSummary; duplicate: boolean }>(
            '/local/skills/import',
            { grantId: preview.grantId, category: '测试', enabled: false },
          );
          skill = result.skill;
          selectedId = skill.id;
          assert.equal(result.duplicate, false);
          assert.equal(skill.origin, 'local');
          assert(!('content' in skill));
          assert(!('manifest' in skill));
          const retry = await good<{ skill: SkillSummary; duplicate: boolean }>(
            '/local/skills/import',
            { grantId: preview.grantId, enabled: true },
          );
          assert.equal(retry.skill.id, skill.id);
          assert.equal(retry.skill.enabled, false);
          const page = await good<{ text: string }>(
            `/local/skills/${encodeURIComponent(skill.id)}/resource?path=references%2Fchecklist.md`,
          );
          assert(page.text.includes('RESOURCE_NEVER_AUTOLOAD_CANARY'));
          assert.equal(
            await readFile(join(folder, 'references/checklist.md'), 'utf8'),
            'SOURCE_CHANGED_AFTER_PREVIEW',
          );
          assert.equal(
            (
              await call(
                `/local/skills/${encodeURIComponent(skill.id)}`,
                undefined,
                undefined,
                other.token,
              )
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await call(
                `/local/skills/${encodeURIComponent(skill.id)}/resource?path=SKILL.md`,
                undefined,
                undefined,
                other.token,
              )
            ).statusCode,
            404,
          );
          const summary = (await good<LocalBootstrap>('/local/bootstrap')).skills!.find(
            (s) => s.id === skill.id,
          )!;
          assert(!('content' in summary));
          assert(!('manifest' in summary));
        },
      );
      await t.test(
        'import validation refuses traversal, credentials, duplicate paths, malformed encoding and oversized bytes',
        async () => {
          for (const input of [
            { ...files()[0], path: '../SKILL.md' },
            { path: '.env', base64: 'c2VjcmV0' },
            { path: 'password.md', base64: 'c2VjcmV0' },
            { ...files()[0], path: 'skill.md' },
            { path: 'x.md', base64: 'not base64' },
            { path: 'large.txt', base64: Buffer.alloc(2 * 1048576 + 1).toString('base64') },
          ])
            assert.equal(
              (
                await call('/local/skills/prepare', {
                  rootName: 'game-review',
                  files: [files()[0], input],
                })
              ).statusCode,
              400,
            );
          assert.equal(
            (await call('/local/skills/prepare', { rootName: 'different-name', files: files() }))
              .statusCode,
            400,
          );
          const tooBig = [
            files()[0],
            ...Array.from({ length: 4 }, (_, i) => ({
              path: `large-${i}.bin`,
              base64: Buffer.alloc(2 * 1048576).toString('base64'),
            })),
          ];
          assert.equal(
            (await call('/local/skills/prepare', { rootName: 'game-review', files: tooBig }))
              .statusCode,
            400,
          );
          assert.equal(local.store.list('local-skill', owner.user.id).length, 1);
        },
      );
      await t.test(
        'native snapshot rejects symlinks and hard links without reading external content',
        async () => {
          const outside = join(dir, 'outside.txt');
          await writeFile(outside, 'PRIVATE_OUTSIDE_SKILL');
          const escape = join(folder, 'references', 'escape.md');
          await symlink(outside, escape);
          assert.equal(
            (
              await call(
                '/local/skill-directory-grants',
                { path: folder },
                'POST',
                owner.token,
                native,
              )
            ).statusCode,
            400,
          );
          await unlink(escape);
          await link(outside, escape);
          assert.equal(
            (
              await call(
                '/local/skill-directory-grants',
                { path: folder },
                'POST',
                owner.token,
                native,
              )
            ).statusCode,
            400,
          );
          await unlink(escape);
          await writeFile(join(folder, '.env'), 'NEVER_IMPORT');
          assert.equal(
            (
              await call(
                '/local/skill-directory-grants',
                { path: folder },
                'POST',
                owner.token,
                native,
              )
            ).statusCode,
            400,
          );
          await unlink(join(folder, '.env'));
          assert.equal(await readFile(outside, 'utf8'), 'PRIVATE_OUTSIDE_SKILL');
        },
      );
      await t.test(
        'native import can read an owned game workspace but not another account private workspace',
        async () => {
          const project = (await good<LocalBootstrap>('/local/bootstrap')).projects.find(
            (p) => p.id === projectId,
          )!;
          const nested = join(project.root, 'skills', 'game-review');
          await mkdir(nested, { recursive: true });
          await writeFile(join(nested, 'SKILL.md'), instructions);
          const grant = await good<SkillImportPreview>(
            '/local/skill-directory-grants',
            { path: nested },
            'POST',
            native,
          );
          assert.equal(grant.files.length, 1);
          assert.equal(
            (
              await call(
                '/local/skill-directory-grants',
                { path: nested },
                'POST',
                other.token,
                native,
              )
            ).statusCode,
            400,
          );
          await good(`/local/skill-stages/${grant.grantId}`, undefined, 'DELETE');
        },
      );
      await t.test(
        'cloud bootstrap exposes metadata; Markdown detail, revision conflicts and toggles preserve category and ownership',
        async () => {
          const cloud = await good<CloudBootstrap>('/api/bootstrap');
          assert(cloud.skills.every((s) => !('content' in s)));
          const created = await good<Skill>('/api/skills', {
            name: 'Cloud review',
            description: 'Cloud metadata',
            category: '程序',
            enabled: true,
            content: 'CLOUD_BODY_ONLY_ON_DEMAND',
          });
          assert.equal(
            (await call(`/api/skills/${created.id}`, undefined, undefined, other.token)).statusCode,
            404,
          );
          const changed = await good<Skill>(
            `/api/skills/${created.id}`,
            { enabled: false, revision: 1 },
            'PATCH',
          );
          assert.equal(changed.category, '程序');
          assert.equal(changed.content, created.content);
          assert.equal(
            (await call(`/api/skills/${created.id}`, { name: 'Stale', revision: 1 }, 'PATCH'))
              .statusCode,
            409,
          );
          const detail = await good<Skill>(`/api/skills/${created.id}`);
          assert.equal(detail.content, created.content);
          assert.equal(detail.enabled, false);
          const renamed = await good<Skill>(
            `/api/skills/${created.id}`,
            { name: 'Cloud renamed', revision: detail.revision },
            'PATCH',
          );
          assert.equal(renamed.enabled, false);
          assert.equal(renamed.category, '程序');
          await good<Skill>(
            `/api/skills/${created.id}`,
            { enabled: true, revision: renamed.revision },
            'PATCH',
          );
          const session = await good<{ id: string }>('/local/sessions', { projectId });
          const run = await good<Run>(`/local/sessions/${session.id}/runs`, {
            prompt: 'Use cloud guide',
            mode: 'demo',
            skillIds: [created.id],
          });
          for (let i = 0; i < 200; i++) {
            if (local.store.get<Run>('run', run.id, owner.user.id)!.status !== 'running') break;
            await delay(15);
          }
          assert.equal(local.store.get<Run>('run', run.id, owner.user.id)!.toolErrorCount, 0);
          const read = local.store
            .list<{ runId: string; name: string; state: string; summary: string }>(
              'tool-detail',
              owner.user.id,
            )
            .find((detail) => detail.runId === run.id && detail.name === 'read_skill_resource')!;
          assert.equal(read.state, 'completed');
          assert(read.summary.includes('CLOUD_BODY_ONLY_ON_DEMAND'));
        },
      );
      await t.test(
        'real Pi provider loads only selected metadata, then instruction and one requested reference page; scripts never become tools',
        async () => {
          skill = await good<Skill>(
            `/local/skills/${encodeURIComponent(skill.id)}`,
            { enabled: true, revision: skill.revision },
            'PATCH',
          );
          const session = await good<{ id: string }>('/local/sessions', { projectId });
          const run = await good<Run>(`/local/sessions/${session.id}/runs`, {
            prompt: 'Use the selected skill and report the checklist',
            mode: 'ark',
            skillIds: [skill.id],
          });
          runId = run.id;
          for (let i = 0; i < 200; i++) {
            if (local.store.get<Run>('run', run.id, owner.user.id)!.status !== 'running') break;
            await delay(15);
          }
          const final = local.store.get<Run>('run', run.id, owner.user.id)!;
          assert.equal(final.status, 'completed', final.error);
          assert(final.text.includes('SKILL_REPLY'));
          assert.equal(requests.length, 3);
          const bodies = requests.map((request) => JSON.stringify(request.messages));
          assert(!bodies[0].includes('INSTRUCTIONS_ONLY_CANARY'));
          assert(!bodies[0].includes('RESOURCE_NEVER_AUTOLOAD_CANARY'));
          assert(bodies[1].includes('INSTRUCTIONS_ONLY_CANARY'));
          assert(!bodies[1].includes('RESOURCE_NEVER_AUTOLOAD_CANARY'));
          assert(bodies[2].includes('RESOURCE_NEVER_AUTOLOAD_CANARY'));
          assert(!bodies[2].includes('RESOURCE_TAIL_CANARY'));
          const tools = (requests[0].tools as { function: { name: string } }[]).map(
            (t) => t.function.name,
          );
          assert(tools.includes('read_skill_resource'));
          assert(!tools.includes('Bash'));
          assert(!tools.includes('run_script'));
          assert.equal(final.toolCount, 2);
          assert.equal(final.toolErrorCount, 0);
          const events = local.store
            .list<RunEvent>('event', owner.user.id)
            .filter((e) => e.runId === run.id);
          assert.equal(events.filter((e) => e.type === 'tool.finished').length, 2);
          const device = local.store.get<{ encrypted: string }>(
            'backend-credential',
            owner.user.id,
            owner.user.id,
          );
          assert(device);
        },
      );
      await t.test(
        'model tool calls cannot access a skill outside the current selection, and unknown selection fails before the gateway',
        async () => {
          const actualId = selectedId;
          selectedId = 'local:00000000-0000-4000-8000-000000000001';
          const start = requests.length;
          const session = await good<{ id: string }>('/local/sessions', { projectId });
          const run = await good<Run>(`/local/sessions/${session.id}/runs`, {
            prompt: 'Try an unselected skill',
            mode: 'ark',
            skillIds: [actualId],
          });
          for (let i = 0; i < 200; i++) {
            if (local.store.get<Run>('run', run.id, owner.user.id)!.status !== 'running') break;
            await delay(15);
          }
          assert.equal(local.store.get<Run>('run', run.id, owner.user.id)!.toolErrorCount, 2);
          assert(
            requests
              .slice(start)
              .every((body) => !JSON.stringify(body.messages).includes('INSTRUCTIONS_ONLY_CANARY')),
          );
          selectedId = actualId;
          const after = requests.length;
          const fresh = await good<{ id: string }>('/local/sessions', { projectId });
          const rejected = await good<Run>(`/local/sessions/${fresh.id}/runs`, {
            prompt: 'Unknown selection',
            mode: 'ark',
            skillIds: ['missing-skill'],
          });
          for (let i = 0; i < 200; i++) {
            if (local.store.get<Run>('run', rejected.id, owner.user.id)!.status !== 'running')
              break;
            await delay(15);
          }
          assert.equal(local.store.get<Run>('run', rejected.id, owner.user.id)!.status, 'failed');
          assert.equal(requests.length, after);
        },
      );
      await t.test(
        'a failed commit leaves its preview unconsumed; parallel confirmation creates one package',
        async () => {
          const input = files();
          input[0] = {
            ...input[0],
            base64: Buffer.from(instructions + '\nATOMIC_IMPORT_CANARY').toString('base64'),
          };
          const staged = await good<SkillImportPreview>('/local/skills/prepare', {
            rootName: 'game-review',
            files: input,
          });
          local.store.db.exec(
            "CREATE TRIGGER reject_local_skill BEFORE INSERT ON records WHEN NEW.kind='local-skill' BEGIN SELECT RAISE(ABORT,'injected skill commit failure'); END",
          );
          assert.equal(
            (await call('/local/skills/import', { grantId: staged.grantId })).statusCode,
            500,
          );
          assert.equal(local.store.list('local-skill', owner.user.id).length, 1);
          assert.equal(
            local.store.get<{ importedId?: string }>(
              'skill-stage',
              digest(staged.grantId),
              owner.user.id,
            )!.importedId,
            undefined,
          );
          local.store.db.exec('DROP TRIGGER reject_local_skill');
          const receipts = await Promise.all(
            [1, 2].map(() =>
              good<{ skill: SkillSummary; duplicate: boolean }>('/local/skills/import', {
                grantId: staged.grantId,
              }),
            ),
          );
          assert.equal(new Set(receipts.map((receipt) => receipt.skill.id)).size, 1);
          assert.equal(receipts.filter((receipt) => !receipt.duplicate).length, 1);
          await call(
            `/local/skills/${encodeURIComponent(receipts[0].skill.id)}`,
            undefined,
            'DELETE',
          );
        },
      );
      await t.test(
        'text pagination and image bytes match the snapshot; tampering and stale versions fail explicitly',
        async () => {
          const rows = await good<SkillResource[]>(
            `/local/skills/${encodeURIComponent(skill.id)}/files`,
          );
          const ref = rows.find((file) => file.path === 'references/checklist.md')!;
          const first = await good<{ text: string; nextOffset: number }>(
            `/local/skills/${encodeURIComponent(skill.id)}/resource?path=references%2Fchecklist.md`,
          );
          const second = await good<{ text: string }>(
            `/local/skills/${encodeURIComponent(skill.id)}/resource?path=references%2Fchecklist.md&offset=${first.nextOffset}`,
          );
          assert.equal(first.text + second.text, reference.slice(0, 8000));
          const image = await call(
            `/local/skills/${encodeURIComponent(skill.id)}/resource?path=assets%2Fsample.gif&download=true`,
          );
          assert.deepEqual(image.rawPayload, Buffer.from(files()[3].base64, 'base64'));
          const blob = join(dataDir, 'skill-bundles', digest(owner.user.id), ref.sha256);
          assert.equal((await stat(blob)).mode & 0o777, 0o600);
          await writeFile(blob, 'CORRUPTED');
          assert.equal(
            (
              await call(
                `/local/skills/${encodeURIComponent(skill.id)}/resource?path=references%2Fchecklist.md`,
              )
            ).statusCode,
            409,
          );
          await writeFile(blob, reference);
          const old = skill.sha256;
          skill = await good<Skill>(
            `/local/skills/${encodeURIComponent(skill.id)}`,
            {
              content: instructions.replace('INSTRUCTIONS_ONLY_CANARY', 'UPDATED_INSTRUCTIONS'),
              revision: skill.revision,
            },
            'PATCH',
          );
          assert.notEqual(skill.sha256, old);
          assert.equal(
            (
              await call(
                `/local/skills/${encodeURIComponent(skill.id)}/resource?path=SKILL.md&version=${old}`,
              )
            ).statusCode,
            409,
          );
        },
      );
      await t.test(
        'unconfirmed previews can be discarded without affecting installed skills; expired grants and conflicting replacements are refused',
        async () => {
          const staged = await good<SkillImportPreview>('/local/skills/prepare', {
            rootName: 'game-review',
            files: files(),
          });
          await good(`/local/skill-stages/${staged.grantId}`, undefined, 'DELETE');
          assert.equal(
            (await call('/local/skills/import', { grantId: staged.grantId })).statusCode,
            404,
          );
          assert((await good<Skill[]>(`/local/skills`)).some((s) => s.id === skill.id));
          const expired = await good<SkillImportPreview>('/local/skills/prepare', {
            rootName: 'game-review',
            files: files(),
          });
          const saved = local.store.get<{ id: string; expiresAt: string }>(
            'skill-stage',
            digest(expired.grantId),
            owner.user.id,
          )!;
          local.store.put('skill-stage', owner.user.id, {
            ...saved,
            expiresAt: new Date(0).toISOString(),
          });
          assert.equal(
            (await call('/local/skills/import', { grantId: expired.grantId })).statusCode,
            409,
          );
          const replacement = await good<SkillImportPreview>('/local/skills/prepare', {
            rootName: 'game-review',
            replaceId: skill.id,
            files: files(),
          });
          skill = await good<Skill>(
            `/local/skills/${encodeURIComponent(skill.id)}`,
            { name: 'Renamed local skill', revision: skill.revision },
            'PATCH',
          );
          assert.equal(
            (await call('/local/skills/import', { grantId: replacement.grantId })).statusCode,
            409,
          );
        },
      );
      await t.test(
        'restart retains package selection and resources; deletion removes future access while historical events remain',
        async () => {
          await local.app.close();
          local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 60000 });
          assert(
            (await good<LocalBootstrap>('/local/bootstrap')).skills!.some((s) => s.id === skill.id),
          );
          assert(
            (
              await good<{ text: string }>(
                `/local/skills/${encodeURIComponent(skill.id)}/resource?path=SKILL.md`,
              )
            ).text.includes('UPDATED_INSTRUCTIONS'),
          );
          await call(`/local/skills/${encodeURIComponent(skill.id)}`, undefined, 'DELETE');
          assert.equal(
            (await call(`/local/skills/${encodeURIComponent(skill.id)}`)).statusCode,
            404,
          );
          assert(
            local.store
              .list<RunEvent>('event', owner.user.id)
              .some((event) => event.runId === runId && event.type === 'tool.finished'),
          );
        },
      );
    } finally {
      await local.app.close();
      api.app.server.closeAllConnections();
      await api.app.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
