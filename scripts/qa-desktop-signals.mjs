import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { createApi } from '../apps/api/server.ts';
import { createLocalAgent } from '../apps/agent/server.ts';
import { Store } from '../packages/shared/store.ts';

// Browser plugin not available. Each real Electron process has its own profile;
// no user Chrome profile or active LightMao services are used by this check.
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'lm-desktop-signals-'));
const artifacts = resolve(
  process.env.LIGHTMAO_QA_ARTIFACT_DIR || join(tmpdir(), `lm-signal-artifacts-${Date.now()}`),
);
await mkdir(artifacts, { recursive: true });
const api = await createApi({ dataDir: join(root, 'cloud'), demo: true });
await api.app.listen({ host: '127.0.0.1', port: 0 });
const apiBase = `http://127.0.0.1:${api.app.server.address().port}`;
const completed = [];
const cases = [];

async function reservePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function health(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
async function until(check, message, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};

async function check(mode, signal) {
  const label = `${mode}-${signal}`;
  const dataDir = join(root, label);
  const port = await reservePort();
  const agentURL = `http://127.0.0.1:${port}/local/health`;
  const env = {
    ...process.env,
    LIGHTMAO_API_URL: apiBase,
    LIGHTMAO_DATA_DIR: dataDir,
    LIGHTMAO_QA_PROFILE: join(dataDir, 'profile'),
    LIGHTMAO_USER_DATA_DIR: join(dataDir, 'profile'),
    AGENT_PORT: String(port),
  };
  for (const key of Object.keys(env))
    if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  let app, child, externalAgent, desktopPID, proxyURL;
  let output = '';
  const receipt = { mode, signal };
  cases.push(receipt);
  try {
    if (mode === 'external') {
      externalAgent = await createLocalAgent({ dataDir, apiUrl: apiBase });
      await externalAgent.app.listen({ host: '127.0.0.1', port });
    }
    if (mode === 'launcher') {
      child = spawn(process.execPath, ['scripts/desktop.mjs'], {
        cwd: resolve('.'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
      child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
      await until(
        () => /LightMao desktop ready: http:\/\/127\.0\.0\.1:\d+/.test(output),
        'Launcher did not reach ready',
      );
      proxyURL = output.match(/LightMao desktop ready: (http:\/\/127\.0\.0\.1:\d+)/)[1];
      const pids = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number);
      assert.equal(pids.length, 1, 'Launcher should own exactly one Electron main');
      desktopPID = pids[0];
      assert.equal(await health(proxyURL), true);
    } else {
      app = await electron.launch({
        executablePath: require('electron'),
        args: ['scripts/qa-desktop-entry.cjs'],
        cwd: resolve('.'),
        env,
        timeout: 30000,
      });
      const window = await app.firstWindow();
      await window.getByRole('navigation', { name: '主导航' }).waitFor();
      child = app.process();
      child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
      child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
      desktopPID = child.pid;
      receipt.lifecycle = await app.evaluate(({ app }) => {
        for (const event of ['before-quit', 'will-quit', 'quit'])
          app.on(event, () => console.log('QA_LIFECYCLE:' + event));
        for (const event of ['SIGTERM', 'SIGINT'])
          process.on(event, () => console.log('QA_LIFECYCLE:' + event));
        return { sigtermHandlers: process.listenerCount('SIGTERM') };
      });
      const runtime = await window.evaluate(() => window.lightmaoDesktop.runtimeStatus());
      assert(runtime.trayAvailable && runtime.keepRunning);
      assert.equal(runtime.ownsAgent, mode !== 'external');
    }
    assert.equal(await health(agentURL), true);
    const db = new Store(join(dataDir, 'local.sqlite'));
    const agentPID = db.get('runtime-lease', 'agent', 'system').pid;
    db.close();
    receipt.ready = true;
    const started = Date.now();
    assert(child.kill(signal), 'Signal was not sent');
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      'Desktop signal exit timed out',
    );
    receipt.elapsedMs = Date.now() - started;
    receipt.exitCode = child.exitCode;
    receipt.signalCode = child.signalCode;
    receipt.trace = output
      .split('\n')
      .filter((line) => /^(QA_LIFECYCLE:|LightMao service |agent shutdown)/.test(line));
    assert.equal(alive(desktopPID), false, 'Electron main remains after launcher exit');
    if (mode === 'external') {
      assert.equal(await health(agentURL), true, 'External Agent must stay alive');
      assert.equal(alive(agentPID), true);
    } else {
      await until(async () => !(await health(agentURL)), 'Owned Agent is still serving');
      assert.equal(alive(agentPID), false, 'Owned Agent process remains');
      const readback = new Store(join(dataDir, 'local.sqlite'));
      assert.equal(readback.get('runtime-lease', 'agent', 'system'), undefined);
      readback.close();
    }
    assert.equal(await health(apiBase + '/api/health'), true, 'External API must stay alive');
    if (proxyURL) assert.equal(await health(proxyURL), false);
    receipt.passed = true;
    completed.push(label);
    console.log(JSON.stringify({ passed: label, elapsedMs: receipt.elapsedMs }));
  } catch (error) {
    receipt.passed = false;
    receipt.error = error.message;
    throw error;
  } finally {
    // Only processes created by this case are closed. No port-based kill.
    if (app) await app.close().catch(() => {});
    if (desktopPID && alive(desktopPID)) process.kill(desktopPID, 'SIGKILL');
    if (child?.pid && alive(child.pid)) child.kill('SIGKILL');
    await externalAgent?.app.close();
  }
}

try {
  await check('owned', 'SIGTERM');
  if (!process.argv.includes('--baseline')) {
    await check('owned', 'SIGINT');
    await check('external', 'SIGTERM');
    await check('launcher', 'SIGTERM');
    await check('launcher', 'SIGINT');
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  api.app.server.closeAllConnections();
  await api.app.close();
  await writeFile(
    join(artifacts, 'receipt.json'),
    JSON.stringify(
      { at: new Date().toISOString(), passed: !process.exitCode, completed, cases },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
}
