# GTRZ Mail

Webmail/PWA privado para `gtrz.com.br`, com interface preta e vermelha baseada na identidade visual GTRZ.

## O que já está implementado

- React PWA responsiva;
- ícones SVG via Lucide React, sem caracteres usados como ícones;
- identidade visual usando os SVGs GTRZ do próprio repositório;
- login com PBKDF2-HMAC-SHA256;
- sessão opaca em cookie `HttpOnly`, `Secure`, `SameSite=Strict`;
- proteção de mesma origem para operações de escrita;
- limitação de tentativas de login via D1;
- caixa de entrada, enviados, arquivo, lixeira e busca;
- composição com múltiplos destinatários, Cc/Cco e anexos;
- recebimento por Cloudflare Email Routing + Email Worker;
- parsing MIME com `postal-mime`;
- D1 para usuários, caixas, índice das mensagens, sessões e auditoria;
- R2 privado para conteúdo e anexos;
- criptografia de aplicação AES-256-GCM com envelope encryption;
- envio externo pelo Resend;
- webhook do Resend com verificação criptográfica Svix e deduplicação;
- estados `sent`, `delivered`, `delayed`, `bounced`, `complained`, `failed` e `suppressed`;
- Service Worker que não cacheia APIs nem conteúdo de e-mail;
- security headers com CSP, HSTS, `nosniff` e política de permissões;
- modo demonstração apenas em desenvolvimento.

## Estrutura

```text
apps/web/              React + Vite + PWA
worker/src/            API, auth, Email Worker, crypto e Resend
database/migrations/   schema D1
scripts/               ferramentas administrativas
docs/                  arquitetura, segurança e implantação
wrangler.jsonc         Worker + D1 + R2 + Custom Domain
```

## Começar

```bash
npm install
npm run dev:web
```

Para preparar a infraestrutura real, siga [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Segurança

Veja [docs/SECURITY.md](docs/SECURITY.md). O R2 permanece privado e o corpo dos e-mails recebe criptografia adicional no nível da aplicação antes de ser persistido.

## Logos

Os arquivos originais enviados ao repositório permanecem intactos. A aplicação usa cópias otimizadas em `apps/web/public/brand/` para o build web.
