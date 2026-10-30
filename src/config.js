import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/// Lê o `.env` sem sobrescrever o que já veio do ambiente.
export const ENV_FILE = process.env.CHAT_ENV_FILE || path.join(ROOT, '.env');

export function loadEnvFile(file = ENV_FILE) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function configFrom(env = process.env) {
  const port = Number(env.PORT || 3100);
  return {
    port,
    host: env.HOST || '127.0.0.1',
    gatewayUrl: (env.GATEWAY_URL || 'http://127.0.0.1:8090').replace(/\/$/, ''),
    bearer: env.GATEWAY_BEARER || '',
    webhookSecret: env.GATEWAY_WEBHOOK_SECRET || '',
    tenantRef: env.TENANT_REF || 'chat',
    cedenteRef: env.CEDENTE_REF || 'chat',
    dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  };
}
