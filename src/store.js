import fs from 'node:fs';
import path from 'node:path';
import { conversationKey, lidKey } from './phone.js';

// Histórico é do consumidor (GATEWAY.md § 3): aqui ele fica num JSON em `data/`. Basta para um teste local.

const MAX_EVENTS = 200;
const MAX_SEEN = 5000;

// O webhook não garante ordem. `failed` fica abaixo de `sent` porque um UNCONFIRMED pode subir com ACK tardio.
const RANK = { queued: 0, failed: 1, sent: 2, delivered: 3, read: 4 };

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'chat.json');
    this.mediaDir = path.join(dataDir, 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.state = { messages: [], events: [], seenEvents: [] };
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.timer = null;
  }

  save() {
    this.timer ??= setTimeout(() => this.flush(), 100);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  /// true na primeira vez que o evento aparece. A entrega é "pelo menos uma vez".
  markEvent(eventId) {
    if (this.state.seenEvents.includes(eventId)) return false;
    this.state.seenEvents.push(eventId);
    if (this.state.seenEvents.length > MAX_SEEN) this.state.seenEvents.shift();
    return true;
  }

  addEvent(event) {
    this.state.events.unshift(event);
    this.state.events.length = Math.min(this.state.events.length, MAX_EVENTS);
    this.save();
  }

  find(id) {
    return this.state.messages.find((m) => m.id === id);
  }

  /// Cria o registro da mensagem aceita. O webhook pode ter chegado antes do 202: nesse caso completa o que existe.
  addOutbound({ view, text, media }) {
    let m = this.find(view.messageId);
    if (!m) {
      m = { id: view.messageId, status: 'queued', times: {} };
      this.state.messages.push(m);
    }
    Object.assign(m, {
      direction: 'out',
      key: conversationKey(view.to),
      number: view.to,
      text: text ?? null,
      media: media ?? null,
      idempotencyKey: view.idempotencyKey,
      createdAt: view.createdAt,
    });
    this.applyStatus(view);
    return m;
  }

  /// Aplica status de webhook ou de `GET /messages/{id}`. Devolve a mensagem se algo mudou, senão null.
  applyStatus(s) {
    const id = s.messageId;
    let m = this.find(id);
    if (!m) {
      m = { id, status: 'queued', times: {} };
      this.state.messages.push(m);
    }
    const cur = RANK[m.status];
    const next = RANK[s.status];
    if (next === undefined || next < cur) return null;
    const at = s.at ?? null;
    if (next === cur && at && m.lastAt && at < m.lastAt) return null;

    Object.assign(m, {
      status: s.status,
      holdReason: s.holdReason ?? null,
      notBefore: s.notBefore ?? null,
      failureReason: s.failureReason ?? null,
      via: s.via ?? m.via ?? null,
      fromNumber: s.fromNumber ?? m.fromNumber ?? null,
      lastAt: at ?? m.lastAt ?? null,
    });
    m.idempotencyKey ??= s.idempotencyKey;

    const times = {
      queued: s.createdAt,
      sent: s.sentAt,
      delivered: s.deliveredAt,
      read: s.readAt,
      failed: s.failedAt,
    };
    for (const [k, v] of Object.entries(times)) if (v) m.times[k] = v;
    if (at) m.times[s.status] ??= at;
    this.save();
    return m;
  }

  /// Registra mensagem recebida. Devolve null se o reprocessamento do gateway repetiu o mesmo id.
  addInbound(ev) {
    if (this.state.messages.some((m) => m.providerMessageId === ev.providerMessageId)) return null;
    const m = {
      id: ev.eventId,
      direction: 'in',
      providerMessageId: ev.providerMessageId,
      key: ev.from ? conversationKey(ev.from) : lidKey(ev.fromLid),
      number: ev.from ?? null,
      lid: ev.fromLid ?? null,
      text: ev.text ?? null,
      media: ev.media ?? null,
      replyToMessageId: ev.replyToMessageId ?? null,
      via: ev.via ?? null,
      createdAt: ev.timestamp,
    };
    this.state.messages.push(m);
    this.save();
    return m;
  }

  conversations() {
    const byKey = new Map();
    for (const m of this.state.messages) {
      if (!m.key) continue;
      const c = byKey.get(m.key);
      const newer = !c || m.createdAt >= c.lastAt;
      byKey.set(m.key, {
        key: m.key,
        number: (m.direction === 'in' ? m.number : null) ?? c?.number ?? m.number ?? null,
        lid: m.lid ?? c?.lid ?? null,
        lastAt: newer ? m.createdAt : c.lastAt,
        lastText: newer ? preview(m) : c.lastText,
        lastDirection: newer ? m.direction : c.lastDirection,
      });
    }
    return [...byKey.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  }

  messagesOf(key) {
    return this.state.messages
      .filter((m) => m.key === key)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}

function preview(m) {
  if (m.text) return m.text;
  if (m.media) return m.media.fileName || `[${m.media.kind ?? 'mídia'}]`;
  return '';
}
