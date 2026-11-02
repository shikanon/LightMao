import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';

const require = createRequire(import.meta.url);
const dataDir = await mkdtemp(join(tmpdir(), 'lightmao-native-'));
const imported = await mkdtemp(join(tmpdir(), 'lightmao-imported-game-'));
await mkdir(join(imported, 'scripts'));
await writeFile(join(imported, 'project.godot'), 'config_version=5\n');
await writeFile(join(imported, 'README.md'), '# Existing game\n');
await writeFile(join(imported, 'scripts', 'player.gd'), 'extends Node\n# Native import fixture\n');
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lightmao-native-artifacts-${Date.now()}`),
);
await mkdir(artifacts, { recursive: true });
let time = Date.now();
const api = await createApi({
  dataDir,
  demo: true,
  secureCookies: true,
  auth: { now: () => time, accessTtlMs: 1000 },
});
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const local = await createLocalAgent({ dataDir, apiUrl: apiBase, tickMs: 3600000 });
await local.app.listen({ host: '127.0.0.1', port: 0 });
const env = {
  ...process.env,
  LIGHTMAO_API_URL: apiBase,
  LIGHTMAO_DATA_DIR: dataDir,
  AGENT_PORT: String(local.app.server.address().port),
  LIGHTMAO_QA_PROFILE: join(dataDir, 'electron-profile'),
};
for (const key of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
let app, window, preferences;
const errors = [],
  completed = [];
const record = (name) => {
  completed.push(name);
  console.log(JSON.stringify({ passed: name }));
};
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
  window.on('pageerror', (e) => errors.push(e.message));
  await window.getByRole('navigation', { name: '主导航' }).waitFor();
  preferences = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0],
      p = win.webContents.getLastWebPreferences();
    return {
      electron: process.versions.electron,
      node: process.versions.node,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      webSecurity: p.webSecurity,
    };
  });
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.webSecurity, true);
  assert.equal(await window.evaluate(() => typeof process), 'undefined');
  assert.equal(await window.evaluate(() => typeof require), 'undefined');
  record('Actual Electron window renders with isolated, sandboxed renderer and no Node globals');
  const user = api.store.list('user').find((u) => u.email === 'demo@lightmao.local');
  const created = window.waitForResponse(
    (response) =>
      response.url().endsWith('/local/sessions') &&
      response.request().method() === 'POST' &&
      response.ok(),
  );
  await window.getByRole('button', { name: /^新建会话/ }).click();
  const session = await (await created).json();
  await window.waitForFunction(
    ({ userId, sessionId }) => sessionStorage.getItem(`lightmao.active.${userId}`) === sessionId,
    { userId: user.id, sessionId: session.id },
  );
  await window
    .getByRole('textbox', { name: '发送消息', exact: true })
    .fill('检查当前游戏项目，整理目录与引擎配置。');
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  let run;
  for (let i = 0; i < 160; i++) {
    run = local.store.list('run', user.id).at(-1);
    if (run?.status === 'completed') break;
    await delay(50);
  }
  assert.equal(run?.status, 'completed');
  const trace = window.locator('.execution-trace[aria-label="执行记录"] .execution-toggle');
  await trace.waitFor();
  assert.equal(await trace.getAttribute('aria-expanded'), 'false');
  await trace.click();
  await window.locator('.execution-body').waitFor();
  assert.equal(await trace.getAttribute('aria-expanded'), 'true');
  assert(
    local.store
      .list('event', user.id)
      .some((e) => e.runId === run.id && e.type === 'tool.finished'),
  );
  await window.screenshot({
    path: join(artifacts, 'electron-execution.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  await trace.click();
  time += 1100;
  await window.reload();
  await trace.waitFor();
  assert.equal(await trace.getAttribute('aria-expanded'), 'false');
  record(
    'Native composer executes a real Pi tool loop; execution details expand and reload collapsed',
  );
  await window.getByRole('button', { name: '设置', exact: true }).click();
  await window.getByRole('heading', { name: '账号与安全' }).waitFor();
  await window.getByRole('button', { name: '更新授权', exact: true }).waitFor();
  const cookieState = await app.evaluate(async ({ BrowserWindow }) => {
    const c = (
      await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({
        name: 'lightmao_refresh',
      })
    )[0];
    return { present: !!c, httpOnly: c?.httpOnly, sameSite: c?.sameSite, secure: c?.secure };
  });
  assert(cookieState.present && cookieState.httpOnly && cookieState.sameSite === 'strict');
  await window.screenshot({
    path: join(artifacts, 'electron-authorization.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  assert.deepEqual(errors, []);
  record(
    'Electron refresh cookie survives expired access, reload and device authorization display',
  );
  // Only the OS dialog result and Finder opening are substituted. The renderer,
  // preload, sender checks, native handlers, authenticated Agent and grants are real.
  await app.evaluate(({ dialog, shell }, folder) => {
    globalThis.qaSelections = [];
    globalThis.qaReveals = [];
    globalThis.qaOpenedDocuments = [];
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.qaSelections.push({ title: options.title, properties: options.properties });
      return { canceled: false, filePaths: [folder] };
    };
    shell.showItemInFolder = (path) => {
      globalThis.qaReveals.push(path);
    };
    shell.openPath = async (path) => {
      globalThis.qaOpenedDocuments.push(path);
      return '';
    };
  }, imported);
  await window.getByRole('button', { name: '管理项目', exact: true }).click();
  await window.getByRole('button', { name: '导入已有项目', exact: true }).click();
  await window.getByRole('dialog').getByLabel('项目名称', { exact: true }).fill('导入 · 雾林');
  await window
    .getByRole('dialog')
    .getByRole('button', { name: '选择本地文件夹', exact: true })
    .click();
  await window.locator('.project-selected-directory').waitFor();
  await window.getByRole('dialog').getByRole('button', { name: '连接项目', exact: true }).click();
  await window.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  await window.getByText('只读项目', { exact: true }).waitFor();
  const project = local.store.list('project', user.id).find((p) => p.name === '导入 · 雾林');
  assert.equal(project.access, 'read');
  assert.equal(project.root, await realpath(imported));
  const forged = await window.evaluate(async () =>
    window.lightmaoDesktop.selectProjectDirectory({
      token: sessionStorage.getItem('lightmao.token'),
      access: 'write',
      directory: '/tmp',
    }),
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.status, 400);
  assert.equal((await app.evaluate(() => globalThis.qaSelections)).length, 1);
  await window
    .getByRole('button', { name: '文件', exact: false })
    .filter({ hasText: /^文件/ })
    .click();
  await window
    .locator('.file-browser')
    .getByRole('button', { name: 'scripts', exact: true })
    .click();
  await window
    .locator('.file-browser')
    .getByRole('button', { name: 'player.gd', exact: true })
    .click();
  await window.locator('.project-code-preview').waitFor();
  assert((await window.locator('.project-code-preview').innerText()).includes('extends Node'));
  await window.getByRole('button', { name: '在文件管理器中显示文件', exact: true }).click();
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => globalThis.qaReveals.length === 1)) break;
    await delay(20);
  }
  assert.deepEqual(await app.evaluate(() => globalThis.qaReveals), [
    join(await realpath(imported), 'scripts', 'player.gd'),
  ]);
  await window.screenshot({
    path: join(artifacts, 'electron-imported-project.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  assert.equal(
    await readFile(join(imported, 'scripts', 'player.gd'), 'utf8'),
    'extends Node\n# Native import fixture\n',
  );
  record(
    'Native bridge imports an existing read-only game, browses nested code and reveals only the granted file; OS picker/Finder results simulated',
  );
  await window.getByRole('button', { name: /^文件/ }).click();
  await window.getByRole('button', { name: '返回上级目录', exact: true }).click();
  await window
    .locator('.file-browser')
    .getByRole('button', { name: 'README.md', exact: true })
    .click();
  await window.getByRole('button', { name: '使用默认应用打开文档', exact: true }).click();
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => globalThis.qaOpenedDocuments.length === 1)) break;
    await delay(20);
  }
  assert.deepEqual(await app.evaluate(() => globalThis.qaOpenedDocuments), [
    join(await realpath(imported), 'README.md'),
  ]);
  record(
    'Native document opening uses a scoped ordinary-text allowlist; OS application launch simulated',
  );
  await window.getByRole('button', { name: '管理当前项目', exact: true }).click();
  await window.getByRole('button', { name: '目录授权导入 · 雾林', exact: true }).click();
  await window
    .getByRole('dialog')
    .getByRole('radio', { name: /^允许读写/ })
    .check();
  await window
    .getByRole('dialog')
    .getByRole('button', { name: '选择本地文件夹', exact: true })
    .click();
  await window.locator('.project-selected-directory').waitFor();
  await window.getByRole('dialog').getByRole('button', { name: '确认连接', exact: true }).click();
  await window.getByText('项目目录已重新授权', { exact: true }).waitFor();
  assert.equal(local.store.get('project', project.id, user.id).access, 'write');
  const selections = await app.evaluate(() => globalThis.qaSelections);
  assert(selections[0].title.includes('只读') && selections[1].title.includes('读写'));
  assert(selections.every((s) => s.properties.includes('openDirectory')));
  record('Write permission requires a second explicit native selection and bound directory grant');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.qaSelections.push({ title: options.title, properties: options.properties });
      return { canceled: false, filePaths: [file] };
    };
  }, resolve('dist/plugins/game-assets.cjs'));
  await window.getByRole('button', { name: '插件', exact: true }).click();
  await window.getByRole('button', { name: 'MCP 连接', exact: true }).click();
  await window.getByLabel('MCP 所属项目').selectOption(project.id);
  await window.getByRole('button', { name: '添加 MCP 连接', exact: true }).click();
  await window.getByRole('dialog').getByLabel('连接名称', { exact: true }).fill('游戏素材 MCP');
  await window.getByRole('dialog').getByRole('button', { name: '选择文件', exact: true }).click();
  await window.getByRole('dialog').getByText('game-assets.cjs', { exact: true }).waitFor();
  await window.getByRole('dialog').getByRole('button', { name: '添加连接', exact: true }).click();
  await window.getByText('插件已添加，探测工具后可选择授权', { exact: true }).waitFor();
  assert.equal(local.store.list('mcp-plugin', user.id)[0].enabled, false);
  await window.getByRole('button', { name: '探测并授权', exact: true }).click();
  await window
    .getByRole('dialog')
    .getByRole('checkbox', { name: /game_asset_inventory/ })
    .check();
  await window.screenshot({
    path: join(artifacts, 'electron-mcp-review.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  await window
    .getByRole('dialog')
    .getByRole('button', { name: '允许并启用所选工具', exact: true })
    .click();
  await window.getByText('已启用所选 MCP 工具', { exact: true }).waitFor();
  assert.equal(local.store.list('mcp-plugin', user.id)[0].enabled, true);
  await window.screenshot({
    path: join(artifacts, 'electron-mcp-installed.jpg'),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
  await window.getByRole('button', { name: '停用', exact: true }).click();
  await window.getByText('插件已停用', { exact: true }).waitFor();
  assert.equal(local.store.list('mcp-plugin', user.id)[0].enabled, false);
  await window.getByRole('button', { name: '卸载', exact: true }).click();
  await window.getByRole('dialog').getByRole('button', { name: '确认卸载', exact: true }).click();
  await window.getByText('MCP 插件已卸载', { exact: true }).waitFor();
  assert.equal(local.store.list('mcp-plugin', user.id).length, 0);
  record(
    'Actual Electron preload imports a self-contained MCP plugin, probes sandboxed SDK tools, approves selected tools, disables and uninstalls it',
  );
  assert.deepEqual(errors, []);
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
  await window
    ?.screenshot({
      path: join(artifacts, 'electron-failure.jpg'),
      type: 'jpeg',
      animations: 'disabled',
    })
    .catch(() => {});
} finally {
  const receipt = {
    at: new Date().toISOString(),
    passed: !process.exitCode,
    completed,
    preferences,
    errors,
    artifacts,
  };
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await app?.close();
  await local.app.close();
  await api.app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(imported, { recursive: true, force: true });
  console.log(JSON.stringify(receipt));
}
