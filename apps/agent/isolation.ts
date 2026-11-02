import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

export interface IsolationStatus {
  available: boolean;
  platform: string;
  engine: string;
  error?: string;
}
export interface ExecutionPolicy {
  root: string;
  writable: boolean;
  readPaths?: string[];
  writePaths?: string[];
  sensitive?: boolean;
  domains?: string[];
  timeoutMs?: number;
  outputBytes?: number;
  env?: Record<string, string>;
  graphics?: boolean;
}
export interface IsolatedProcess {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate: () => void;
  close: () => Promise<void>;
  scratch: string;
}
const failed = (message: string, code = 'SANDBOX_UNAVAILABLE'): never => {
  throw Object.assign(new Error(message), { code, statusCode: 503 });
};
const quote = (word: string) => "'" + word.replaceAll("'", "'\"'\"'") + "'";

/** Decode only the pinned SDK's quote(argv) output. Never evaluate shell text. */
export function decodeSandboxArgv(text: string) {
  const result: string[] = [];
  let word = '',
    quoted = false,
    present = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
      continue;
    }
    if (char === "'") {
      quoted = true;
      present = true;
      continue;
    }
    if (text.slice(index, index + 3) === '"\'"') {
      word += "'";
      present = true;
      index += 2;
      continue;
    }
    if (char === ' ') {
      if (present) {
        result.push(word);
        word = '';
        present = false;
      }
      continue;
    }
    if (!/[A-Za-z0-9_./:=@+,-]/.test(char)) failed('沙箱运行库的命令格式不受支持');
    word += char;
    present = true;
  }
  if (quoted) failed('沙箱运行库返回了不完整的命令');
  if (present) result.push(word);
  return result;
}
const systemReads =
  process.platform === 'darwin'
    ? [
        '/System/Library',
        '/usr/lib',
        '/usr/share',
        '/bin',
        '/dev/null',
        '/dev/random',
        '/dev/urandom',
        '/dev/fd',
        '/private/etc/ssl',
        '/private/etc/localtime',
      ]
    : [
        '/usr',
        '/bin',
        '/lib',
        '/lib64',
        '/dev',
        '/proc',
        '/sys',
        '/etc/ssl',
        '/etc/ld.so.cache',
        '/etc/localtime',
      ];
let initializing: Promise<void> | undefined,
  references = 0,
  networkSignature = '';
async function initialize(domains: string[]) {
  const signature = JSON.stringify([...domains].sort());
  if (initializing && signature !== networkSignature) failed('网络权限必须由独立的隔离代理承载');
  if (!initializing)
    initializing = (async () => {
      networkSignature = signature;
      if (process.platform !== 'darwin')
        failed('当前隔离运行器已验证 macOS；此平台的隔离执行尚未开放');
      await SandboxManager.initialize(
        {
          network: {
            allowedDomains: domains,
            deniedDomains: [],
            allowLocalBinding: false,
            allowUnixSockets: [],
            strictAllowlist: true,
          },
          filesystem: { denyRead: ['/'], allowRead: systemReads, allowWrite: [], denyWrite: [] },
        },
        undefined,
        false,
      );
      if (!SandboxManager.isSandboxingEnabled()) failed('操作系统隔离未启用');
    })().catch(async (error) => {
      try {
        await SandboxManager.reset();
      } finally {
        initializing = undefined;
      }
      throw error;
    });
  return initializing;
}

export class IsolatedExecutor {
  private active = new Set<IsolatedProcess>();
  private closed = false;
  private held = false;
  private serial = new Map<string, Promise<unknown>>();
  private program?: string;
  private runtimeReads: string[] = [];
  private readiness?: Promise<IsolationStatus>;
  readonly status: IsolationStatus = {
    available: false,
    platform: process.platform,
    engine:
      process.platform === 'darwin'
        ? 'macOS Seatbelt'
        : process.platform === 'linux'
          ? 'Linux bubblewrap'
          : '不可用',
  };
  constructor(
    readonly dataDir: string,
    readonly broker?: { domains: string[] },
  ) {}

  async ready() {
    if (!this.readiness) this.readiness = this.initialize();
    return this.readiness;
  }
  private async initialize(): Promise<IsolationStatus> {
    try {
      await initialize(this.broker?.domains || []);
      references++;
      this.held = true;
      this.program = await realpath(process.env.LIGHTMAO_SANDBOX_NODE || process.execPath);
      this.runtimeReads = [this.program];
      if (process.env.LIGHTMAO_SANDBOX_NODE_IS_ELECTRON === 'true')
        this.runtimeReads.push(resolve(dirname(this.program), '../Frameworks'));
      await mkdir(join(this.dataDir, 'sandbox'), { recursive: true, mode: 0o700 });
      this.status.available = true;
      const probeRoot = await mkdtemp(join(this.dataDir, 'sandbox', 'probe-'));
      const project = join(probeRoot, 'project');
      await mkdir(project);
      await writeFile(join(project, 'visible.txt'), 'visible');
      await writeFile(join(project, '.env'), 'hidden-canary');
      await writeFile(join(probeRoot, 'outside.txt'), 'outside-canary');
      try {
        const result = await this.runJSON<{
          read: string;
          hidden: boolean;
          outside: boolean;
          write: boolean;
          fork: boolean;
        }>(
          this.program,
          [
            '-e',
            `const fs=require('node:fs'),cp=require('node:child_process');const r={read:fs.readFileSync('visible.txt','utf8')};for(const [k,p] of [['hidden','.env'],['outside',${JSON.stringify(join(probeRoot, 'outside.txt'))}]]){try{fs.readFileSync(p);r[k]=true}catch{r[k]=false}}try{fs.writeFileSync('forbidden.txt','no');r.write=true}catch{r.write=false}const c=cp.spawnSync(process.execPath,['-e','process.stdout.write("forked")']);r.fork=!c.error;console.log(JSON.stringify(r))`,
          ],
          { root: project, writable: false, sensitive: true, timeoutMs: 8000 },
        );
        if (
          result.read !== 'visible' ||
          result.hidden ||
          result.outside ||
          result.write ||
          (process.platform === 'darwin' && result.fork)
        )
          failed('隔离自检未阻止越界访问或子进程');
      } finally {
        await rm(probeRoot, { recursive: true, force: true });
      }
    } catch (error) {
      this.status.available = false;
      this.status.error = error instanceof Error ? error.message : '沙箱初始化失败';
    }
    return this.status;
  }

  async prepare(
    command: string,
    args: string[],
    policy: ExecutionPolicy,
    scratch: string,
    commandId = randomBytes(24).toString('base64url'),
  ) {
    if (this.closed || !this.status.available) failed(this.status.error || '工具沙箱尚未就绪');
    const root = await realpath(policy.root);
    const sensitive =
      policy.sensitive !== false
        ? [
            root + '/**/.*',
            root + '/**/[pP][aA][sS][sS][wW][oO][rR][dD].*',
            root + '/**/[sS][eE][cC][rR][eE][tT]*',
            root + '/**/credentials/**',
          ]
        : [];
    const custom = {
      filesystem: {
        denyRead: ['/', ...sensitive],
        allowRead: [
          ...systemReads,
          ...this.runtimeReads,
          root,
          scratch,
          ...(policy.readPaths || []),
          command,
        ],
        allowWrite: [scratch, ...(policy.writable ? [root] : []), ...(policy.writePaths || [])],
        denyWrite: [...sensitive, ...(!policy.writable ? [root] : [])],
      },
    };
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      [command, ...args].map(quote).join(' '),
      '/bin/bash',
      custom,
      undefined,
      root,
      { commandId },
    );
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: scratch,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      LANG: 'C.UTF-8',
      NODE_NO_WARNINGS: '1',
      NODE_USE_ENV_PROXY: '1',
      ...policy.env,
    };
    if (process.env.LIGHTMAO_SANDBOX_NODE_IS_ELECTRON === 'true') env.ELECTRON_RUN_AS_NODE = '1';
    if (process.platform === 'darwin') {
      if (wrapped.argv[0] !== '/bin/bash' || wrapped.argv[1] !== '-c')
        failed('沙箱运行库的启动格式不受支持');
      const words = decodeSandboxArgv(wrapped.argv[2]);
      const boundary = words.indexOf('/usr/bin/sandbox-exec');
      if (words[0] !== 'env' || boundary < 1 || words[boundary + 1] !== '-p')
        failed('macOS 隔离策略缺失');
      for (const assignment of words.slice(1, boundary)) {
        const equal = assignment.indexOf('=');
        if (equal <= 0) failed('沙箱环境格式不受支持');
        const name = assignment.slice(0, equal);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) failed('沙箱环境格式不受支持');
        env[name] = assignment.slice(equal + 1);
      }
      // The SDK supplies its own shared TMPDIR. This process is allowed to
      // write only its private scratch, so every temp/home variable must agree.
      Object.assign(env, { HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch });
      env.NO_PROXY = '';
      env.no_proxy = '';
      for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ]) {
        if (!env[name]) continue;
        const proxy = new URL(env[name]);
        if (proxy.hostname === 'localhost') proxy.hostname = '127.0.0.1';
        env[name] = proxy.href;
      }
      // Each invocation executes its approved binary directly. The SDK's shell
      // is removed; no fork or second executable is permitted in this sandbox.
      const profile =
        words[boundary + 2] +
        (policy.graphics
          ? '\n(allow mach-lookup (global-name "com.apple.windowserver.active") (global-name "com.apple.hiservices-xpcservice"))\n'
          : '') +
        '\n(deny process-fork)\n' +
        `(deny process-exec (require-not (literal ${JSON.stringify(command)})))\n` +
        `(deny file-write* (require-all ${[scratch, ...(policy.writable ? [root] : []), ...(policy.writePaths || [])].map((path) => `(require-not (subpath ${JSON.stringify(path)}))`).join(' ')} (require-not (literal "/dev/null"))))\n`;
      return {
        command: '/usr/bin/sandbox-exec',
        args: ['-p', profile, command, ...args],
        env,
        root,
      };
    }
    return { command: wrapped.argv[0], args: wrapped.argv.slice(1), env, root };
  }

  async spawn(
    command: string,
    args: string[],
    policy: ExecutionPolicy,
    module?: { source: Buffer; extension: 'cjs' | 'mjs' },
  ): Promise<IsolatedProcess> {
    if (this.closed || !this.status.available) failed(this.status.error || '工具沙箱尚未就绪');
    const scratch = await realpath(await mkdtemp(join(this.dataDir, 'sandbox', 'exec-')));
    let closeBroker: (() => Promise<void>) | undefined;
    let launched: IsolatedProcess | undefined;
    try {
      if (module) {
        const entry = join(scratch, `entry.${module.extension}`);
        await writeFile(entry, module.source, { flag: 'wx', mode: 0o600 });
        args = [entry, ...args];
      }
      const executable = await realpath(command);
      const prepared =
        policy.domains?.length && !this.broker
          ? await this.prepareBroker(executable, args, policy, scratch)
          : { wrapped: await this.prepare(executable, args, policy, scratch), close: undefined };
      closeBroker = prepared.close;
      if (this.closed) failed('工具运行器已停止');
      const wrapped = prepared.wrapped;
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: wrapped.root,
        env: wrapped.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      child.once('error', () => {
        exited = true;
      });
      const terminate = () => {
        if (child.pid && !exited) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
      };
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      );
      launched = {
        child,
        done,
        terminate,
        scratch,
        close: async () => {
          terminate();
          await done.catch(() => {});
          await closeBroker?.();
          this.active.delete(launched!);
          await rm(scratch, { recursive: true, force: true });
        },
      };
      this.active.add(launched);
      void done.finally(() => closeBroker?.()).catch(() => {});
      return launched;
    } catch (error) {
      await closeBroker?.();
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  private async prepareBroker(
    command: string,
    args: string[],
    policy: ExecutionPolicy,
    scratch: string,
  ) {
    const brokerDir = await mkdtemp('/tmp/lm-proxy-');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: brokerDir,
      TMPDIR: brokerDir,
      LANG: 'C.UTF-8',
      NODE_NO_WARNINGS: '1',
    };
    if (process.env.LIGHTMAO_SANDBOX_NODE_IS_ELECTRON === 'true') {
      env.ELECTRON_RUN_AS_NODE = '1';
      env.LIGHTMAO_SANDBOX_NODE = this.program;
      env.LIGHTMAO_SANDBOX_NODE_IS_ELECTRON = 'true';
    }
    const child = spawn(
      this.program!,
      [resolve(import.meta.dirname, '../../dist/agent/isolation-broker.js')],
      { cwd: policy.root, env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    child.once('error', () => {
      exited = true;
    });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing)
        closing = (async () => {
          if (child.connected) child.disconnect();
          const timeout = setTimeout(() => {
            if (child.pid && !exited)
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {}
          }, 1500);
          try {
            await done.catch(() => {});
          } finally {
            clearTimeout(timeout);
            await rm(brokerDir, { recursive: true, force: true });
          }
        })();
      return closing;
    };
    try {
      const wrapped = await new Promise<Awaited<ReturnType<IsolatedExecutor['prepare']>>>(
        (resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('插件隔离代理启动超时')), 12000);
          const message = (data: unknown) => {
            const info = data as {
              wrapped?: Awaited<ReturnType<IsolatedExecutor['prepare']>>;
              error?: string;
            };
            clearTimeout(timeout);
            child.off('message', message);
            info.wrapped
              ? resolve(info.wrapped)
              : reject(new Error(info.error || '隔离代理不可用'));
          };
          child.on('message', message);
          void done.then(() => {
            clearTimeout(timeout);
            reject(new Error('插件隔离代理已退出'));
          }, reject);
          child.send!({ command, args, policy, scratch, dataDir: brokerDir });
        },
      );
      return { wrapped, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  get executable() {
    if (!this.program) failed('工具运行器尚未就绪');
    return this.program!;
  }
  async runJSON<T>(
    command: string,
    args: string[],
    policy: ExecutionPolicy,
    input?: unknown,
    signal?: AbortSignal,
    module?: { source: Buffer; extension: 'cjs' | 'mjs' },
  ): Promise<T> {
    signal?.throwIfAborted();
    const proc = await this.spawn(command, args, policy, module);
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      exceeded = false,
      timedOut = false;
    const limit = policy.outputBytes || 1024 * 1024;
    const abort = () => proc.terminate();
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.terminate();
    }, policy.timeoutMs || 15000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) proc.terminate();
    proc.child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > limit) {
        exceeded = true;
        proc.terminate();
      } else stdout = Buffer.concat([stdout, chunk]);
    });
    proc.child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr = Buffer.concat([stderr, chunk]).subarray(0, 8192);
    });
    proc.child.stdin.on('error', () => {});
    proc.child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    try {
      const result = await proc.done;
      signal?.throwIfAborted();
      if (timedOut) failed('隔离工具执行超时，结果尚未确认', 'TOOL_TIMEOUT');
      if (exceeded) failed('隔离工具输出超过上限，结果尚未确认', 'TOOL_OUTPUT_LIMIT');
      if (result.code !== 0)
        failed('隔离工具执行失败：' + stderr.toString('utf8').slice(0, 600), 'TOOL_PROCESS_FAILED');
      return JSON.parse(stdout.toString('utf8')) as T;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      await proc.close();
    }
  }
  file<T>(
    root: string,
    writable: boolean,
    operation: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    root = realpathSync(root);
    const work = async () => {
      const status = await this.ready();
      if (!status.available) failed(status.error || '工具沙箱不可用');
      const source = await readFile(
        resolve(import.meta.dirname, '../../dist/runtime/file-worker.cjs'),
      );
      const hash = createHash('sha256').update(source).digest('hex');
      const folder = join(this.dataDir, 'sandbox', 'runtime');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, `${hash}.cjs`);
      try {
        await writeFile(path, source, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex') !== hash
      )
        failed('工具运行文件校验失败');
      const response = await this.runJSON<{
        ok: boolean;
        value: T;
        error?: string;
        code?: string;
        statusCode?: number;
      }>(
        this.program!,
        [],
        {
          root,
          writable,
          sensitive: false,
          ...(operation === 'snapshot_skill'
            ? { outputBytes: 12 * 1024 * 1024, timeoutMs: 15000 }
            : operation === 'commit_game_asset_bundle'
              ? { timeoutMs: 60000 }
              : {}),
        },
        { root, operation, args },
        signal,
        { source, extension: 'cjs' },
      );
      if (!response.ok)
        throw Object.assign(new Error(response.error || '文件工具执行失败'), {
          code: response.code,
          statusCode: response.statusCode,
        });
      return response.value;
    };
    if (!writable) return work();
    return this.exclusive(root, work);
  }
  exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
    root = realpathSync(root);
    const previous = this.serial.get(root) || Promise.resolve();
    const promise = previous.catch(() => {}).then(work);
    this.serial.set(root, promise);
    return promise.finally(() => {
      if (this.serial.get(root) === promise) this.serial.delete(root);
    });
  }
  async close() {
    this.closed = true;
    await this.readiness;
    await Promise.allSettled([...this.active].map((p) => p.close()));
    if (this.held) {
      this.held = false;
      if (--references === 0) {
        await SandboxManager.reset();
        initializing = undefined;
      }
    }
  }
}
