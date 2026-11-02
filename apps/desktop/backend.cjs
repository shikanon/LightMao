const { createHash, randomUUID } = require('node:crypto');
const {
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  rmSync,
  fstatSync,
  constants,
} = require('node:fs');
const { join } = require('node:path');

const fail = (status, error) => {
  throw Object.assign(new Error(error), { status });
};
function backendURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.trim())
    fail(400, '请输入后端地址');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail(400, '后端地址格式不正确');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    fail(400, '后端地址仅包含协议、主机和端口');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    fail(400, '远程后端需要 HTTPS；本机可使用 HTTP 回环地址');
  return url.origin;
}
const namespace = (url) => createHash('sha256').update(backendURL(url)).digest('hex');
class BackendSettings {
  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'backend-settings.json');
  }
  read() {
    let fd;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096) fail(500, '后端设置文件无效');
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (!Number.isSafeInteger(value.revision) || value.revision < 0)
        fail(500, '后端设置版本无效');
      return { url: backendURL(value.url), revision: value.revision };
    } catch (error) {
      if (error.code === 'ENOENT') return { url: '', revision: 0 };
      throw Object.assign(
        new Error('后端设置无法读取，请检查用户资料目录中的 backend-settings.json'),
        { status: 500 },
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  save(url, revision) {
    const normalized = backendURL(url),
      current = this.read();
    if (!Number.isSafeInteger(revision) || revision !== current.revision)
      fail(409, '连接设置已更改，请重新打开设置');
    if (normalized === current.url) return { ...current, changed: false };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const next = { url: normalized, revision: current.revision + 1 };
    const path = this.path + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeFileSync(fd, JSON.stringify(next) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(path, this.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(path, { force: true });
    }
    return { ...next, changed: true };
  }
}
async function probeBackend(value) {
  const url = backendURL(value),
    start = Date.now();
  let response;
  try {
    response = await fetch(url + '/api/health', {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
  } catch {
    fail(502, '无法连接后端，请检查地址、网络和 HTTPS 证书');
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail(502, '后端健康检查未通过，请使用服务的最终地址');
  }
  const reader = response.body?.getReader();
  if (!reader) fail(502, '后端没有返回健康信息');
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 32768) fail(502, '后端健康信息超过限制');
      parts.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    fail(502, '地址不是有效的 LightMao 后端');
  }
  if (
    data.service !== 'LightMao API' ||
    data.ok !== true ||
    (data.protocolVersion !== undefined && data.protocolVersion !== 1)
  )
    fail(502, '后端类型或协议版本不兼容');
  return {
    url,
    service: 'LightMao API',
    protocolVersion: data.protocolVersion || 1,
    demoAllowed: data.demoAllowed === true,
    durationMs: Date.now() - start,
  };
}
module.exports = { BackendSettings, backendURL, namespace, probeBackend };
