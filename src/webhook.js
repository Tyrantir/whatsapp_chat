import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Recebe os eventos do gateway (GATEWAY.md § 5). A assinatura é conferida no corpo cru, antes do parse.

export function verifySignature(secret, rawBody, header) {
  if (!secret || typeof header !== 'string') return false;
  const expected = Buffer.from(
    `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  );
  const received = Buffer.from(header);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/// Aplica o evento e devolve os avisos a mandar para a tela.
export function applyEvent(store, ev, { onInboundMedia } = {}) {
  const notices = [];
  if (ev.type === 'message.status') {
    const m = store.applyStatus(ev);
    if (m) notices.push({ type: 'message', key: m.key ?? null, id: m.id });
  } else if (ev.type === 'message.inbound') {
    const m = store.addInbound(ev);
    if (m) {
      notices.push({ type: 'message', key: m.key, id: m.id });
      if (m.media?.url) onInboundMedia?.(m);
    }
  } else if (ev.type === 'pool.state') {
    notices.push({ type: 'pool' });
  }
  return notices;
}

const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

export function mediaFileName(id, mimeType) {
  const base = String(mimeType ?? '').split(';')[0].trim();
  return `${id}${EXTENSIONS[base] ?? '.bin'}`;
}

/// A URL do gateway é temporária: o consumidor baixa e guarda (GATEWAY.md § 5).
export async function downloadInboundMedia(store, m) {
  const media = m.media;
  try {
    const res = await fetch(media.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const file = mediaFileName(m.id, media.mimeType);
    fs.writeFileSync(path.join(store.mediaDir, file), Buffer.from(await res.arrayBuffer()));
    m.media = { ...media, url: null, file };
  } catch (err) {
    m.media = { ...media, url: null, error: `Download falhou: ${err.message}` };
  }
  store.save();
}
