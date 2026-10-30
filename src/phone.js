// O envio pode sair com o nono dígito e a resposta voltar sem ele (o gateway usa o `jid` real). A chave da
// conversa ignora esse dígito para as duas pontas caírem no mesmo chat.

export function normalizePhone(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/[\s()-]/g, '')
    .replace(/^\+/, '');
  return /^[1-9]\d{9,14}$/.test(s) ? s : null;
}

export function conversationKey(number) {
  const m = /^55(\d{2})9(\d{8})$/.exec(number);
  return m ? `55${m[1]}${m[2]}` : number;
}

export function lidKey(lid) {
  return `lid:${lid}`;
}
