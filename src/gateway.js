// Cliente da API do consumidor (GATEWAY.md § 4). Toda chamada devolve { status, body, headers }: quem decide o
// que fazer com um 4xx é a tela, que precisa mostrar a resposta real do gateway.

export class GatewayClient {
  constructor(config) {
    this.config = config;
  }

  async call(method, path, body) {
    const { gatewayUrl, bearer } = this.config;
    let res;
    try {
      res = await fetch(`${gatewayUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return {
        status: 502,
        body: {
          error: {
            code: 'GATEWAY_UNREACHABLE',
            message: `Gateway não respondeu em ${gatewayUrl}: ${err.cause?.code ?? err.message}`,
          },
        },
      };
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 300) } };
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  tenantPath(suffix) {
    return `/tenants/${encodeURIComponent(this.config.tenantRef)}${suffix}`;
  }

  send(payload) {
    return this.call('POST', this.tenantPath('/messages'), payload);
  }

  getMessage(id) {
    return this.call('GET', `/messages/${encodeURIComponent(id)}`);
  }

  status() {
    return this.call('GET', this.tenantPath('/status'));
  }

  checkNumber(number) {
    return this.call('POST', this.tenantPath('/numbers/check'), { numbers: [number] });
  }

  health() {
    return this.call('GET', '/health');
  }
}
