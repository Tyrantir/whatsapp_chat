const STOPS = [
  ['queued', 'Fila'],
  ['sent', 'Enviada'],
  ['delivered', 'Entregue'],
  ['read', 'Lida'],
];
const HOLD_LABELS = {
  DAILY_LIMIT: 'Retida: número atingiu o limite do dia',
  OUTSIDE_WINDOW: 'Retida: fora da janela de envio',
  CHANNEL_DOWN: 'Retida: nenhum número disponível no pool',
  PAUSED: 'Retida: envio pausado',
};
const FAILURE_LABELS = {
  NUMBER_NOT_ON_WHATSAPP: 'Falhou: número sem WhatsApp',
  INVALID_REQUEST: 'Falhou: a Evolution recusou o pedido',
  TEMPLATE_REQUIRED: 'Falhou: fora da janela de 24 h e sem template',
  TEMPLATE_MISMATCH: 'Falhou: template não confere',
  PROVIDER_ERROR: 'Falhou: erro da Evolution depois de todas as tentativas',
  UNCONFIRMED: 'Sem confirmação: pode ter saído. O gateway não reenvia',
  CHANNEL_DOWN: 'Falhou: canal fora do ar',
  EXPIRED: 'Falhou: validade esgotada antes do envio',
  CANCELLED: 'Falhou: cancelada',
};
const BIG_FILE_BYTES = 14 * 1024 * 1024; // Base64 precisa caber nos 20 MB de JSON do gateway.

const $ = (id) => document.getElementById(id);

const state = {
  conversations: [],
  events: [],
  active: null, // { key, number, lid }
  messages: [],
  selectedId: null,
  file: null,
  sending: false,
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  el.append(...children.filter((c) => c !== null && c !== undefined));
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function errorText(r) {
  const e = r.body?.error;
  if (!e) return `Erro HTTP ${r.status}`;
  const issues = e.issues ?? e.details;
  const lines = Array.isArray(issues) ? issues.map((i) => `${i.path}: ${i.message}`) : [];
  return [`${e.code ?? r.status}: ${e.message}`, ...lines].join('\n');
}

const clock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

function elapsed(from, to) {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000));
  if (s < 60) return `+${s}s`;
  if (s < 3600) return `+${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
  return `+${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function setView(view) {
  $('shell').dataset.view = view;
}

// ── Conversas ───────────────────────────────────────────────────────────────

function renderConversations() {
  const list = $('conversations');
  if (!state.conversations.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'Digite um número acima para abrir a primeira conversa.'));
    return;
  }
  list.replaceChildren(
    ...state.conversations.map((c) =>
      h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'conversation',
            'aria-current': c.key === state.active?.key ? 'true' : 'false',
            onclick: () => openConversation(c),
          },
          h('strong', {}, c.number ?? c.key),
          h('span', {}, `${c.lastDirection === 'out' ? 'Você: ' : ''}${c.lastText}`),
        ),
      ),
    ),
  );
}

async function openConversation(c) {
  state.active = c;
  state.selectedId = null;
  $('chat-title').textContent = c.number ?? 'Contato sem número';
  $('chat-sub').textContent = c.number ? '' : (c.lid ?? '');
  $('composer').hidden = false;
  setView('chat');
  renderConversations();
  renderSelected();
  await loadMessages();
  $('text').focus();
}

function conversationKey(number) {
  const m = /^55(\d{2})9(\d{8})$/.exec(number);
  return m ? `55${m[1]}${m[2]}` : number;
}

const typedNumber = () => $('new-number').value.replace(/[\s()+-]/g, '');

$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const number = typedNumber();
  if (!/^[1-9]\d{9,14}$/.test(number)) {
    showCheck('Use DDI + DDD + número, só dígitos. Ex.: 5511999999999', 'bad');
    return;
  }
  const key = conversationKey(number);
  openConversation(state.conversations.find((c) => c.key === key) ?? { key, number, lid: null });
  $('new-number').value = '';
  showCheck('');
});

function showCheck(text, kind = '') {
  const el = $('check-result');
  el.textContent = text;
  el.className = `hint ${kind}`;
}

$('check').addEventListener('click', async () => {
  showCheck('Verificando…');
  const r = await post('/api/numbers/check', { number: typedNumber() });
  if (!r.ok) return showCheck(errorText(r), 'bad');
  const result = r.body.results?.[0];
  if (result?.exists === true) showCheck(`Tem WhatsApp: ${result.jid}`, 'ok');
  else if (result?.exists === false) showCheck('Sem WhatsApp neste número.', 'bad');
  else showCheck('A Evolution não respondeu. Tente de novo.', 'bad');
});

// ── Mensagens ───────────────────────────────────────────────────────────────

async function loadMessages() {
  if (!state.active) return;
  const key = state.active.key;
  const r = await api(`/api/conversations/${encodeURIComponent(key)}/messages`);
  if (key !== state.active?.key) return;
  state.messages = r.body?.messages ?? [];
  renderMessages();
  renderSelected();
}

function renderMedia(m) {
  const media = m.media;
  if (!media) return null;
  if (media.error) return h('div', { class: 'media-frame' }, h('p', { class: 'media-error' }, media.error));
  if (!media.file) return h('div', { class: 'media-frame' }, 'Baixando anexo…');
  const src = `/media/${encodeURIComponent(media.file)}`;
  const kind = media.kind;
  const type = String(media.mimeType ?? '').split(';')[0];
  let content;
  if (kind === 'image' && /^image\/(jpeg|png|webp|gif)$/.test(type)) content = h('img', { src, alt: media.fileName ?? 'Imagem' });
  else if (kind === 'video') content = h('video', { src, controls: '' });
  else if (kind === 'audio') content = h('audio', { src, controls: '' });
  else content = h('a', { href: src, target: '_blank', rel: 'noopener' }, media.fileName ?? 'Abrir anexo');
  return h('div', { class: 'media-frame' }, content);
}

function renderRail(m) {
  if (m.status === 'failed') return renderStop(m);
  const reached = STOPS.findIndex(([s]) => s === m.status);
  let previous = null;
  const items = STOPS.map(([status, label], i) => {
    const at = m.times?.[status];
    const gap = i > 0 && i <= reached ? elapsed(previous, at) : '';
    previous = at ?? previous;
    return h(
      'li',
      { class: `${i <= reached ? 'done' : ''} ${i === reached ? 'at' : ''}` },
      label,
      h('small', {}, gap),
    );
  });
  return [h('ol', { class: 'rail', 'aria-label': `Status: ${STOPS[reached]?.[1]}` }, ...items), renderStop(m)];
}

function renderStop(m) {
  if (m.status === 'failed') {
    return h('p', { class: 'stop failed' }, FAILURE_LABELS[m.failureReason] ?? `Falhou: ${m.failureReason}`);
  }
  if (m.holdReason) {
    const until = m.notBefore ? ` até ${clock(m.notBefore)}` : '';
    return h('p', { class: 'stop hold' }, `${HOLD_LABELS[m.holdReason] ?? m.holdReason}${until}`);
  }
  return null;
}

function renderMessages() {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!state.messages.length) {
    box.replaceChildren(h('p', { class: 'placeholder' }, 'Sem mensagens ainda. Escreva abaixo para enviar pelo gateway.'));
    return;
  }
  box.replaceChildren(
    ...state.messages.map((m) =>
      h(
        'button',
        {
          type: 'button',
          class: `message ${m.direction}`,
          'aria-pressed': m.id === state.selectedId ? 'true' : 'false',
          onclick: () => selectMessage(m.id),
        },
        renderMedia(m),
        m.text ? h('div', { class: 'body' }, m.text) : null,
        h('time', { class: 'time', datetime: m.createdAt }, clock(m.createdAt)),
        ...(m.direction === 'out' ? [renderRail(m)].flat() : []),
      ),
    ),
  );
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function selectMessage(id) {
  state.selectedId = state.selectedId === id ? null : id;
  renderMessages();
  renderSelected();
}

function facts(rows) {
  return h(
    'dl',
    { class: 'facts' },
    ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]),
  );
}

function renderSelected() {
  const m = state.messages.find((x) => x.id === state.selectedId);
  $('selected-section').hidden = !m;
  if (!m) return;
  const rows = [
    ['Id', m.id],
    ['Status', m.status],
    ['Chave', m.idempotencyKey],
    ['Via', m.via],
    ['Saiu por', m.fromNumber],
    ['Número', m.number],
    ['@lid', m.lid],
    ['Resposta a', m.replyToMessageId],
    ['Retenção', m.holdReason],
    ['Falha', m.failureReason],
  ];
  const children = [facts(rows)];
  if (m.direction === 'out') {
    children.push(
      h('button', { type: 'button', class: 'btn', onclick: () => refreshMessage(m.id) }, 'Consultar no gateway'),
      h('p', { class: 'hint', id: 'refresh-result', role: 'status' }),
    );
  }
  $('selected').replaceChildren(...children);
}

async function refreshMessage(id) {
  const r = await post(`/api/messages/${encodeURIComponent(id)}/refresh`);
  await loadMessages();
  const el = $('refresh-result');
  if (el) {
    el.textContent = r.ok ? `Consultado às ${clock(new Date().toISOString())}` : errorText(r);
    el.className = `hint ${r.ok ? '' : 'bad'}`;
  }
}

// ── Envio ───────────────────────────────────────────────────────────────────

function mediaType(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

function renderAttachment() {
  const box = $('attachment');
  const f = state.file;
  box.hidden = !f;
  if (!f) return box.replaceChildren();
  const pttLabel =
    mediaType(f) === 'audio'
      ? h('label', {}, h('input', { type: 'checkbox', id: 'ptt' }), ' Enviar como mensagem de voz')
      : null;
  box.replaceChildren(
    h('strong', {}, f.name),
    pttLabel,
    h('button', { type: 'button', class: 'link', onclick: clearFile }, 'Remover anexo'),
  );
}

function clearFile() {
  state.file = null;
  $('file').value = '';
  renderAttachment();
}

function showSendError(text) {
  const el = $('send-error');
  el.textContent = text ?? '';
  el.hidden = !text;
}

$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > BIG_FILE_BYTES) {
    showSendError('Arquivo acima de 14 MB: em base64 ele passa do limite de 20 MB do gateway.');
    return clearFile();
  }
  showSendError(null);
  state.file = file;
  renderAttachment();
});

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function send() {
  const number = state.active?.number;
  if (state.sending || !number) return;
  const text = $('text').value.trim();
  const file = state.file;
  if (!text && !file) return;
  state.sending = true;
  $('send').disabled = true;
  showSendError(null);
  try {
    const body = { to: number, text: text || undefined };
    if (file) {
      const type = mediaType(file);
      body.media = {
        type,
        base64: await toBase64(file),
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        ptt: type === 'audio' ? $('ptt')?.checked : undefined,
      };
    }
    const r = await post('/api/messages', body);
    if (!r.ok) return showSendError(errorText(r));
    $('text').value = '';
    resizeText();
    clearFile();
    await refreshAll();
    $('messages').scrollTop = $('messages').scrollHeight;
  } finally {
    state.sending = false;
    $('send').disabled = false;
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

function resizeText() {
  const t = $('text');
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
}

$('text').addEventListener('input', resizeText);
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// ── Painel ──────────────────────────────────────────────────────────────────

async function renderPool() {
  const r = await api('/api/pool');
  const box = $('pool');
  const tag = $('pool-state');
  const data = r.body;
  if (!r.ok || !data) {
    tag.textContent = '';
    return box.replaceChildren(h('p', { class: 'notice bad' }, 'Não consegui consultar o gateway.'));
  }
  if (data.poolStatus !== 200) {
    tag.textContent = '';
    return box.replaceChildren(h('p', { class: 'notice bad' }, errorText({ status: data.poolStatus, body: data.pool })));
  }
  const pool = data.pool;
  tag.textContent = pool.paused ? 'pausado' : pool.state;
  tag.className = `tag ${pool.paused ? 'degraded' : pool.state}`;
  const numbers = pool.numbers.map((n) => {
    const share = n.dailyLimit ? Math.min(100, (n.sentToday / n.dailyLimit) * 100) : 0;
    return h(
      'div',
      { class: 'number' },
      h('div', { class: 'mono' }, n.number ?? n.instanceId),
      h('div', {}, `${n.connectionState} · ${n.inRotation ? 'no rodízio' : `fora do rodízio (${n.outOfRotationReason})`} · ${n.sentToday}/${n.dailyLimit} hoje`),
      h('div', { class: 'meter' }, h('i', { style: `width:${share}%` })),
    );
  });
  box.replaceChildren(
    facts([
      ['Na fila', pool.pending],
      ['Gateway', data.healthStatus === 200 ? 'no ar' : 'com problema'],
    ]),
    ...(numbers.length ? numbers : [h('p', { class: 'notice bad' }, 'Pool sem números: nada será enviado.')]),
  );
}

function renderEvents() {
  const box = $('events');
  if (!state.events.length) {
    box.replaceChildren(h('p', { class: 'notice' }, 'Nenhum evento ainda. Envie uma mensagem para ver o gateway responder aqui.'));
    return;
  }
  const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  box.replaceChildren(
    ...state.events.map((e) => {
      const id = e.payload?.eventId ?? e.receivedAt;
      const detail = e.payload?.status ?? e.payload?.state ?? e.payload?.from ?? '';
      return h(
        'details',
        { 'data-id': id, ...(open.has(id) ? { open: '' } : {}) },
        h(
          'summary',
          {},
          h('time', {}, clock(e.receivedAt)),
          h('span', {}, e.type ?? 'desconhecido'),
          detail ? h('span', {}, detail) : null,
          e.rejected ? h('span', { class: 'flag bad' }, 'assinatura inválida') : null,
          e.duplicate ? h('span', { class: 'flag' }, 'repetido') : null,
        ),
        e.payload ? h('pre', {}, JSON.stringify(e.payload, null, 2)) : null,
      );
    }),
  );
}

// ── Ciclo ───────────────────────────────────────────────────────────────────

async function refreshAll() {
  const r = await api('/api/state');
  if (!r.ok) return;
  const s = r.body;
  state.conversations = s.conversations;
  state.events = s.events;
  $('tenant').textContent = `tenant ${s.tenantRef} · cedente ${s.cedenteRef}`;
  const banner = $('banner');
  banner.hidden = s.configured;
  if (!s.configured) {
    banner.replaceChildren('Chat sem credenciais do gateway. Rode ', h('code', {}, 'npm run setup'), ' e reinicie.');
  }
  if (state.active) {
    const known = state.conversations.find((c) => c.key === state.active.key);
    if (known) state.active = known;
  }
  renderConversations();
  renderEvents();
  await loadMessages();
}

$('back').addEventListener('click', () => setView('list'));
$('open-inspector').addEventListener('click', () => setView('inspector'));
$('close-inspector').addEventListener('click', () => setView('chat'));

function connect() {
  let timer = null;
  const stream = new EventSource('/api/stream');
  stream.onmessage = (e) => {
    const notice = JSON.parse(e.data);
    if (notice.type === 'pool') renderPool();
    // Rajada de eventos vira uma atualização só.
    clearTimeout(timer);
    timer = setTimeout(() => {
      refreshAll();
      renderPool();
    }, 120);
  };
}

$('messages').replaceChildren(
  h('p', { class: 'placeholder' }, 'Abra uma conversa para enviar uma mensagem de verdade pelo gateway e acompanhar cada etapa.'),
);
refreshAll();
renderPool();
setInterval(renderPool, 15000);
connect();
