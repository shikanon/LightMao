import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat, symlink, writeFile, readFile } from 'node:fs/promises';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { BackendSettings, backendURL, namespace, probeBackend } = createRequire(import.meta.url)(
  '../apps/desktop/backend.cjs',
);
test('backend switch preparation requires desktop control and an idle actual Agent, then blocks new mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-backend-idle-'));
  const api = await createApi({ dataDir: dir, demo: true });
  await api.app.listen({ host: '127.0.0.1', port: 0 });
  const local = await createLocalAgent({
    dataDir: dir,
    apiUrl: `http://127.0.0.1:${(api.app.server.address() as { port: number }).port}`,
  });
  try {
    const auth = (
      await api.app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} })
    ).json();
    const headers = { authorization: `Bearer ${auth.token}` };
    const bootstrap = (await local.app.inject({ url: '/local/bootstrap', headers })).json();
    const session = (
      await local.app.inject({
        url: '/local/sessions',
        method: 'POST',
        headers,
        payload: { projectId: bootstrap.projects[0].id },
      })
    ).json();
    const run = (
      await local.app.inject({
        url: `/local/sessions/${session.id}/runs`,
        method: 'POST',
        headers,
        payload: { mode: 'demo', prompt: '检查项目目录' },
      })
    ).json();
    assert.equal(run.status, 'running');
    const control = {
      'x-lightmao-desktop-key': (await readFile(join(dir, 'desktop-control.key'))).toString('hex'),
    };
    assert.equal(
      (
        await local.app.inject({
          url: '/local/native/prepare-shutdown',
          method: 'POST',
          payload: { requireIdle: true },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await local.app.inject({
          url: '/local/native/prepare-shutdown',
          method: 'POST',
          headers: control,
          payload: { requireIdle: true },
        })
      ).statusCode,
      409,
    );
    await local.app.inject({
      url: `/local/runs/${run.id}/stop`,
      method: 'POST',
      headers,
      payload: {},
    });
    assert.equal(
      (
        await local.app.inject({
          url: '/local/native/prepare-shutdown',
          method: 'POST',
          headers: control,
          payload: { requireIdle: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await local.app.inject({
          url: '/local/projects',
          method: 'POST',
          headers,
          payload: { name: 'must not be created' },
        })
      ).statusCode,
      503,
    );
    assert.equal((await local.app.inject({ url: '/local/health' })).statusCode, 200);
  } finally {
    await local.app.close();
    await api.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('desktop backend settings normalize origins, bind revisions and reject unsafe URLs, links and corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-backend-settings-'));
  try {
    assert.equal(backendURL(' https://example.test:443/ '), 'https://example.test');
    assert.equal(backendURL('http://127.0.0.1:4318'), 'http://127.0.0.1:4318');
    for (const url of [
      'file:///tmp',
      'http://remote.test',
      'https://user:secret@example.test',
      'https://example.test/api',
      'https://example.test/?token=secret',
      'https://example.test/#private',
      'javascript:alert(1)',
      '',
    ])
      assert.throws(() => backendURL(url));
    const settings = new BackendSettings(dir);
    assert.deepEqual(settings.read(), { url: '', revision: 0 });
    assert.equal(settings.save('https://backend-a.test', 0).revision, 1);
    assert.equal((await stat(settings.path)).mode & 0o777, 0o600);
    assert.throws(() => settings.save('https://backend-b.test', 0), { status: 409 });
    assert.equal(settings.save('https://backend-a.test/', 1).changed, false);
    assert.notEqual(namespace('https://backend-a.test'), namespace('https://backend-b.test'));
    assert.equal(new BackendSettings(dir).read().url, 'https://backend-a.test');
    const target = join(dir, 'outside');
    await writeFile(target, 'secret');
    await rm(settings.path);
    await symlink(target, settings.path);
    assert.throws(() => settings.read());
    await rm(settings.path);
    await writeFile(settings.path, '{broken');
    assert.throws(() => settings.save('https://backend-b.test', 0));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('desktop backend probe accepts compatible health only, bounds responses and never follows redirects or sends credentials', async () => {
  let mode = 'ok',
    redirected = false;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization || req.headers.cookie || '');
    if (req.url === '/redirected') {
      redirected = true;
      res.end('{}');
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/redirected' }).end();
      return;
    }
    if (mode === 'large') {
      res.end('x'.repeat(40000));
      return;
    }
    if (mode === 'wrong') {
      res.end(JSON.stringify({ service: 'other', ok: true }));
      return;
    }
    if (mode === 'protocol') {
      res.end(JSON.stringify({ service: 'LightMao API', ok: true, protocolVersion: 2 }));
      return;
    }
    res.end(
      JSON.stringify({ service: 'LightMao API', ok: true, protocolVersion: 1, demoAllowed: false }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await probeBackend(url)).service, 'LightMao API');
    for (const value of ['redirect', 'large', 'wrong', 'protocol']) {
      mode = value;
      await assert.rejects(() => probeBackend(url));
    }
    assert.equal(redirected, false);
    assert(seen.every((v) => v === ''));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
