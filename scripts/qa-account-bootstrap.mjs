import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApi } from '../apps/api/server.ts';
import { chromium } from 'playwright';

// Browser plugin not available. This isolated fault test performs no cloud I/O.
const dataDir = await mkdtemp(join(tmpdir(), 'lightmao-account-ui-'));
const artifacts = resolve(process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(dataDir, 'artifacts'));
await mkdir(artifacts, { recursive: true });
let reads = 0,
  writes = 0;
const unavailable = {
  driver: 'oss',
  async put() {
    writes++;
    throw Error('Storage fault fixture');
  },
  async get() {
    reads++;
    throw Error('Storage fault fixture');
  },
  async stream() {
    reads++;
    throw Error('Storage fault fixture');
  },
  async remove() {
    throw Error('Storage fault fixture');
  },
};
const server = await createApi({
  dataDir,
  serveWeb: true,
  objectStorage: unavailable,
  adminEmail: 'admin@example.test',
  adminPassword: 'Admin-bootstrap-fixture-2026',
});
const requests = [],
  errors = [],
  consoleMessages = [],
  unexpected = [];
server.app.addHook('onRequest', async (req) => {
  requests.push(req.url.split('?')[0]);
});
await server.app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${server.app.server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type()))
    consoleMessages.push({ text: m.text(), url: m.location().url });
});
page.on('response', (r) => {
  if (
    r.status() >= 400 &&
    !(r.status() === 401 && new URL(r.url()).pathname === '/api/auth/refresh')
  )
    unexpected.push({ path: new URL(r.url()).pathname, status: r.status() });
});
let passed = false;
try {
  await page.goto(base + '/admin');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@example.test');
  await page.getByLabel('密码', { exact: true }).fill('Admin-bootstrap-fixture-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  await page.getByLabel('上下文使用预算（tokens）', { exact: true }).fill('32768');
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await page.getByText('模型配置已保存', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '管理工作空间', exact: true }).waitFor();
  await page.getByRole('tab', { name: '模型配置', exact: true }).click();
  assert.equal(
    await page.getByLabel('上下文使用预算（tokens）', { exact: true }).inputValue(),
    '32768',
  );
  await page.screenshot({
    path: join(artifacts, 'admin-storage-unavailable.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  assert(requests.includes('/api/account/bootstrap'));
  assert(!requests.includes('/api/bootstrap') && !requests.some((v) => v.startsWith('/local/')));
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(server.store.list('asset').length, 0);
  assert.equal(server.store.list('asset-transfer').length, 0);
  assert.match(await page.title(), /LightMao/);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert((await page.locator('body').innerText()).length > 100);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(
    consoleMessages.filter(
      (v) =>
        !(v.url && new URL(v.url).pathname === '/api/auth/refresh' && /status of 401/.test(v.text)),
    ),
    [],
  );
  passed = true;
} catch (error) {
  await page.screenshot({ path: join(artifacts, 'failure.jpg') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await server.app.close();
  const receipt = {
    at: new Date().toISOString(),
    passed,
    base,
    requests,
    storageReads: reads,
    storageWrites: writes,
    errors,
    consoleMessages,
    unexpected,
    scope:
      'Actual rendered standalone admin with an object store that rejects every operation. No paid model, cloud object, local Agent or user Chrome.',
  };
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ passed, artifacts, storageReads: reads, storageWrites: writes }));
}
