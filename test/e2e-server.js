/**
 * test/e2e-server.js — dev-only local server: serves the static frontend and
 * routes /api/* to the serverless functions, mimicking Vercel.
 *
 * Usage: node test/e2e-server.js [port]   (default 3000)
 * Then open http://localhost:3000/scan.html
 *
 * Reads .env in the project root if present (for LLM_API_KEY etc.).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Load .env if present (simple KEY=VALUE parser; no dependency).
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
} catch (e) { /* ignore */ }

const ROUTES = {
  '/api/scan': require('../api/scan'),
  '/api/sample': require('../api/sample'),
  '/api/checkout': require('../api/checkout'),
  '/api/webhook': require('../api/webhook'),
  '/api/waitlist': require('../api/waitlist'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (ROUTES[pathname]) {
    let body;
    const raw = await readBody(req);
    if (raw && (req.headers['content-type'] || '').includes('application/json')) {
      try { body = JSON.parse(raw); } catch (e) { body = {}; }
    }
    const mockReq = { method: req.method, headers: req.headers, body: body || {} };
    const mockRes = {
      statusCode: 200,
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { this.statusCode = c; return this; },
      json(o) {
        res.writeHead(this.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(o));
      },
    };
    try {
      await ROUTES[pathname](mockReq, mockRes);
    } catch (e) {
      console.error('api error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error' }));
    }
    return;
  }

  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const port = Number(process.argv[2] || 3000);
server.listen(port, () => console.log(`FinePrint dev server: http://localhost:${port}/scan.html`));
