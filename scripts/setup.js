// Cadastra este chat no gateway como um consumidor: consumidor → token → tenant → cedente → servidor Evolution →
// instância → webhook da instância. Pode rodar de novo: o que já existe é reaproveitado.
//
// Pede a chave admin do gateway e o token da instância; nenhum dos dois é gravado.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { ENV_FILE, ROOT, loadEnvFile } from '../src/config.js';

if (!fs.existsSync(ENV_FILE)) fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
loadEnvFile();

const env = process.env;
const GATEWAY = env.GATEWAY_URL.replace(/\/$/, '');
const EVOLUTION = env.EVOLUTION_URL.replace(/\/$/, '');
const INSTANCE = env.EVOLUTION_INSTANCE;
const EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'SEND_MESSAGE', 'MESSAGES_UPDATE'];

function saveEnv(values) {
  let text = fs.readFileSync(ENV_FILE, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.trimEnd()}\n${line}\n`;
    env[key] = value;
  }
  fs.writeFileSync(ENV_FILE, text);
}

async function ask(name, question) {
  if (env[name]) return env[name];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  if (!answer) throw new Error(`${name} é obrigatório`);
  return answer;
}

async function request(base, method, url, headers, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/// Número da instância, para o gateway mostrar por qual número a mensagem saiu. É só informativo.
async function ownerNumber(token) {
  const list = await request(EVOLUTION, 'GET', `/instance/fetchInstances?instanceName=${INSTANCE}`, {
    apikey: token,
  }).catch(() => null);
  const number = /^(\d+)[:@]/.exec(list?.[0]?.ownerJid ?? '')?.[1];
  return number && /^[1-9]\d{9,14}$/.test(number) ? number : undefined;
}

async function main() {
  const health = await fetch(`${GATEWAY}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Gateway fora do ar em ${GATEWAY}. Suba com --profile gateway.`);

  const adminKey = await ask('GATEWAY_ADMIN_KEY', 'Chave admin do gateway (X-Admin-Key): ');
  const admin = (method, url, body) => request(GATEWAY, method, url, { 'x-admin-key': adminKey }, body);

  const webhookUrl = `${env.CHAT_PUBLIC_URL.replace(/\/$/, '')}/webhooks/gateway`;
  const { consumers } = await admin('GET', '/admin/consumers');
  let consumer = consumers.find((c) => c.slug === env.CONSUMER_SLUG);
  if (consumer) {
    await admin('PATCH', `/admin/consumers/${consumer.id}`, { webhookUrl });
    if (!env.GATEWAY_WEBHOOK_SECRET) {
      const { webhookSecret } = await admin('POST', `/admin/consumers/${consumer.id}/webhook-secret/rotate`);
      saveEnv({ GATEWAY_WEBHOOK_SECRET: webhookSecret });
    }
    console.log(`consumidor ${consumer.slug}: reaproveitado`);
  } else {
    consumer = await admin('POST', '/admin/consumers', {
      slug: env.CONSUMER_SLUG,
      name: 'Chat de teste',
      webhookUrl,
    });
    saveEnv({ GATEWAY_WEBHOOK_SECRET: consumer.webhookSecret });
    console.log(`consumidor ${consumer.slug}: criado`);
  }

  if (!env.GATEWAY_BEARER) {
    const { token } = await admin('POST', `/admin/consumers/${consumer.id}/tokens`, { label: 'whatsapp_chat' });
    saveEnv({ GATEWAY_BEARER: token });
    console.log('token do consumidor: emitido');
  }

  const { tenants } = await admin('GET', `/admin/consumers/${consumer.id}/tenants`);
  let tenant = tenants.find((t) => t.externalRef === env.TENANT_REF);
  tenant ??= await admin('POST', `/admin/consumers/${consumer.id}/tenants`, {
    externalRef: env.TENANT_REF,
    name: 'Chat de teste',
  });
  const poolId = tenant.poolId ?? tenant.pool?.id;

  const { cedentes } = await admin('GET', `/admin/tenants/${tenant.id}/cedentes`);
  if (!cedentes.some((c) => c.externalRef === env.CEDENTE_REF)) {
    await admin('POST', `/admin/tenants/${tenant.id}/cedentes`, { externalRef: env.CEDENTE_REF, name: 'Chat de teste' });
  }
  console.log(`tenant ${env.TENANT_REF} e cedente ${env.CEDENTE_REF}: prontos`);

  if (!env.EVOLUTION_SERVER_ID) {
    const server = await admin('POST', '/admin/evolution-servers', {
      name: env.EVOLUTION_SERVER_NAME,
      baseUrl: env.EVOLUTION_INTERNAL_URL,
    });
    saveEnv({ EVOLUTION_SERVER_ID: server.id, EVOLUTION_WEBHOOK_PATH: server.webhookPath });
    console.log(`servidor Evolution ${server.name}: cadastrado`);
  }

  const pool = await admin('GET', `/admin/pools/${poolId}`);
  const registered = (pool.instances ?? pool.numbers ?? []).some((i) => i.evolutionName === INSTANCE);
  if (registered) {
    console.log(`instância ${INSTANCE}: já no pool`);
    return;
  }
  const token = await ask('EVOLUTION_INSTANCE_TOKEN', `Token da instância ${INSTANCE}: `);
  // O webhook vem antes do registro: se o token estiver errado, nada fica cadastrado pela metade.
  await request(EVOLUTION, 'POST', `/webhook/set/${INSTANCE}`, { apikey: token }, {
    webhook: {
      enabled: true,
      url: `${env.GATEWAY_INTERNAL_URL.replace(/\/$/, '')}${env.EVOLUTION_WEBHOOK_PATH}`,
      byEvents: false,
      base64: false,
      events: EVENTS,
    },
  });
  await admin('POST', `/admin/pools/${poolId}/instances`, {
    evolutionServerId: env.EVOLUTION_SERVER_ID,
    evolutionName: INSTANCE,
    token,
    phoneNumber: await ownerNumber(token),
  });
  console.log(`instância ${INSTANCE}: no pool, webhook apontando para o gateway`);
}

main()
  .then(() => console.log('\nPronto. Rode `npm start` e abra http://127.0.0.1:3100'))
  .catch((err) => {
    console.error(`\nFalhou: ${err.message}`);
    process.exit(1);
  });
