# Segurança do GTRZ Mail

## Princípios

- O frontend nunca recebe tokens de R2, D1, Resend ou a chave mestra de criptografia.
- Sessões usam cookie `HttpOnly`, `Secure` e `SameSite=Strict`.
- Toda operação de escrita da API exige mesma origem.
- Corpos de e-mail e anexos são criptografados no nível da aplicação antes de irem ao R2.
- Cada mensagem usa uma chave de dados aleatória (DEK). A DEK é protegida pela chave mestra (KEK) mantida como Worker Secret.
- O bucket R2 deve permanecer privado.
- E-mails HTML recebidos não são renderizados diretamente. A primeira versão exibe texto seguro derivado do MIME.
- Webhooks do Resend são verificados por assinatura Svix e deduplicados pelo `svix-id`.
- Logs de auditoria registram ações, nunca o corpo das mensagens.

## Segredos obrigatórios

Use `wrangler secret put` em produção:

- `MASTER_KEY_B64`: 32 bytes aleatórios em Base64.
- `RESEND_API_KEY`: chave da API do Resend.
- `RESEND_WEBHOOK_SECRET`: segredo `whsec_...` do webhook.

Gere a chave mestra, por exemplo, com Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Nunca comite `.dev.vars`, `.env` ou qualquer segredo.

## Cabeçalhos

O Worker adiciona CSP, HSTS, `nosniff`, política de referrer e política de permissões a respostas do aplicativo.

## Limitações atuais

- A criptografia no R2 é forte, mas não é E2EE/zero-knowledge: o Worker precisa descriptografar a mensagem para exibi-la.
- Metadados de indexação (remetente, destinatários, assunto e preview) ficam no D1 para busca e listagem.
- Passkeys/WebAuthn são uma evolução prevista; a autenticação inicial usa senha PBKDF2-HMAC-SHA256 e sessão opaca.
