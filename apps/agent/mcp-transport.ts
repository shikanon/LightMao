import {
  Client,
  parseJSONRPCMessage,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { IsolatedProcess } from './isolation.ts';

export class SandboxedMcpTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private closed = false;
  private closing?: Promise<void>;
  private pending = Buffer.alloc(0);
  private received = 0;
  private stderrBytes = 0;
  private stderr = Buffer.alloc(0);
  private exit?: { code: number | null; signal: NodeJS.Signals | null };
  constructor(private proc: IsolatedProcess) {}
  async start() {
    this.proc.child.stdin.on('error', (error) => this.onerror?.(error));
    this.proc.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-64000);
      if (this.stderrBytes > 1024 * 1024) this.fail('MCP 错误日志超过上限');
    });
    this.proc.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      this.received += chunk.length;
      if (this.received > 8 * 1024 * 1024 || this.pending.length + chunk.length > 1024 * 1024)
        return this.fail('MCP 消息超过上限');
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.includes(10)) {
        const boundary = this.pending.indexOf(10);
        const line = this.pending.subarray(0, boundary).toString('utf8');
        this.pending = this.pending.subarray(boundary + 1);
        if (!line.trim()) continue;
        try {
          this.onmessage?.(parseJSONRPCMessage(JSON.parse(line)));
        } catch {
          this.fail('MCP 返回了无效的协议消息');
          break;
        }
      }
    });
    void this.proc.done.then(
      (result) => {
        this.exit = result;
        return this.close();
      },
      () => this.fail('MCP 子进程启动失败'),
    );
  }
  diagnostics() {
    return {
      stderr: this.stderr.toString('utf8'),
      stderrBytes: this.stderrBytes,
      stderrTruncated: this.stderrBytes > this.stderr.length,
      ...this.exit,
    };
  }
  private fail(message: string) {
    if (this.closed) return;
    this.onerror?.(new Error(message));
    void this.close();
  }
  async send(message: JSONRPCMessage) {
    if (this.closed) throw new Error('MCP 连接已关闭');
    const line = serializeMessage(message);
    if (Buffer.byteLength(line) > 256000) throw new Error('MCP 请求超过上限');
    await new Promise<void>((resolve, reject) =>
      this.proc.child.stdin.write(line, (error) => (error ? reject(error) : resolve())),
    );
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      this.onclose?.();
      await this.proc.close();
    });
    return this.closing;
  }
}

const localNames = new Set(['localhost', '127.0.0.1', '[::1]']);
export function mcpEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.length > 2048 ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localNames.has(url.hostname)))
  )
    throw new Error('MCP 地址须为 HTTPS，或本机回环 HTTP；凭据请填写在请求头中');
  return url;
}
function privateAddress(address: string) {
  if (isIP(address) === 6)
    return !/^2[0-9a-f]{3}:/i.test(address) || /^2001:(?:db8|0*0):/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
/** Bound the endpoint, pin validated DNS, reject redirects, and cap streaming data. */
export function mcpFetch(endpoint: URL, signal: AbortSignal): typeof fetch {
  let total = 0;
  return async (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.href !== endpoint.href) throw new Error('MCP 请求不能转向其他地址');
    const local = localNames.has(target.hostname);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true });
    if (!addresses.length || (!local && addresses.some((a) => privateAddress(a.address))))
      throw new Error('MCP 公网地址解析到了未授权的内网地址');
    if (local && addresses.some((a) => a.address !== '127.0.0.1' && a.address !== '::1'))
      throw new Error('本机 MCP 地址必须解析为回环地址');
    const address = addresses[0];
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const body =
      init.body ?? (input instanceof Request ? Buffer.from(await input.arrayBuffer()) : undefined);
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !(body instanceof Uint8Array)
    )
      throw new Error('不支持此 MCP 请求体');
    if (body && Buffer.byteLength(body as string | Uint8Array) > 256000)
      throw new Error('MCP 请求超过上限');
    const combined = AbortSignal.any([
      signal,
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(30000),
    ]);
    combined.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
        target,
        {
          method: init.method || (input instanceof Request ? input.method : 'GET'),
          family: address.family,
          headers: Object.fromEntries(headers),
          signal: combined,
          lookup: (_name, _options, callback) => callback(null, address.address, address.family),
        },
        (response) => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            response.destroy();
            request.destroy();
            reject(new Error('MCP 重定向已阻止'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined)
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          let bytes = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                total += chunk.length;
                if (bytes > 1024 * 1024 || total > 8 * 1024 * 1024)
                  response.destroy(new Error('MCP 响应超过上限'));
                else {
                  controller.enqueue(chunk);
                  if ((controller.desiredSize || 0) <= 0) response.pause();
                }
              });
              response.on('end', () => controller.close());
              response.on('error', (error) => controller.error(error));
            },
            pull() {
              response.resume();
            },
            cancel() {
              response.destroy();
              request.destroy();
            },
          });
          const status = response.statusCode || 502;
          if ([204, 205, 304].includes(status) || init.method === 'HEAD') {
            response.resume();
            resolve(new Response(null, { status, headers: responseHeaders }));
          } else resolve(new Response(stream, { status, headers: responseHeaders }));
        },
      );
      request.on('error', reject);
      request.end(body || undefined);
    });
  };
}

export const newMcpClient = (validator: ConstructorParameters<typeof Client>[1]) =>
  new Client({ name: 'LightMao', version: '0.1.0' }, validator);
