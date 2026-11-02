if (process.argv.includes('--lightmao-playtest-worker')) {
  require('./playtest-worker.cjs');
} else {
  const {
    app,
    BrowserWindow,
    utilityProcess,
    ipcMain,
    dialog,
    shell,
    Tray,
    Menu,
    nativeImage,
    powerMonitor,
  } = require('electron');
  const { resolve, join } = require('node:path');
  const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
  const { createDesktopServer } = require('./proxy.cjs');
  const { registerDesktopActions } = require('./actions.cjs');
  const { BackendSettings, backendURL, namespace, probeBackend } = require('./backend.cjs');
  // Desktop child processes must not inherit server-only credentials.
  for (const key of Object.keys(process.env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete process.env[key];
  const root = resolve(__dirname, '../..');
  app.setName('LightMao');
  if (app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'LightMao Desktop'));
  if (process.env.LIGHTMAO_USER_DATA_DIR)
    app.setPath('userData', resolve(process.env.LIGHTMAO_USER_DATA_DIR));
  const backendSettings = new BackendSettings(app.getPath('userData'));
  let storedBackend = { url: '', revision: 0 },
    configurationError = '';
  try {
    storedBackend = backendSettings.read();
  } catch (error) {
    configurationError = error.message;
  }
  const managedBackend = !!process.env.LIGHTMAO_API_URL;
  const apiBase = managedBackend
    ? backendURL(process.env.LIGHTMAO_API_URL)
    : storedBackend.url ||
      (app.isPackaged ? undefined : `http://127.0.0.1:${process.env.API_PORT || 4318}`);
  const scopedBackend = app.isPackaged || !!storedBackend.url;
  let agentBase = app.isPackaged ? undefined : `http://127.0.0.1:${process.env.AGENT_PORT || 4319}`;
  let changingBackend = false;
  let win,
    tray,
    server,
    origin,
    shutdown,
    shuttingDown = false,
    quitAllowed = false,
    resumeAt;
  const children = new Map();
  const settingsPath = join(app.getPath('userData'), 'desktop-settings.json');
  let keepRunning = true;
  try {
    keepRunning = JSON.parse(readFileSync(settingsPath, 'utf8')).keepRunning !== false;
  } catch {}
  const dataDir =
    process.env.LIGHTMAO_DATA_DIR ||
    (scopedBackend
      ? join(app.getPath('userData'), 'workspaces', apiBase ? namespace(apiBase) : 'pending')
      : resolve(root, '.lightmao'));
  async function ready(url, name) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return false;
      const value = await response.json();
      return name === 'api'
        ? value.service === 'LightMao API'
        : value.framework?.startsWith('Pi Agent');
    } catch {
      return false;
    }
  }
  async function control(path, body = {}) {
    const key = readFileSync(join(dataDir, 'desktop-control.key'));
    if (key.length !== 32) throw new Error('Desktop control unavailable');
    const response = await fetch(`${agentBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lightmao-Desktop-Key': key.toString('hex'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw Object.assign(new Error(detail.error || 'Local service control failed'), {
        status: response.status,
      });
    }
  }
  async function startPackagedAgent(env) {
    const child = utilityProcess.fork(resolve(root, 'dist/agent/index.js'), [], {
      cwd: root,
      env: { ...env, AGENT_PORT: '0' },
      stdio: 'pipe',
      serviceName: 'LightMao agent',
    });
    children.set('agent', child);
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('exit', () => {
      if (children.get('agent') === child) children.delete('agent');
    });
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('本地 Agent 启动超时'));
      }, 15000);
      const exit = () => {
        clearTimeout(timer);
        reject(new Error('本地 Agent 启动失败'));
      };
      child.once('exit', exit);
      child.on('message', (value) => {
        if (
          value?.type !== 'lightmao:ready' ||
          value.service !== 'agent' ||
          !Number.isInteger(value.port) ||
          value.port < 1 ||
          value.port > 65535
        )
          return;
        clearTimeout(timer);
        child.removeListener('exit', exit);
        done(`http://127.0.0.1:${value.port}`);
      });
    });
  }
  async function ensureService(name, url, env) {
    if (shuttingDown) throw new Error('桌面正在退出');
    if (await ready(url, name)) return;
    if (shuttingDown) throw new Error('桌面正在退出');
    const child = utilityProcess.fork(resolve(root, `dist/${name}/index.js`), [], {
      cwd: root,
      env,
      stdio: 'pipe',
      serviceName: `LightMao ${name}`,
    });
    children.set(name, child);
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('exit', () => {
      if (children.get(name) === child) children.delete(name);
    });
    for (let i = 0; i < 80; i++) {
      if (shuttingDown) throw new Error('桌面正在退出');
      if (await ready(url, name)) return;
      if (!children.has(name)) throw new Error(`${name} exited during startup`);
      await new Promise((done) => setTimeout(done, 150));
    }
    throw new Error(`${name} failed to start`);
  }
  function openWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  function updateMenu() {
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 LightMao', click: openWindow },
        {
          label: '关闭窗口后继续运行',
          type: 'checkbox',
          checked: keepRunning,
          click: (item) => setKeepRunning(item.checked),
        },
        { type: 'separator' },
        { label: '退出 LightMao（停止本地任务）', click: () => app.quit() },
      ]),
    );
    tray.setToolTip(`LightMao · ${keepRunning ? '关闭窗口后继续运行' : '关闭窗口后退出'}`);
  }
  function setKeepRunning(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid background setting');
    if (value && !tray) throw new Error('系统托盘不可用，无法开启后台运行');
    mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
    const temporary = settingsPath + '.tmp';
    writeFileSync(temporary, JSON.stringify({ keepRunning: value }) + '\n', { mode: 0o600 });
    renameSync(temporary, settingsPath);
    keepRunning = value;
    updateMenu();
  }
  function trayIcon() {
    const size = 36,
      pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const body = x >= 5 && x <= 30 && y >= 13 && y <= 30;
        const ears =
          y >= 5 && y < 15 && ((x >= 5 && x <= 6 + (y - 5)) || (x <= 30 && x >= 29 - (y - 5)));
        const eye = y >= 20 && y <= 23 && ((x >= 11 && x <= 13) || (x >= 22 && x <= 24));
        if ((body || ears) && !eye) {
          const i = (y * size + x) * 4;
          pixels[i] = process.platform === 'darwin' ? 0 : 115;
          pixels[i + 1] = process.platform === 'darwin' ? 0 : 86;
          pixels[i + 2] = process.platform === 'darwin' ? 0 : 175;
          pixels[i + 3] = 255;
        }
      }
    const icon = nativeImage.createFromBitmap(pixels, {
      width: size,
      height: size,
      scaleFactor: 2,
    });
    icon.setTemplateImage(process.platform === 'darwin');
    return icon;
  }
  function trusted(event) {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin
    )
      throw new Error('Untrusted desktop caller');
  }
  async function status() {
    const agentOnline = !!agentBase && !!(await ready(`${agentBase}/local/health`, 'agent'));
    return {
      keepRunning,
      trayAvailable: !!tray && !tray.isDestroyed(),
      agentOnline,
      ownsAgent: children.has('agent'),
      resumeAt,
    };
  }
  function backendStatus() {
    let revision = storedBackend.revision;
    try {
      revision = backendSettings.read().revision;
    } catch {}
    return {
      url: apiBase || '',
      configured: !!apiBase,
      revision,
      readOnly:
        managedBackend || !!process.env.LIGHTMAO_DATA_DIR || (!!apiBase && !children.has('agent')),
      managed: managedBackend,
      packaged: app.isPackaged,
      error: configurationError,
    };
  }
  async function changeBackend(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((key) => !['url', 'revision'].includes(key))
    )
      throw Object.assign(new Error('连接设置参数无效'), { status: 400 });
    if (backendStatus().readOnly)
      throw Object.assign(new Error('当前连接由启动配置或独立服务管理，请调整启动配置后重新打开'), {
        status: 409,
      });
    if (changingBackend) throw Object.assign(new Error('应用正在切换连接'), { status: 409 });
    changingBackend = true;
    let prepared = false;
    try {
      const probe = await probeBackend(input.url);
      if (probe.url === apiBase) {
        changingBackend = false;
        return { changed: false, restart: false };
      }
      if (children.has('agent')) {
        await control('/local/native/prepare-shutdown', { requireIdle: true });
        prepared = true;
      }
      const saved = backendSettings.save(probe.url, input.revision);
      if (saved.changed)
        setTimeout(() => {
          app.relaunch();
          app.quit();
        }, 100);
      else changingBackend = false;
      return { ...saved, restart: saved.changed };
    } catch (error) {
      changingBackend = false;
      if (prepared)
        setTimeout(() => {
          app.relaunch();
          app.quit();
        }, 100);
      throw error;
    }
  }
  function resume() {
    resumeAt = new Date().toISOString();
    void control('/local/native/wake').catch(() => {});
  }
  async function drain() {
    // Stop renderer polling and upstream proxy streams before waiting for Fastify
    // to drain. Leaving those clients alive can keep app.close() pending.
    server?.closeAllConnections();
    server?.close();
    win?.destroy();
    tray?.destroy();
    if (children.has('agent')) await control('/local/native/prepare-shutdown').catch(() => {});
    for (const name of ['agent', 'api']) {
      const child = children.get(name);
      if (!child) continue;
      await new Promise((done) => {
        const timer = setTimeout(() => {
          console.error(`${name} shutdown exceeded its deadline; terminating the owned process`);
          child.kill();
        }, 5000);
        const force = setTimeout(() => {
          if (child.pid)
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {}
        }, 10000);
        child.once('exit', () => {
          clearTimeout(timer);
          clearTimeout(force);
          done();
        });
        try {
          child.postMessage({ type: 'lightmao:shutdown' });
        } catch {
          child.kill();
        }
      });
    }
  }
  module.exports.runtime = { status, setKeepRunning, openWindow, resume };
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    app.on('second-instance', openWindow);
    app.on('activate', openWindow);
    app.on('window-all-closed', () => {
      if (!keepRunning) app.quit();
    });
    app.on('before-quit', (event) => {
      if (quitAllowed) return;
      event.preventDefault();
      shuttingDown = true;
      if (!shutdown)
        shutdown = drain().finally(() => {
          quitAllowed = true;
          app.quit();
        });
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());
    app
      .whenReady()
      .then(async () => {
        const env = { ...process.env, LIGHTMAO_DATA_DIR: dataDir };
        if (apiBase && !managedBackend && !storedBackend.url && !app.isPackaged)
          await ensureService('api', `${apiBase}/api/health`, env);
        const localEnv = {
          ...env,
          LIGHTMAO_API_URL: apiBase,
          LIGHTMAO_SANDBOX_NODE: app.getPath('exe'),
          LIGHTMAO_SANDBOX_NODE_IS_ELECTRON: 'true',
        };
        for (const key of Object.keys(localEnv))
          if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete localEnv[key];
        if (apiBase) {
          if (app.isPackaged) agentBase = await startPackagedAgent(localEnv);
          else await ensureService('agent', `${agentBase}/local/health`, localEnv);
        }
        if (shuttingDown) return;
        server = createDesktopServer({ webRoot: resolve(root, 'dist/web'), apiBase, agentBase });
        await new Promise((done) => server.listen(0, '127.0.0.1', done));
        origin = `http://127.0.0.1:${server.address().port}`;
        win = new BrowserWindow({
          width: 1500,
          height: 980,
          minWidth: 900,
          minHeight: 640,
          title: 'LightMao',
          titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
          ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 10 } } : {}),
          backgroundColor: '#f7f8fb',
          webPreferences: {
            preload: resolve(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false,
            ...(scopedBackend
              ? { partition: 'persist:lightmao-' + (apiBase ? namespace(apiBase) : 'setup') }
              : {}),
          },
        });
        if (agentBase && apiBase)
          registerDesktopActions({ ipcMain, dialog, shell, win, origin, agentBase, dataDir });
        const backendResult = async (event, work) => {
          trusted(event);
          try {
            return { ok: true, value: await work() };
          } catch (error) {
            return {
              ok: false,
              status: error.status || 500,
              error: error.message || '后端连接操作失败',
            };
          }
        };
        ipcMain.handle('lightmao:backend-status', (event) =>
          backendResult(event, () => backendStatus()),
        );
        ipcMain.handle('lightmao:probe-backend', (event, url) =>
          backendResult(event, () => probeBackend(url)),
        );
        ipcMain.handle('lightmao:set-backend', (event, value) =>
          backendResult(event, () => changeBackend(value)),
        );
        ipcMain.handle('lightmao:runtime-status', async (event) => {
          trusted(event);
          return status();
        });
        ipcMain.handle('lightmao:set-background', async (event, value) => {
          trusted(event);
          setKeepRunning(value);
          return status();
        });
        win.on('close', (event) => {
          if (quitAllowed) return;
          event.preventDefault();
          if (keepRunning && tray) win.hide();
          else app.quit();
        });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        require('./shortcuts.cjs').registerDesktopShortcuts(win, origin);
        win.webContents.on('will-navigate', (event, url) => {
          if (new URL(url).origin !== origin) event.preventDefault();
        });
        win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
        try {
          tray = new Tray(trayIcon());
          tray.on('double-click', openWindow);
          updateMenu();
        } catch {
          keepRunning = false;
        }
        powerMonitor.on('resume', resume);
        await win.loadURL(origin + '/');
        console.log(`LightMao desktop ready: ${origin}`);
        const preferences = win.webContents.getLastWebPreferences();
        console.log(
          JSON.stringify({
            electron: process.versions.electron,
            node: process.versions.node,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            sandbox: preferences.sandbox,
            trayAvailable: !!tray,
            keepRunning,
          }),
        );
      })
      .catch((error) => {
        if (!shuttingDown) console.error(error.message);
        app.quit();
      });
  }
}
