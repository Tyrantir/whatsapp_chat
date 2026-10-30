import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, configFrom, loadEnvFile } from './config.js';
import { GatewayClient } from './gateway.js';
import { normalizePhone } from './phone.js';
import { Store } from './store.js';
import { applyEvent, downloadInboundMedia, mediaFileName, verifySignature } from './webhook.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
// Limite de JSON do gateway é 20 MB; o corpo daqui leva o mesmo base64 com pouca folga.
const API_BODY_LIMIT = 21 * 1024 * 1024;
const WEBHOOK_BODY_LIMIT = 1024 * 1024;
// O navegador só abre direto o que não executa nada. O resto (HTML e SVG vindos do contato) é download.
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/mp4|audio\/(ogg|mpeg|mp4)|application\/pdf)$/;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function apiError(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

class BodyTooLarge extends Error {}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) return null;
  try {
    return JSON.parse((await readBody(req, API_BODY_LIMIT)).toString('utf8'));
  } catch (err) {
    if (err instanceof BodyTooLarge) throw err;
    return null;
  }
}

/// Bloqueia chamada vinda de outro site (CSRF) e DNS rebinding: quem abre esta tela envia WhatsApp de verdade.
function isLocalRequest(req, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || allowed.some((h) => origin === `http://${h}`);
}

export function createServer({ config, store, gateway, downloadMedia = downloadInboundMedia }) {
  const clients = new Set();

  const broadcast = (notice) => {
    const line = `data: ${JSON.stringify(notice)}\n\n`;
    for (const c of clients) c.write(line);
  };

  async function handleWebhook(req, res) {
    let raw;
    try {
      raw = await readBody(req, WEBHOOK_BODY_LIMIT);
    } catch {
      return apiError(res, 413, 'TOO_LARGE', 'Corpo acima do limite');
    }
    if (!verifySignature(config.webhookSecret, raw, req.headers['x-auvix-signature'])) {
      store.addEvent({ receivedAt: new Date().toISOString(), rejected: true, type: req.headers['x-auvix-event'] ?? null });
      broadcast({ type: 'event' });
      return apiError(res, 401, 'INVALID_SIGNATURE', 'Assinatura inválida');
    }
    let ev;
    try {
      ev = JSON.parse(raw.toString('utf8'));
    } catch {
      return apiError(res, 400, 'INVALID_JSON', 'Corpo não é JSON');
    }
    const first = store.markEvent(ev.eventId);
    store.addEvent({ receivedAt: new Date().toISOString(), duplicate: !first, type: ev.type, payload: ev });
    json(res, 200, { ok: true });
    broadcast({ type: 'event' });
    if (!first) return;
    const notices = applyEvent(store, ev, {
      onInboundMedia: (m) => {
        downloadMedia(store, m).then(() => broadcast({ type: 'message', key: m.key, id: m.id }));
      },
    });
    notices.forEach(broadcast);
  }

  async function sendMessage(req, res) {
    const body = await readJson(req);
    if (!body) return apiError(res, 400, 'INVALID_JSON', 'Corpo JSON obrigatório');
    const payload = {
      idempotencyKey: `chat-${crypto.randomUUID()}`,
      cedenteRef: config.cedenteRef,
      to: body.to,
      text: body.text || undefined,
      media: body.media || undefined,
    };
    const r = await gateway.send(payload);
    if (r.status !== 202) return json(res, r.status, r.body);

    let media = null;
    if (body.media) {
      const { type, fileName, mimeType, base64, ptt } = body.media;
      const file = mediaFileName(r.body.messageId, mimeType);
      fs.writeFileSync(path.join(store.mediaDir, file), Buffer.from(base64, 'base64'));
      media = { kind: type, fileName: fileName ?? null, mimeType, file, ptt: Boolean(ptt) };
    }
    const m = store.addOutbound({ view: r.body, text: body.text, media });
    broadcast({ type: 'message', key: m.key, id: m.id });
    json(res, 202, m);
  }

  async function checkNumber(req, res) {
    const body = await readJson(req);
    const number = normalizePhone(body?.number);
    if (!number) return apiError(res, 422, 'INVALID_NUMBER', 'Use DDI + DDD + número, só dígitos. Ex.: 5511999999999');
    const r = await gateway.checkNumber(number);
    json(res, r.status, r.body);
  }

  async function refreshMessage(res, id) {
    const r = await gateway.getMessage(id);
    if (r.status !== 200) return json(res, r.status, r.body);
    const m = store.applyStatus(r.body) ?? store.find(id);
    if (m?.key) broadcast({ type: 'message', key: m.key, id: m.id });
    json(res, 200, m);
  }

  function serveMedia(res, name) {
    if (!/^[\w-]+\.\w+$/.test(name)) return apiError(res, 404, 'NOT_FOUND', 'Arquivo não encontrado');
    const file = path.join(store.mediaDir, name);
    if (!fs.existsSync(file)) return apiError(res, 404, 'NOT_FOUND', 'Arquivo não encontrado');
    const owner = store.state.messages.find((m) => m.media?.file === name);
    const type = String(owner?.media?.mimeType ?? 'application/octet-stream').split(';')[0].trim();
    const inline = INLINE_TYPES.test(type);
    res.writeHead(200, {
      'content-type': inline ? type : 'application/octet-stream',
      'content-disposition': inline ? 'inline' : `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
    fs.createReadStream(file).pipe(res);
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const type = STATIC_TYPES[path.extname(rel)];
    if (!/^[\w.-]+$/.test(rel) || !type) return apiError(res, 404, 'NOT_FOUND', 'Rota não encontrada');
    const file = path.join(PUBLIC_DIR, rel);
    if (!fs.existsSync(file)) return apiError(res, 404, 'NOT_FOUND', 'Rota não encontrada');
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': conectado\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://local');
    const { method } = req;

    // Único ponto aberto ao container do gateway: a autenticação é a assinatura.
    if (method === 'POST' && pathname === '/webhooks/gateway') return handleWebhook(req, res);
    if (!isLocalRequest(req, config.port)) return apiError(res, 403, 'FORBIDDEN', 'Só acessível por localhost');

    if (method === 'GET' && pathname === '/api/state') {
      return json(res, 200, {
        configured: Boolean(config.bearer && config.webhookSecret),
        tenantRef: config.tenantRef,
        cedenteRef: config.cedenteRef,
        gatewayUrl: config.gatewayUrl,
        conversations: store.conversations(),
        events: store.state.events,
      });
    }
    if (method === 'GET' && pathname === '/api/stream') return openStream(req, res);
    if (method === 'GET' && pathname === '/api/pool') {
      const [health, status] = await Promise.all([gateway.health(), gateway.status()]);
      return json(res, 200, { health: health.body, healthStatus: health.status, pool: status.body, poolStatus: status.status });
    }
    if (method === 'POST' && pathname === '/api/messages') return sendMessage(req, res);
    if (method === 'POST' && pathname === '/api/numbers/check') return checkNumber(req, res);

    let m = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (method === 'GET' && m) return json(res, 200, { messages: store.messagesOf(decodeURIComponent(m[1])) });

    m = /^\/api\/messages\/([^/]+)\/refresh$/.exec(pathname);
    if (method === 'POST' && m) return refreshMessage(res, decodeURIComponent(m[1]));

    m = /^\/media\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && m) return serveMedia(res, decodeURIComponent(m[1]));

    if (method === 'GET') return serveStatic(res, pathname);
    apiError(res, 404, 'NOT_FOUND', 'Rota não encontrada');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof BodyTooLarge) return apiError(res, 413, 'TOO_LARGE', 'Arquivo grande demais para o gateway');
      console.error(err);
      apiError(res, 500, 'INTERNAL', err.message);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadEnvFile();
  const config = configFrom();
  const store = new Store(config.dataDir);
  const server = createServer({ config, store, gateway: new GatewayClient(config) });
  server.listen(config.port, config.host, () => {
    console.log(`Chat em http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`);
    if (!config.bearer) console.log('Sem credenciais do gateway: rode `npm run setup`.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      store.flush();
      process.exit(0);
    });
  }
}
