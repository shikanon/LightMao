// Owned, ephemeral game renderer. No application preload, login state or server keys.
const { app, BrowserWindow, session } = require('electron');
const { createInterface } = require('node:readline');
const { mkdirSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');
for (const key of Object.keys(process.env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete process.env[key];
const profile = process.argv
  .find((a) => a.startsWith('--lightmao-playtest-profile='))
  ?.split('=')
  .slice(1)
  .join('=');
if (!profile || !isAbsolute(profile)) throw Error('Playtest requires an owned profile');
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setName('LightMao Playtest');
app.enableSandbox();
let win,
  prefix,
  monitor = false,
  ready,
  queue = Promise.resolve();
const errors = [];
const actionHistory = [];
const world = 991;
function installObserver() {
  if (globalThis.__lightmaoObserved) return;
  const documentIdentity = crypto.randomUUID(),
    nodes = new Map(),
    ids = new WeakMap();
  let serial = 0,
    last;
  const keySet = new Set([
    'UP',
    'DOWN',
    'LEFT',
    'RIGHT',
    'W',
    'A',
    'S',
    'D',
    'SPACE',
    'ENTER',
    'ESCAPE',
    'R',
    'E',
    'SHIFT',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
  ]);
  const nodeId = (e) => {
    if (!ids.has(e)) {
      const id = 'node-' + ++serial;
      ids.set(e, id);
      nodes.set(id, e);
    }
    return ids.get(e);
  };
  const visible = (e) => {
    const r = e.getBoundingClientRect(),
      s = getComputedStyle(e);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth &&
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      Number(s.opacity) !== 0
    );
  };
  const label = (e) =>
    (
      e.getAttribute('aria-label') ||
      e.getAttribute('title') ||
      e.labels?.[0]?.textContent ||
      e.placeholder ||
      e.textContent ||
      e.value ||
      e.tagName
    )
      .trim()
      .slice(0, 300);
  const formSignature = () =>
    JSON.stringify(
      [...document.querySelectorAll('input,textarea,select')]
        .slice(0, 100)
        .map((e) => [nodeId(e), e.value, e.checked]),
    );
  function readGameState() {
    const contract = document.querySelector(
      'script[type="application/json"][data-lightmao-playtest]',
    );
    if (!contract || contract.textContent.length > 24000) return;
    try {
      const state = JSON.parse(contract.textContent).state;
      if (
        state &&
        typeof state === 'object' &&
        !Array.isArray(state) &&
        JSON.stringify(state).length <= 8000
      )
        return state;
    } catch {}
  }
  function observe() {
    const actions = [];
    for (const e of document.querySelectorAll(
      'button,a[href],input,textarea,select,[role="button"],[role="tab"],[role="textbox"]',
    )) {
      if (actions.length >= 160) break;
      if (!visible(e) || e.disabled || e.getAttribute('aria-disabled') === 'true') continue;
      if (e.tagName === 'INPUT' && ['password', 'file', 'hidden'].includes(e.type)) continue;
      const node = nodeId(e),
        name = label(e);
      if (e.tagName === 'SELECT') {
        for (const option of e.options) {
          if (actions.length >= 160) break;
          if (!option.disabled)
            actions.push({
              id: node + ':select:' + actions.length,
              operation: 'SELECT',
              node,
              label: name + ' → ' + option.label,
              value: option.value,
            });
        }
      } else if (
        e.tagName === 'TEXTAREA' ||
        (e.tagName === 'INPUT' &&
          !['submit', 'button', 'checkbox', 'radio', 'range', 'color'].includes(e.type)) ||
        e.getAttribute('role') === 'textbox'
      )
        actions.push({
          id: node + ':fill',
          operation: 'TYPE_TEXT',
          node,
          label: name,
          value: String(e.value || '').slice(0, 1000),
        });
      else actions.push({ id: node + ':click', operation: 'CLICK', node, label: name });
    }
    let gameState;
    const contract = document.querySelector(
      'script[type="application/json"][data-lightmao-playtest]',
    );
    if (contract && contract.textContent.length <= 24000) {
      try {
        const data = JSON.parse(contract.textContent);
        if (
          data.state &&
          typeof data.state === 'object' &&
          !Array.isArray(data.state) &&
          JSON.stringify(data.state).length <= 8000
        )
          gameState = data.state;
        for (const action of Array.isArray(data.actions) ? data.actions.slice(0, 24) : []) {
          if (
            typeof action.id === 'string' &&
            /^[\w-]{1,60}$/.test(action.id) &&
            typeof action.label === 'string' &&
            keySet.has(action.key) &&
            !actions.some((a) => a.id === 'game:' + action.id)
          )
            actions.push({
              id: 'game:' + action.id,
              operation: 'PRESS_KEY',
              label: action.label.slice(0, 300),
              key: action.key,
              holdMs: Math.max(20, Math.min(500, Math.round(action.holdMs || 120))),
            });
        }
      } catch {}
    }
    if (scrollY > 0) actions.push({ id: 'scroll-up', operation: 'SCROLL_UP', label: '向上滚动' });
    if (scrollY + innerHeight < document.documentElement.scrollHeight - 2)
      actions.push({ id: 'scroll-down', operation: 'SCROLL_DOWN', label: '向下滚动' });
    actions.push({ id: 'wait', operation: 'WAIT', label: '等待1秒后重新观察页面与游戏状态' });
    last = {
      id: crypto.randomUUID(),
      documentIdentity,
      forms: formSignature(),
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 16000),
      actions,
      gameState,
    };
    return {
      id: last.id,
      url: last.url,
      title: last.title,
      text: last.text,
      actions: last.actions,
      gameState,
    };
  }
  function prepare(id, actionId) {
    if (
      !last ||
      last.id !== id ||
      last.documentIdentity !== documentIdentity ||
      last.url !== location.href ||
      last.forms !== formSignature()
    )
      throw Error('STALE_OBSERVATION');
    const action = last.actions.find((a) => a.id === actionId);
    if (!action) throw Error('UNOBSERVED_ACTION');
    if (action.operation === 'PRESS_KEY') {
      const contract = document.querySelector(
        'script[type="application/json"][data-lightmao-playtest]',
      );
      let data;
      try {
        data = JSON.parse(contract?.textContent || '{}');
      } catch {}
      if (!data?.actions?.some((a) => 'game:' + a.id === action.id && a.key === action.key))
        throw Error('STALE_GAME_ACTION');
      return action;
    }
    if (!action.node) return action;
    const e = nodes.get(action.node);
    if (!e?.isConnected || !visible(e) || e.disabled) throw Error('STALE_TARGET');
    const r = e.getBoundingClientRect(),
      x = Math.max(1, Math.min(innerWidth - 1, r.left + r.width / 2)),
      y = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    if (top !== e && !e.contains(top)) throw Error('OCCLUDED_TARGET');
    if (action.operation === 'CLICK' && label(e) !== action.label)
      throw Error('STALE_TARGET_LABEL');
    if (
      action.operation === 'SELECT' &&
      ![...e.options].some((o) => !o.disabled && o.value === action.value)
    )
      throw Error('STALE_OPTION');
    return { ...action, x, y };
  }
  function focus(node) {
    const e = nodes.get(node);
    if (!e?.isConnected) throw Error('STALE_TARGET');
    e.focus();
  }
  function select(node, value) {
    const e = nodes.get(node);
    if (!e?.isConnected || e.tagName !== 'SELECT') throw Error('STALE_TARGET');
    e.value = value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }
  globalThis.__lightmaoObserved = { observe, prepare, focus, select, readGameState };
}
async function evaluate(expression) {
  if (!win || win.isDestroyed()) throw Error('Playtest window closed');
  if (!win.webContents.getURL().startsWith(prefix))
    throw Error('Playtest navigation left owned preview');
  const result = await win.webContents.executeJavaScriptInIsolatedWorld(world, [
    {
      code:
        '(async()=>{try{return {ok:true,value:await (' +
        expression +
        ')}}catch{return {ok:false}}})()',
    },
  ]);
  if (!result.ok) throw Error('OBSERVATION_GUARD_REJECTED');
  return result.value;
}
async function observe() {
  await evaluate('(' + installObserver.toString() + ')()');
  const observation = await evaluate('globalThis.__lightmaoObserved.observe()');
  return { ...observation, recentActions: actionHistory.slice(-10) };
}
async function handle(input) {
  if (input.op === 'init') {
    if (win) throw Error('Already initialized');
    const url = new URL(input.url);
    monitor = input.monitor === true;
    if (
      monitor
        ? !['http:', 'https:'].includes(url.protocol) || url.username || url.password
        : url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          !/^\/[a-f0-9]{48}\//.test(url.pathname)
    )
      throw Error('Only owned loopback preview allowed');
    prefix = monitor
      ? url.origin + '/'
      : url.origin + url.pathname.slice(0, url.pathname.indexOf('/', 1) + 1);
    await app.whenReady();
    const partition = session.fromPartition('lightmao-playtest-' + randomUUID(), { cache: false });
    partition.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel:
          !details.url.startsWith(prefix) &&
          !details.url.startsWith('data:') &&
          !details.url.startsWith('blob:') &&
          details.url !== 'about:blank',
      }),
    );
    win = new BrowserWindow({
      width: Math.max(240, Math.min(1920, Number(input.viewport?.width) || 1040)),
      height: Math.max(240, Math.min(1920, Number(input.viewport?.height) || 760)),
      show: !!input.visible,
      title: 'LightMao · 游戏试玩',
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setAudioMuted(true);
    win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
    win.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith(prefix)) e.preventDefault();
    });
    win.webContents.on('console-message', (_e, details, ...old) => {
      const entry =
        typeof details === 'object'
          ? details
          : { level: details, message: old[0], lineNumber: old[1], sourceId: old[2] };
      if (errors.length < 100 && (entry.level === 'error' || entry.level === 3))
        errors.push(
          (
            String(entry.message) +
            (entry.sourceId
              ? ' at ' +
                String(entry.sourceId).replace(prefix, '').slice(0, 300) +
                ':' +
                (entry.lineNumber || 0)
              : '')
          ).slice(0, 1000),
        );
    });
    await win.loadURL(input.url, {
      extraHeaders: 'Cache-Control: no-cache, no-store\nPragma: no-cache',
    });
    if (monitor) await new Promise((done) => setTimeout(done, 150));
    ready = true;
    return {
      pid: process.pid,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      observation: await observe(),
    };
  }
  if (!ready) throw Error('Playtest not initialized');
  if (input.op === 'observe') return observe();
  if (input.op === 'diagnostics') return { errors: errors.slice() };
  if (input.op === 'act') {
    if (monitor) throw Error('Monitor is read-only');
    const action = await evaluate(
      'globalThis.__lightmaoObserved.prepare(' +
        JSON.stringify(input.observationId) +
        ',' +
        JSON.stringify(input.actionId) +
        ')',
    );
    const beforeGameState = await evaluate('globalThis.__lightmaoObserved.readGameState()'),
      startedAt = Date.now();
    input._acted = true;
    if (action.operation === 'CLICK') {
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: Math.round(action.x),
        y: Math.round(action.y),
        button: 'left',
        clickCount: 1,
      });
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: Math.round(action.x),
        y: Math.round(action.y),
        button: 'left',
        clickCount: 1,
      });
    } else if (action.operation === 'TYPE_TEXT') {
      if (typeof input.text !== 'string' || input.text.length > 1000)
        throw Error('Invalid bounded field text');
      await evaluate('globalThis.__lightmaoObserved.focus(' + JSON.stringify(action.node) + ')');
      win.webContents.selectAll();
      win.webContents.insertText(input.text);
    } else if (action.operation === 'SELECT')
      await evaluate(
        'globalThis.__lightmaoObserved.select(' +
          JSON.stringify(action.node) +
          ',' +
          JSON.stringify(action.value) +
          ')',
      );
    else if (action.operation === 'PRESS_KEY') {
      const keys = {
        UP: 'Up',
        DOWN: 'Down',
        LEFT: 'Left',
        RIGHT: 'Right',
        SPACE: 'Space',
        ENTER: 'Return',
        ESCAPE: 'Escape',
        SHIFT: 'Shift',
        0: '0',
        1: '1',
        2: '2',
        3: '3',
        4: '4',
        5: '5',
        6: '6',
        7: '7',
        8: '8',
        9: '9',
      };
      const key = keys[action.key] || action.key;
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      await new Promise((done) => setTimeout(done, action.holdMs));
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    } else if (action.operation === 'SCROLL_DOWN' || action.operation === 'SCROLL_UP')
      win.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: 500,
        y: 350,
        deltaY: action.operation === 'SCROLL_DOWN' ? 500 : -500,
        deltaX: 0,
        canScroll: true,
      });
    else if (action.operation === 'WAIT') await new Promise((done) => setTimeout(done, 1000));
    else throw Error('Unsupported observed action');
    await evaluate(
      'new Promise(resolve=>{let n=0;const end=()=>{if(++n>=2)resolve();else requestAnimationFrame(end)};requestAnimationFrame(end);setTimeout(resolve,80)})',
    );
    const observation = await observe(),
      afterGameState = observation.gameState,
      changedKeys =
        beforeGameState && afterGameState
          ? [...new Set([...Object.keys(beforeGameState), ...Object.keys(afterGameState)])]
              .filter(
                (key) =>
                  key.length <= 160 &&
                  JSON.stringify(beforeGameState[key]) !== JSON.stringify(afterGameState[key]),
              )
              .slice(0, 80)
          : [];
    actionHistory.push({
      actionId: action.id,
      operation: action.operation,
      label: action.label,
      observationId: input.observationId,
      afterObservationId: observation.id,
      at: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      ...(beforeGameState ? { beforeGameState } : {}),
      ...(afterGameState ? { afterGameState } : {}),
      changedKeys,
    });
    if (actionHistory.length > 10) actionHistory.shift();
    return {
      observation: { ...observation, recentActions: actionHistory.slice() },
      executed: action.operation,
    };
  }
  if (input.op === 'screenshot') {
    const capture = await win.webContents.capturePage();
    return {
      base64: capture.toPNG().toString('base64'),
      thumbnail: capture.resize({ width: 480 }).toJPEG(75).toString('base64'),
      errors,
    };
  }
  if (input.op === 'monitor_screenshot') {
    if (!monitor) throw Error('Not a registered monitor capture');
    const captured = await win.webContents.capturePage();
    return {
      base64: captured.toPNG().toString('base64'),
      thumbnail: captured.resize({ width: 1000 }).toJPEG(65).toString('base64'),
      errors,
      url: win.webContents.getURL(),
    };
  }
  if (input.op === 'close') {
    win.destroy();
    app.quit();
    return { closed: true };
  }
  throw Error('Unsupported playtest command');
}
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.length > 100000) return;
  let input;
  try {
    input = JSON.parse(line);
  } catch {
    return;
  }
  queue = queue.then(async () => {
    try {
      const result = await handle(input);
      process.stdout.write(JSON.stringify({ id: input.id, ok: true, result }) + '\n');
    } catch {
      process.stdout.write(
        JSON.stringify({
          id: input.id,
          ok: false,
          outcome: input._acted ? 'unknown' : 'not_executed',
          error: '观察已过期、目标被遮挡或动作未获支持；未绕过执行校验。',
        }) + '\n',
      );
    }
  });
});
lines.on('close', () => {
  void queue.finally(() => app.quit());
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());
