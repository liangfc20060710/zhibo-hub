import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZhiboRuntime } from './src/orchestrator.mjs';
import { runAcceptance } from './src/acceptance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

const clients = new Set();
let eventSeq = 0;

function broadcast(type, payload) {
  eventSeq += 1;
  const frame = { seq: eventSeq, type, payload, at: Date.now() };
  const data = `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

const runtime = new ZhiboRuntime({
  seed: true,
  autoSimulate: true,
  emit: (type, payload) => broadcast(type, payload)
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function fail(res, status, message, code = 'BAD_REQUEST') {
  sendJson(res, status, { ok: false, error: { message, code } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是有效 JSON');
  }
}

let acceptanceCache = null;
let acceptanceAt = 0;

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(path.resolve(PUBLIC_DIR))) {
    return fail(res, 403, '禁止访问');
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const ext = path.extname(target).toLowerCase();
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      'Content-Length': data.length
    });
    res.end(data);
  } catch {
    if (!path.extname(pathname)) {
      try {
        const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      } catch {
        // fall through to 404
      }
    }
    fail(res, 404, '资源不存在', 'NOT_FOUND');
  }
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      name: 'zhibo-hub',
      version: runtime.version,
      stage: runtime.session.stage,
      uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
      clients: clients.size,
      mode: 'local-deterministic'
    });
  }

  if (pathname === '/api/state') {
    return sendJson(res, 200, { ok: true, state: runtime.snapshot() });
  }

  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        ok: true,
        state: runtime.snapshot()
      })}\n\n`
    );
    clients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(keepAlive);
        clients.delete(res);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  if (method !== 'POST' && pathname !== '/api/acceptance' && !pathname.startsWith('/api/trace/')) {
    return fail(res, 405, '方法不允许', 'METHOD_NOT_ALLOWED');
  }

  if (pathname === '/api/trace/' && method === 'GET') {
    return fail(res, 400, '缺少 trace id');
  }

  if (pathname.startsWith('/api/trace/') && method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/trace/'.length));
    const trace = runtime.tracer.summary(runtime.tracer.get(id));
    if (!trace) return fail(res, 404, 'Trace 不存在', 'NOT_FOUND');
    const decisions = runtime.decisions.filter((decision) => decision.traceId === id);
    return sendJson(res, 200, { ok: true, trace, decisions });
  }

  if (pathname === '/api/acceptance' && method === 'GET') {
    const force = searchParams.get('force') === '1';
    if (!force && acceptanceCache && Date.now() - acceptanceAt < 60000) {
      return sendJson(res, 200, { ok: true, cached: true, report: acceptanceCache });
    }
    const report = await runAcceptance({ stressEvents: 800 });
    acceptanceCache = report;
    acceptanceAt = Date.now();
    return sendJson(res, 200, { ok: true, cached: false, report });
  }

  if (method !== 'POST') return fail(res, 405, '方法不允许', 'METHOD_NOT_ALLOWED');

  const body = await readBody(req);

  if (pathname === '/api/prepare') {
    const result = await runtime.prepare();
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/live/start') {
    const result = runtime.startLive();
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/live/stop') {
    const result = runtime.stopLive();
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/live/pause') {
    const result = runtime.pauseLive();
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/live/resume') {
    const result = runtime.resumeLive();
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/danmaku') {
    const result = await runtime.ingestDanmaku(body.text, {
      user: body.user,
      pool: body.pool ?? 'manual',
      simulated: Boolean(body.simulated)
    });
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/scenario') {
    const result = await runtime.runScenario(body.type);
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/review') {
    const result = await runtime.review();
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/fault') {
    const result = runtime.setAgentFault(body.agent, body.action ?? 'offline');
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/tools/hotplug') {
    const spec = runtime.hotplugTool(body);
    return sendJson(res, 200, { ok: true, spec, state: runtime.snapshot() });
  }
  if (pathname === '/api/tools/remove') {
    const removed = runtime.removeTool(body.name);
    return sendJson(res, 200, { ok: true, removed, state: runtime.snapshot() });
  }
  if (pathname === '/api/tools/call') {
    const result = await runtime.callTool(body.name, body.args ?? {}, {
      traceId: body.traceId ?? null
    });
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/stress') {
    const result = await runtime.stressTest(body.events ?? 800);
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/chat') {
    const result = await runtime.chat(body.message);
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }
  if (pathname === '/api/reset') {
    const result = runtime.resetSession();
    acceptanceCache = null;
    return sendJson(res, 200, { ok: true, result, state: runtime.snapshot() });
  }

  return fail(res, 404, '接口不存在', 'NOT_FOUND');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error.code === 'APPROVAL_REQUIRED' ? 403 : 400;
    fail(res, status, error.message, error.code ?? 'BAD_REQUEST');
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  智播中枢 · ZHIBO NEXUS');
  console.log(`  API + 控制台  http://${HOST}:${PORT}`);
  console.log('  本地确定性内核 · 零外部依赖 · 演示数据');
  console.log('');
});

function shutdown() {
  broadcast('system.shutdown', { at: Date.now() });
  for (const res of clients) {
    try {
      res.end();
    } catch {
      // closing
    }
  }
  clients.clear();
  runtime.stopTicker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
