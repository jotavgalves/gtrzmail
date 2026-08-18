# Segurança do GTRZ Mail

## Princípios

- O frontend nunca recebe tokens de R2, D1, Resend nem a KEK mestra.
- Sessões usam cookie `HttpOnly`, `Secure` e `SameSite=Strict`; o D1 guarda somente SHA-256 do token.
- Operações de escrita exigem mesma origem.
- Corpos, HTML, RFC822 e anexos são criptografados no nível da aplicação antes do R2 privado.
- Cada mensagem usa uma DEK aleatória AES-256-GCM protegida por uma KEK mantida como Worker Secret.
- A KEK pode ser rotacionada por dois slots com rewrap resumível das DEKs.
- HTML recebido é sanitizado no Worker e isolado em iframe sandbox de origem opaca na interface.
- Imagens externas de mensagens recebidas são bloqueadas por padrão.
- Anexos de conteúdo ativo não executam inline.
- Webhooks do Resend são verificados por assinatura e deduplicados.
- Logs de auditoria registram eventos, nunca corpo de e-mail, senha ou chave criptográfica.

## Autenticação

- Senha PBKDF2-HMAC-SHA256 com salt aleatório e comparação em tempo constante.
- Passkeys/WebAuthn com verificação local do usuário obrigatória.
- Desafios WebAuthn são curtos e de uso único.
- Administração exige step-up recente por senha ou passkey.
- Sessões têm expiração absoluta, timeout de inatividade, vínculo com User-Agent e podem ser listadas/revogadas.
- Trocar a senha encerra outras sessões e gira o token atual.

## Proteção contra tentativa de senha

A contagem de login é mantida no D1 e identificada pelo `CF-Connecting-IP` fornecido pela Cloudflare.

- primeiras 3 senhas incorretas → bloqueio de 30 minutos;
- após 30 minutos → Cloudflare Turnstile obrigatório;
- mais 3 senhas incorretas → bloqueio permanente daquele IP até o administrador liberar;
- o IP bloqueado não recebe a página nem as APIs normais;
- existe painel administrativo de IPs bloqueados e recuperação via `npm run auth:unblock-ip`;
- uma lease atômica no D1 serializa PBKDF2 por IP, impedindo bypass com várias requisições simultâneas;
- limpar cookies/localStorage, modo anônimo, trocar e-mail tentado ou falsificar `X-Forwarded-For` não reinicia o contador;
- a confirmação de identidade por senha também recebe limite de 3 erros e cooldown de 30 minutos.

A troca real do endereço IP público continua sendo uma nova identidade de rede. WAF/rate limiting no edge é a camada complementar para ataques distribuídos por múltiplos IPs.

## Segredos de produção

Configure com `wrangler secret put` e nunca publique os valores:

- `MASTER_KEY_B64` ou o slot de KEK atualmente ativo;
- `RESEND_API_KEY`;
- `RESEND_WEBHOOK_SECRET`;
- `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`;
- `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`;
- `KEY_ROTATION_TOKEN` somente enquanto uma rotação de KEK estiver em andamento.

Nunca comite `.dev.vars`, `.env` ou qualquer segredo.

## Cabeçalhos e browser isolation

O Worker e os Static Assets aplicam CSP, HSTS, `nosniff`, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy, COOP/CORP e demais restrições. A CSP libera `challenges.cloudflare.com` exclusivamente para o script/frame do Turnstile.

## Limitações

- A criptografia no R2 não é E2EE/zero-knowledge: o Worker possui autoridade para desembrulhar a DEK e exibir a mensagem ao usuário autenticado.
- Metadados necessários a busca, threading, roteamento e segurança ficam no D1 em texto claro; isso inclui remetente/destinatários/assunto/preview e, no módulo de bloqueio administrativo, o endereço IP que foi bloqueado.
- Proteção puramente por IP não identifica uma pessoa que muda de rede, VPN ou proxy. Por isso o desenho também depende de Turnstile, passkeys, rate limiting do Worker e controles de edge da Cloudflare.
