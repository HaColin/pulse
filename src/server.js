import fs from 'node:fs';
import http from 'node:http';

const PAGE = new URL('./dashboard.html', import.meta.url);
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function serveDashboard({ port, getState }) {
  const server = http.createServer(async (req, res) => {
    // Only answer requests addressed to this machine, so another site cannot read the team feed via DNS rebinding.
    if (!LOCAL_HOST_RE.test(req.headers.host ?? '')) return res.writeHead(403).end('forbidden');
    const route = (req.url ?? '/').split('?')[0];
    try {
      if (route === '/api/state') {
        const body = JSON.stringify(await getState());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(body);
      }
      if (route === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(PAGE));
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      res.writeHead(500).end(err.message);
    }
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempts++ < 10) server.listen(++port, '127.0.0.1');
      else reject(err);
    });
    server.on('listening', () => resolve({ server, port }));
    server.listen(port, '127.0.0.1');
  });
}
