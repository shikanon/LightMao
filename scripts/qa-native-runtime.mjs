import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
const require = createRequire(import.meta.url);
const dataDir = await mkdtemp(join(tmpdir(), 'lm-native-runtime-'));
const artifacts =
  process.env.LIGHTMAO_QA_ARTIFACT_DIR ||
  join(tmpdir(), `lm-native-runtime-artifacts-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
const api = await createApi({ dataDir, demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const env = {
  ...process.env,
  LIGHTMAO_API_URL: `http://127.0.0.1:${api.app.server.address().port}`,
  LIGHTMAO_DATA_DIR: dataDir,
  AGENT_PORT: String(port),
  LIGHTMAO_QA_PROFILE: join(dataDir, 'electron-profile'),
};
for (const key of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
let app, window, health;
const errors = [];
try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: ['scripts/qa-desktop-entry.cjs'],
    cwd: resolve('.'),
    env,
    timeout: 30000,
  });
  window = await app.firstWindow();
  window.setDefaultTimeout(12000);
  window.on('pageerror', (error) => errors.push(error.message));
  await window.getByRole('navigation', { name: '主导航' }).waitFor();
  health = await fetch(`http://127.0.0.1:${port}/local/health`).then((r) => r.json());
  assert.equal(health.sandbox.available, true, health.sandbox.error);
  const login = await fetch(`${env.LIGHTMAO_API_URL}/api/auth/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json());
  const request = async (path, body, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${login.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    assert(response.ok, `${path}: ${value.error}`);
    return value;
  };
  const project = (await request('/local/bootstrap')).projects[0];
  const files = await request(`/local/projects/${project.id}/files`);
  assert(files.some((f) => f.name === 'README.md'));
  const key = (await readFile(join(dataDir, 'desktop-control.key'))).toString('hex');
  const grant = await request(
    '/local/mcp-file-grants',
    { projectId: project.id, path: resolve('dist/plugins/game-assets.cjs') },
    { 'X-Lightmao-Desktop-Key': key },
  );
  const plugin = await request('/local/mcp-plugins', {
    projectId: project.id,
    name: 'Electron-owned runtime',
    transport: 'stdio',
    grantId: grant.grantId,
    domains: [],
    access: 'read',
  });
  const probe = await request(`/local/mcp-plugins/${plugin.id}/probe`, {});
  assert.equal(probe.tools[0].name, 'game_asset_inventory');
  await window.getByRole('button', { name: '设置', exact: true }).click();
  await window.getByText('隔离自检通过', { exact: true }).waitFor();
  await window.getByText('隔离自检通过', { exact: true }).scrollIntoViewIfNeeded();
  await window.screenshot({
    path: join(artifacts, 'electron-owned-isolation.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed:
        'Electron utilityProcess owns the Agent; Electron in Node mode executes isolated file helpers and the bundled MCP SDK server',
      health,
      errors,
    }),
  );
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
  await window?.screenshot({ path: join(artifacts, 'failure.jpg'), type: 'jpeg' }).catch(() => {});
} finally {
  await app?.close();
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/local/health`);
      await delay(50);
    } catch {
      break;
    }
  }
  await api.app.close();
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      { at: new Date().toISOString(), passed: !process.exitCode, health, errors, artifacts },
      null,
      2,
    ),
  );
  await rm(dataDir, { recursive: true, force: true });
}
