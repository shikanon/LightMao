import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { resolve, basename } from 'node:path';
import { once } from 'node:events';
import type { DecisionObservation } from '../../packages/shared/system-one.ts';

/** Fixed RPC into an ephemeral Electron renderer. The model cannot supply code, selectors or URLs. */
export class BrowserDriver {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  readonly done: Promise<unknown>;
  constructor(profile: string, electronPath?: string) {
    const require = createRequire(import.meta.url);
    const executable =
      electronPath || (process.versions.electron ? process.execPath : require('electron'));
    if (typeof executable !== 'string') throw Error('浏览器试玩需要桌面运行时');
    const main = resolve(import.meta.dirname, '../../apps/desktop/main.cjs');
    const args = [
      ...(/^electron(?:\.exe)?$/i.test(basename(executable)) ? [main] : []),
      '--lightmao-playtest-worker',
      '--lightmao-playtest-profile=' + profile,
    ];
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'zh_CN.UTF-8' };
    for (const name of ['HOME', 'TMPDIR', 'USER', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'])
      if (process.env[name]) env[name] = process.env[name];
    this.child = spawn(executable, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: resolve('.'),
    });
    this.done = once(this.child, 'exit').catch(() => {});
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (line.length > 8 * 1024 * 1024) return;
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.ok) p.resolve(data.result);
      else
        p.reject(Object.assign(Error(data.error || '浏览器动作未执行'), { outcome: data.outcome }));
    });
    this.child.stderr.resume();
    const failed = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('浏览器试玩进程已结束'));
      }
      this.pending.clear();
    };
    this.child.on('error', failed);
    this.child.on('exit', failed);
    this.child.stdin.on('error', () => {});
  }
  request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(Error('试玩已关闭'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('浏览器观察/动作超过时限'));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }
  init(url: string, visible = false, viewport?: { width: number; height: number }) {
    return this.request<{
      pid: number;
      contextIsolation: boolean;
      sandbox: boolean;
      nodeIntegration: boolean;
      observation: DecisionObservation;
    }>('init', { url, visible, ...(viewport ? { viewport } : {}) });
  }
  observe() {
    return this.request<DecisionObservation>('observe');
  }
  initMonitor(url: string) {
    return this.request('init', { url, monitor: true, visible: false });
  }
  monitorScreenshot() {
    return this.request<{ base64: string; thumbnail: string; errors: string[]; url: string }>(
      'monitor_screenshot',
    );
  }
  act(observationId: string, actionId: string, text?: string) {
    return this.request<{ observation: DecisionObservation; executed: string }>('act', {
      observationId,
      actionId,
      ...(text !== undefined ? { text } : {}),
    });
  }
  screenshot() {
    return this.request<{ base64: string; thumbnail?: string; errors: string[] }>('screenshot');
  }
  diagnostics() {
    return this.request<{ errors: string[] }>('diagnostics');
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill('SIGTERM');
    }, 2000);
    await this.done;
    clearTimeout(timer);
  }
}
