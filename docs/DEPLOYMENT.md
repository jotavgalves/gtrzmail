# Implantação do GTRZ Mail

## 1. Pré-requisitos

- domínio `gtrz.com.br` ativo na Cloudflare;
- Node.js 22+;
- conta Cloudflare com Workers, D1, R2 e Email Routing;
- conta Resend para a saída de e-mails.

## 2. Instalar dependências

```bash
npm install
```

## 3. Criar o D1

```bash
npx wrangler login
npx wrangler d1 create gtrz-mail
```

Copie o `database_id` retornado para `wrangler.jsonc`, substituindo:

```text
REPLACE_WITH_D1_DATABASE_ID
```

Aplique a migration:

```bash
npm run db:migrate:remote
```

## 4. Criar o R2

```bash
npx wrangler r2 bucket create gtrz-mail-storage
```

O bucket deve permanecer privado. Não configure domínio público para ele.

## 5. Configurar os segredos

Gere uma chave mestra de 32 bytes:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Depois:

```bash
npx wrangler secret put MASTER_KEY_B64
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
```

## 6. Criar o primeiro usuário

```bash
npm run admin:create
```

O script imprime dois `INSERT`. Execute-os no D1 remoto com `wrangler d1 execute`.

## 7. Resend

No Resend:

1. adicione/verifique o domínio de envio;
2. configure SPF e DKIM conforme os registros fornecidos pelo Resend;
3. depois de confirmar entregabilidade, publique DMARC adequadamente;
4. crie um webhook para:

```text
https://mail.gtrz.com.br/api/webhooks/resend
```

Marque pelo menos os eventos de envio, entrega, atraso, bounce, complaint e falha. Copie o signing secret `whsec_...` para `RESEND_WEBHOOK_SECRET`.

## 8. Email Routing

No Cloudflare Email Routing do `gtrz.com.br`, crie uma rota ou catch-all que envie as mensagens para o Email Worker `gtrz-mail`.

O Worker primeiro procura uma caixa com endereço exato no D1. Caso a rota seja catch-all e o endereço ainda não exista, ele usa a mailbox marcada como principal.

## 9. Gerar tipos e validar

```bash
npm run cf:typegen
npm run typecheck
npm run deploy:dry
```

## 10. Deploy

```bash
npm run deploy
```

`wrangler.jsonc` já configura `mail.gtrz.com.br` como Custom Domain e desativa `workers.dev` em produção.

## Desenvolvimento visual

```bash
npm run dev:web
```

No Vite, a interface abre automaticamente em modo demonstração. Esse modo é removido pelo build de produção porque depende de `import.meta.env.DEV`.

## Desenvolvimento completo do Worker

Depois de criar D1/R2 e preencher o `database_id`:

```bash
npm run build
npx wrangler dev
```
