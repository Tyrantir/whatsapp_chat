import { conversationKey, normalizePhone } from './phone.js';

// Envio em lote: uma mensagem por destinatário, cada uma com a própria chave de idempotência. Quem espaça os envios
// é o gateway (15 a 30 s por número); aqui só entra o pedido.

export const MAX_BATCH = 80; // Número em aquecimento faz 30 por dia.
export const CHECK_CHUNK = 50; // Teto de `numbers/check` no gateway.

/// Entrada: uma linha por destinatário, `5511999999999` ou `5511999999999;Maria`. Vírgula e tab também separam.
export function parseList(raw) {
  const recipients = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const [first, ...rest] = entry.split(/[;,\t]/);
    const number = normalizePhone(first);
    if (!number) {
      invalid.push(entry);
    } else if (seen.has(conversationKey(number))) {
      duplicates.push(number);
    } else {
      seen.add(conversationKey(number));
      recipients.push({ number, name: rest.join(' ').trim() || null });
    }
  }
  return { recipients, invalid, duplicates };
}

/// Destinatários já revisados na tela. Refaz a validação: o corpo vem do navegador.
export function cleanRecipients(list) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const number = normalizePhone(r?.number);
    if (!number || seen.has(conversationKey(number))) continue;
    seen.add(conversationKey(number));
    out.push({ number, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null });
  }
  return out;
}

export const usesName = (text) => /\{nome\}/i.test(text ?? '');

export const renderText = (text, name) => (text ? text.replace(/\{nome\}/gi, () => name ?? '') : text);

/// 429 e falha do gateway ou da credencial valem para todos os que faltam: insistir só repete o erro.
export const stopsBatch = (status) => status === 401 || status === 403 || status === 429 || status >= 500;
