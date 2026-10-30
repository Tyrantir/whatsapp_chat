# whatsapp_chat

Chat local para testar o [Gateway WhatsApp Auvix](../AUVIX_WHATSAPP/gateway/README.md) de ponta a ponta. Ele se
comporta como um consumidor real: envia por `POST /tenants/{tenantRef}/messages`, recebe `message.status`,
`message.inbound` e `pool.state` por webhook assinado e guarda o próprio histórico.

Mensagens enviadas aqui **saem de verdade** pelo número conectado. Use um chip de teste
(`docs/OPERACAO.md` § "Número novo e testes", no repositório do gateway).

```
navegador ──> este chat ──Bearer──> gateway ──> Evolution ──> WhatsApp
     ▲            ▲                    │
     └── SSE ─────┴── webhook HMAC ────┘
```

O Bearer e o segredo HMAC ficam só no servidor local. O navegador nunca vê credencial.

## Rodar

Requisitos: Node 20.12+, sem dependências npm. Evolution e gateway de pé, com a instância conectada:

```bash
# em AUVIX_WHATSAPP
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile gateway up -d
```

Na primeira vez, cadastre o chat no gateway:

```bash
npm run setup
```

O setup pede a **chave admin do gateway** (`X-Admin-Key`, a credencial cujo SHA-256 está em
`ADMIN_API_KEY_SHA256`) e o **token da instância** impresso pelo `create-instance.sh`. Nenhum dos dois é gravado.

Ele cria o consumidor `chatteste` com tenant e cedente `chat`, cadastra o servidor Evolution, registra a instância
`auvix_teste` no pool e **aponta o webhook dessa instância para o gateway**. Depois disso, o que a instância
recebe vai para o gateway, não para o destino anterior. Pode rodar de novo sem duplicar nada.

Se perdeu a chave admin, gere outra e reinicie o gateway:

```bash
KEY=$(openssl rand -hex 32); echo "$KEY"
printf %s "$KEY" | sha256sum | cut -d' ' -f1   # vai em ADMIN_API_KEY_SHA256 no gateway/.env
docker compose -f docker-compose.yml -f docker-compose.local.yml --profile gateway up -d gateway
```

Depois:

```bash
npm start   # http://127.0.0.1:3100
```

## O que dá para testar

- Texto, imagem, vídeo, documento e áudio (com a opção de mensagem de voz), até 14 MB
- Validação de número (`numbers/check`)
- Percurso de cada mensagem: fila, enviada, entregue e lida, com o tempo entre as etapas
- Retenções (`holdReason`) e falhas (`failureReason`), e as recusas 4xx do gateway com a mensagem original
- Resposta do contato, com anexo baixado para `data/media`
- Estado do pool, uso diário e fila pendente
- Todo webhook recebido, com o JSON cru; assinatura inválida e evento repetido ficam marcados
- Clique numa mensagem para ver ids e consultar `GET /messages/{id}`

O gateway mantém o ritmo anti-ban: entre uma mensagem e outra do mesmo número há 15 a 30 s. Fila andando devagar é o
comportamento esperado.

## Testes

```bash
npm test
```

Rodam contra um gateway falso e não enviam nada.
