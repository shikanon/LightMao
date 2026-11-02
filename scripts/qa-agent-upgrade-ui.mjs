import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

// Browser plugin not available in the current tool inventory. Isolated Playwright
// validates only our own fixture service; it does not open a user's Chrome profile.
const root = await mkdtemp(join(tmpdir(), 'lm-upgrade-ui-final-'));
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || '.lightmao/verification/upgrade-ui-final',
);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  LIGHTMAO_QA_DIR: root,
  LIGHTMAO_QA_PORT: '0',
  LIGHTMAO_QA_MEDIA_RECEIPT: resolve(
    '.lightmao/verification/upgrade-media-7ddc5e14-407e-4cbd-81a1-d49f717ef2b0/receipt.json',
  ),
};
for (const key of Object.keys(env)) if (/^(ARK_|OSS_|DOUBAO_)/.test(key)) delete env[key];
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/serve-upgrade-ui-qa.mjs'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '',
  stderr = '',
  browser,
  passed = false;
child.stdout.on('data', (b) => (output += b));
child.stderr.on('data', (b) => (stderr += b));
const report = {
  browserPath: 'Browser plugin not available; isolated Playwright Chromium',
  root,
  checks: [],
  errors: [],
  consoleErrors: [],
  httpErrors: [],
  expectedAuthRefresh401: 0,
  viewports: [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ],
};
const record = (name) => {
  report.checks.push(name);
  console.log(JSON.stringify({ passed: name }));
};
try {
  let base;
  for (let i = 0; i < 150; i++) {
    const line = output.split('\n').find((l) => l.startsWith('{"url":'));
    if (line) {
      base = JSON.parse(line).url;
      break;
    }
    if (child.exitCode !== null) throw Error('UI fixture failed: ' + stderr.slice(-1000));
    await delay(100);
  }
  assert.ok(base, 'fixture service started');
  report.url = base;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: report.viewports[0] }),
    page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text());
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const path = new URL(response.url()).pathname;
    if (response.status() === 401 && path === '/api/auth/refresh') report.expectedAuthRefresh401++;
    else report.httpErrors.push({ path, status: response.status() });
  });
  await page.goto(base);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.equal(await page.title(), 'LightMao · 游戏创作工作台');
  assert.ok((await page.locator('body').innerText()).length > 100);
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  record('page identity, meaningful content and no framework overlay');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const permissions = page.getByLabel('Agent 权限模式', { exact: true });
  assert.equal(await permissions.inputValue(), 'full');
  await permissions.selectOption('custom');
  await page.getByText('Agent 权限已保存', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await permissions.inputValue(), 'custom');
  await permissions.selectOption('full');
  await page.getByText('Agent 权限已保存', { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, 'permissions-full.png'), animations: 'disabled' });
  record('fresh launch defaults to full; custom persists after reload; full can be restored');
  await page.getByRole('button', { name: /新建会话/ }).click();
  await page.getByLabel('工作模式', { exact: true }).selectOption('act');
  const prompt = '进行 Sub-Agent 界面协作验证，创建一个说明文件，由主 Agent 核对并合并。';
  await page.getByRole('textbox', { name: '发送消息', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText(/界面协作验证完成：独立 Pi 子 Agent/).waitFor({ timeout: 30000 });
  const panel = page.locator('.subagents-panel');
  assert.equal(
    await panel.getAttribute('open'),
    null,
    'collaboration execution is folded by default',
  );
  await panel.locator(':scope > summary').click();
  await panel.getByText('已合并 · 待主工程验收', { exact: true }).waitFor();
  assert.ok((await panel.innerText()).includes('2 / 3 轮'));
  await panel.getByText('查看汇报与变更 · 1 文件', { exact: true }).click();
  await panel.getByRole('button', { name: '回读独立执行记录', exact: true }).click();
  await panel.locator('.subagent-log pre').waitFor();
  assert.ok((await panel.locator('.subagent-log pre').innerText()).includes('messages'));
  await page.screenshot({ path: join(artifacts, 'subagents-merged.png'), animations: 'disabled' });
  record(
    'natural request executes actual independent child Pi; main verifies and merges; folded UI expands and reads paged logs',
  );
  await panel.getByRole('button', { name: '收起原始记录', exact: true }).click();
  await panel.getByText('项目监控源 · 0', { exact: true }).click();
  await panel.getByLabel('监控页面', { exact: true }).fill('http://127.0.0.1:9999/status');
  await panel.getByLabel('同源健康接口', { exact: true }).fill('http://127.0.0.1:9999/health');
  await panel
    .getByLabel('受保护的配置路径（可选，逗号分隔）', { exact: true })
    .fill('config/release.json');
  await panel.getByRole('button', { name: '保存监控源', exact: true }).click();
  await panel.getByText('项目监控源 · 1', { exact: true }).waitFor();
  record('project monitor configuration saves the actual source and protected path');
  await page.setViewportSize(report.viewports[1]);
  assert.ok(await page.getByRole('textbox', { name: '发送消息', exact: true }).isVisible());
  await page.screenshot({ path: join(artifacts, 'subagents-mobile.png'), animations: 'disabled' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  assert.equal(overflow, false, 'mobile has no page-level horizontal overflow');
  record('390x844 responsive composer and collaboration panel remain usable');
  await page.setViewportSize(report.viewports[0]);
  await page.getByRole('button', { name: '运行与验证', exact: true }).click();
  await page.getByRole('tab', { name: '作品预览', exact: true }).waitFor();
  record('game workspace exposes preview, playtest records and Godot diagnostics');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.httpErrors, []);
  const auth401 = report.consoleErrors.filter(
    (message) =>
      message ===
      'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
  );
  assert.ok(auth401.length <= report.expectedAuthRefresh401);
  assert.deepEqual(
    report.consoleErrors.filter((message) => !auth401.includes(message)),
    [],
  );
  passed = true;
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  if (browser) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0])
      await pages[0].screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  }
  throw e;
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  for (let i = 0; i < 60 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  report.passed = passed;
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
}
