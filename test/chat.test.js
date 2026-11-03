import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { parseList } from '../src/batch.js';
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
    if (payload.to === '5511900000422') return { status: 422, body: { error: { code: 'INVALID', message: 'to' } } };
    if (payload.to === '5511900000429') return { status: 429, body: { error: { code: 'QUEUE_FULL', message: 'cheia' } } };
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
  async checkNumbers(numbers) {
    if (numbers.length > 50) return { status: 422, body: { error: { code: 'TOO_MANY', message: 'numbers' } } };
    return {
      status: 200,
      body: { results: numbers.map((number) => ({ number, exists: number !== '5511900000000' })) },
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

const postJson = (url, body) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sendBatch = (numbers, text = 'oi') =>
  postJson('/api/batches', { recipients: numbers.map((n) => (typeof n === 'string' ? { number: n } : n)), text });

test('lista do lote separa inválidos, repetidos e nome', () => {
  const { recipients, invalid, duplicates } = parseList(
    '+55 11 99999-9999;Maria\n\n123\n551199999999\n5521988887777,João Silva\r\n',
  );
  assert.deepEqual(recipients, [
    { number: '5511999999999', name: 'Maria' },
    { number: '5521988887777', name: 'João Silva' },
  ]);
  assert.deepEqual(invalid, ['123']);
  assert.deepEqual(duplicates, ['551199999999']);
});

test('verificação do lote marca quem não tem WhatsApp', async () => {
  const res = await postJson('/api/batches/check', { list: '5511999999999\n5511900000000' });
  const { recipients } = await res.json();
  assert.deepEqual(recipients.map((r) => r.exists), [true, false]);
  assert.equal(gateway.calls.length, 0);
});

test('lote acima do teto é recusado sem enviar nada', async () => {
  const numbers = Array.from({ length: 81 }, (_, i) => String(5511900001000 + i));
  const res = await sendBatch(numbers);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'BATCH_TOO_LARGE');
  assert.equal(gateway.calls.length, 0);
});

test('lote de 80 passa pelo teto de 50 da verificação e é enviado', async () => {
  const numbers = Array.from({ length: 80 }, (_, i) => String(5511900001000 + i));
  const check = await postJson('/api/batches/check', { list: numbers.join('\n') });
  assert.equal(check.status, 200);
  const { recipients } = await check.json();
  assert.equal(recipients.filter((r) => r.exists).length, 80);
  const body = await (await sendBatch(numbers)).json();
  assert.equal(body.accepted, 80);
});

test('lote troca {nome} e cada envio leva chave própria', async () => {
  const res = await sendBatch(
    [
      { number: '5511999999999', name: 'Maria' },
      { number: '5521988887777', name: 'João' },
    ],
    'Olá, {nome}!',
  );
  const body = await res.json();
  assert.equal(body.accepted, 2);
  assert.deepEqual(gateway.calls.map((c) => c.text), ['Olá, Maria!', 'Olá, João!']);
  assert.notEqual(gateway.calls[0].idempotencyKey, gateway.calls[1].idempotencyKey);
  assert.equal(store.batches()[0].total, 2);
  assert.equal(store.messagesOfBatch(body.batchId).length, 2);
});

test('{nome} sem nome na lista recusa o lote antes do primeiro envio', async () => {
  const res = await sendBatch([{ number: '5511999999999', name: 'Maria' }, { number: '5521988887777' }], 'Olá, {nome}!');
  assert.equal(res.status, 422);
  assert.equal(gateway.calls.length, 0);
});

test('recusa de um número não para o lote', async () => {
  const body = await (await sendBatch(['5511900000422', '5511999999999'])).json();
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected[0].number, '5511900000422');
  assert.equal(body.skipped.length, 0);
});

test('fila cheia para o lote e o resto não é enviado', async () => {
  const body = await (await sendBatch(['5511999999999', '5511900000429', '5521988887777'])).json();
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected[0].error.code, 'QUEUE_FULL');
  assert.deepEqual(body.skipped.map((s) => s.number), ['5521988887777']);
  assert.equal(gateway.calls.length, 2);
});

test('status do webhook aparece no resumo do lote', async () => {
  const { batchId } = await (await sendBatch(['5511999999999'])).json();
  const [m] = store.messagesOfBatch(batchId);
  await deliver(statusEvent(m.id, 'delivered'));
  const res = await fetch(`${base}/api/batches`);
  const { batches } = await res.json();
  assert.deepEqual(batches[0].counts, { delivered: 1 });
});

test('txt conta por dia só o que saiu, sem somar evento repetido', async () => {
  const day = (d) => new Date(2026, 9, d, 12).toISOString();
  const a = await (await sendText()).json();
  const b = await (await sendText()).json();
  const failed = await (await sendText()).json();
  await sendText();
  const sent = statusEvent(a.id, 'sent', { at: day(29) });
  await deliver(sent);
  await deliver(sent);
  await deliver(statusEvent(a.id, 'delivered', { at: day(30) }));
  await deliver(statusEvent(b.id, 'delivered', { at: day(30) }));
  await deliver(statusEvent(failed.id, 'failed', { failureReason: 'UNCONFIRMED', at: day(30) }));
  store.flush();
  assert.equal(fs.readFileSync(store.sentFile, 'utf8'), '2026-10-29 1\n2026-10-30 1\n');
});

test('rotas não saem de public/', async () => {
  const res = await fetch(`${base}/..%2F.env`);
  assert.equal(res.status, 404);
});
