const { createServer, request: httpRequest } = require('node:http');
const { request: httpsRequest } = require('node:https');
const { readFile } = require('node:fs/promises');
const { resolve, extname, sep } = require('node:path');

const hopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
function cleanHeaders(headers) {
  const result = { ...headers };
  for (const name of hopHeaders) delete result[name];
  return result;
}
function responseHeaders(headers) {
  const result = cleanHeaders(headers);
  // The desktop's browser-facing transport is an HTTP loopback socket. Preserve
  // HttpOnly/SameSite/Path while adapting only this application's refresh cookie;
  // the remote HTTPS API still emits Secure for its own browser clients.
  if (result['set-cookie'])
    result['set-cookie'] = result['set-cookie'].map((cookie) =>
      cookie.startsWith('lightmao_refresh=') ? cookie.replace(/;\s*Secure(?=;|$)/gi, '') : cookie,
    );
  return result;
}

function createDesktopServer({ webRoot, apiBase, agentBase }) {
  const root = resolve(webRoot);
  for (const base of [apiBase, agentBase]) {
    if (base && !['http:', 'https:'].includes(new URL(base).protocol))
      throw new Error('Invalid service URL');
  }
  const server = createServer(async (req, res) => {
    const error = (status, message) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    };
    try {
      const address = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== address) return error(403, 'Host is not allowed');
      if (!req.url.startsWith('/') || req.url.startsWith('//'))
        return error(400, 'Invalid request URL');
      const url = new URL(req.url, `http://${address}`);
      const path = url.pathname;
      if (path.startsWith('/api/') || path.startsWith('/local/')) {
        if (req.headers.origin && req.headers.origin !== `http://${address}`)
          return error(403, 'Origin is not allowed');
        const base = path.startsWith('/api/') ? apiBase : agentBase;
        if (!base) return error(503, '请先配置后端连接');
        const upstream = new URL(base);
        upstream.pathname = path;
        upstream.search = url.search;
        const headers = { ...cleanHeaders(req.headers), host: upstream.host };
        delete headers.origin;
        const proxy = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(
          upstream,
          { method: req.method, headers },
          (response) => {
            res.writeHead(response.statusCode || 502, responseHeaders(response.headers));
            response.pipe(res);
            response.on('error', () => res.destroy());
          },
        );
        proxy.on('error', () => error(502, 'Service unavailable'));
        req.on('aborted', () => proxy.destroy());
        res.on('close', () => proxy.destroy());
        req.pipe(proxy);
        return;
      }
      const pathname = path === '/' || path === '/admin' ? '/index.html' : decodeURIComponent(path);
      const file = resolve(root, `.${pathname}`);
      if (!file.startsWith(root + sep)) return error(403, 'Path is not allowed');
      const content = await readFile(file);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.ico': 'image/x-icon',
      };
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' blob: data:; object-src 'none'; frame-src http://127.0.0.1:*; base-uri 'self'",
      );
      res.end(content);
    } catch {
      error(404, 'Not found');
    }
  });
  return server;
}

module.exports = { createDesktopServer };
