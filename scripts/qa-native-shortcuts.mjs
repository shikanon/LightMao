import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
// Browser plugin not available. Exercise actual Electron input/preload in an isolated app.
// No user's Chrome, authenticated desktop data, or paid provider is used.
const root = await mkdtemp(join(tmpdir(), 'lm-native-shortcuts-'));
const gallery = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR ||
    '/Users/bytedance/.codex/visualizations/2026/11/02/lightmao-desktop-long-horizon/native-shortcuts',
);
await mkdir(gallery, { recursive: true });
const source =
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>LightMao native shortcut check</title><body style="font:16px system-ui;margin:48px"><h1>LightMao 桌面快捷键</h1><p>真实 Electron before-input-event → 隔离 preload → 固定动作。</p><button id="other">预览区域</button><textarea id="composer" aria-label="发送消息" placeholder="聚焦输入" style="display:block;width:600px;height:120px;margin:24px 0"></textarea><p id="count">新会话：0</p><script>window.newSessions=0;window.lightmaoDesktop.onDesktopShortcut(action=>{if(action===\'focus-composer\')document.querySelector(\'textarea\').focus();if(action===\'new-session\'){window.newSessions++;document.querySelector(\'#count\').textContent=\'新会话：\'+window.newSessions;}})</script></body></html>';
const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(source);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const main = join(root, 'main.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.setName('LightMao Shortcut QA');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});app.whenReady().then(async()=>{const win=new BrowserWindow({width:1000,height:700,show:false,webPreferences:{preload:${JSON.stringify(resolve('apps/desktop/preload.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:true}});require(${JSON.stringify(resolve('apps/desktop/shortcuts.cjs'))}).registerDesktopShortcuts(win,${JSON.stringify(origin)});await win.loadURL(${JSON.stringify(origin)});});app.on('window-all-closed',()=>app.quit());`,
);
const require = createRequire(import.meta.url),
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
const completed = [],
  errors = [];
let app,
  passed = false;
try {
  app = await _electron.launch({ executablePath: require('electron'), args: [main], env });
  const page = await app.firstWindow();
  await page.getByRole('textbox', { name: '发送消息', exact: true }).waitFor();
  page.on('pageerror', (e) => errors.push(e.message));
  const modifier = process.platform === 'darwin' ? 'meta' : 'control';
  async function chord(key, extra = []) {
    await app.evaluate(
      ({ BrowserWindow }, { key, mods }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
        contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
      },
      { key, mods: [modifier, ...extra] },
    );
  }
  await page.getByRole('button', { name: '预览区域' }).focus();
  await chord('L');
  await page.waitForFunction(() => document.activeElement?.id === 'composer');
  completed.push('Native Cmd/Ctrl+L reaches the isolated preload and focuses the composer');
  await chord('N', ['shift']);
  await page.waitForFunction(() => window.newSessions === 1);
  completed.push('Native Cmd/Ctrl+Shift+N creates exactly one session action');
  await chord('N');
  await chord('N', ['shift', 'isAutoRepeat']);
  assert.equal(await page.evaluate(() => window.newSessions), 1);
  completed.push('Unbound and auto-repeated chords do not create extra session actions');
  const flags = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
    };
  });
  assert.deepEqual(flags, { contextIsolation: true, nodeIntegration: false, sandbox: true });
  assert.equal(page.url(), origin + '/');
  assert.equal(app.windows().length, 1);
  assert.equal(errors.length, 0);
  completed.push('Renderer isolation, page identity and one-window lifecycle remain intact');
  await page.screenshot({ path: join(gallery, 'native-shortcuts.png') });
  passed = true;
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r()));
  await writeFile(
    join(gallery, 'receipt.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed,
        completed,
        errors,
        scope:
          'Real native Electron input/preload integration with an explicit UI fixture; full application flow is a separate acceptance check.',
      },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed, completed, errors, gallery }));
}
