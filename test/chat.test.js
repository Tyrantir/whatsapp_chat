import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { conversationKey } from '../src/phone.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const SECRET = 'segredo-de-teste';
const sign = (body) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;

const gateway = {
  calls: [],
  async send(payload) {
    this.calls.push(payload);
    if (payload.to === 'invalido') return { status: 422, body: { error: { code: 'INVALID', message: 'to' } } };
    return {
      status: 202,
      body: {
        messageId: crypto.randomUUID(),
        idempotencyKey: payload.idempotencyKey,
        to: payload.to,
        status: 'queued',
        createdAt: new Date().toISOString(),
      },
    };
  },
};

let dir;
let store;
let server;
let base;
let port;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  port = 0;
  const config = { port: 0, webhookSecret: SECRET, bearer: 'b', cedenteRef: 'c', tenantRef: 't' };
  store = new Store(dir);
  server = createServer({
    config,
    store,
    gateway,
    downloadMedia: async () => undefined,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  config.port = port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  store.flush();
  server.close();
  server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  store.state = { messages: [], events: [], seenEvents: [] };
  gateway.calls = [];
});

function deliver(event, signature) {
  const body = JSON.stringify(event);
  return fetch(`${base}/webhooks/gateway`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auvix-signature': signature ?? sign(body) },
    body,
  });
}

const statusEvent = (messageId, status, extra = {}) => ({
  eventId: crypto.randomUUID(),
  type: 'message.status',
  messageId,
  status,
  at: new Date().toISOString(),
  ...extra,
});

const sendText = (to = '5511999999999') =>
  fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, text: 'oi' }),
  });

test('webhook com assinatura errada é recusado e não altera nada', async () => {
  const res = await deliver(statusEvent('x', 'sent'), 'sha256=00');
  assert.equal(res.status, 401);
  assert.equal(store.state.messages.length, 0);
  assert.equal(store.state.events[0].rejected, true);
});

test('evento repetido é aplicado uma vez só', async () => {
  const ev = {
    eventId: crypto.randomUUID(),
    type: 'message.inbound',
    from: '5511988887777',
    fromLid: null,
    providerMessageId: 'A1',
    text: 'olá',
    media: null,
    timestamp: new Date().toISOString(),
  };
  await deliver(ev);
  await deliver(ev);
  assert.equal(store.state.messages.length, 1);
  assert.equal(store.state.events[0].duplicate, true);
});

test('status fora de ordem não regride', async () => {
  const { messageId } = await (await sendText()).json().then((m) => ({ messageId: m.id }));
  await deliver(statusEvent(messageId, 'delivered'));
  await deliver(statusEvent(messageId, 'sent'));
  assert.equal(store.find(messageId).status, 'delivered');
});

test('UNCONFIRMED sobe para sent quando o ACK chega depois', async () => {
  const m = await (await sendText()).json();
  await deliver(statusEvent(m.id, 'failed', { failureReason: 'UNCONFIRMED' }));
  assert.equal(store.find(m.id).failureReason, 'UNCONFIRMED');
  await deliver(statusEvent(m.id, 'sent'));
  assert.equal(store.find(m.id).status, 'sent');
  assert.equal(store.find(m.id).failureReason, null);
});

test('webhook antes do 202 não perde a mensagem', () => {
  const id = crypto.randomUUID();
  store.applyStatus(statusEvent(id, 'sent'));
  store.addOutbound({
    view: { messageId: id, to: '5511999999999', status: 'queued', createdAt: new Date().toISOString() },
    text: 'oi',
  });
  const m = store.find(id);
  assert.equal(m.status, 'sent');
  assert.equal(m.key, conversationKey('5511999999999'));
});

test('resposta sem o nono dígito cai na mesma conversa do envio', async () => {
  await sendText('5511999998888');
  await deliver({
    eventId: crypto.randomUUID(),
    type: 'message.inbound',
    from: '551199998888',
    providerMessageId: 'A2',
    text: 'resposta',
    media: null,
    timestamp: new Date().toISOString(),
  });
  const conversations = store.conversations();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].number, '551199998888');
});

test('contato só com @lid vira conversa própria, sem inventar número', async () => {
  await deliver({
    eventId: crypto.randomUUID(),
    type: 'message.inbound',
    from: null,
    fromLid: '179456652108024@lid',
    providerMessageId: 'A3',
    text: 'oi',
    media: null,
    timestamp: new Date().toISOString(),
  });
  const [c] = store.conversations();
  assert.equal(c.number, null);
  assert.equal(c.key, 'lid:179456652108024@lid');
});

test('recusa do gateway chega à tela e nada é gravado', async () => {
  const res = await sendText('invalido');
  assert.equal(res.status, 422);
  assert.equal(store.state.messages.length, 0);
});

test('cada envio leva chave de idempotência própria e o cedente do cadastro', async () => {
  await sendText();
  await sendText();
  const [a, b] = gateway.calls;
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.equal(a.cedenteRef, 'c');
});

test('API recusa outra origem e outro Host', async () => {
  const foreign = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://site-qualquer.example' },
    body: '{}',
  });
  assert.equal(foreign.status, 403);

  const status = await new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      })
      .end();
  });
  assert.equal(status, 403);
});

test('anexo recebido de tipo perigoso é servido como download', async () => {
  fs.writeFileSync(path.join(store.mediaDir, 'abc.bin'), '<script>alert(1)</script>');
  store.state.messages.push({ id: 'm', key: 'k', media: { file: 'abc.bin', mimeType: 'text/html' } });
  const res = await fetch(`${base}/media/abc.bin`);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment/);
  assert.equal(res.headers.get('content-security-policy'), 'sandbox');
});

test('rotas não saem de public/', async () => {
  const res = await fetch(`${base}/..%2F.env`);
  assert.equal(res.status, 404);
});
