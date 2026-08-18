# GTRZ Mail — checklist de produção

## Estado funcional

O GTRZ Mail usa Cloudflare Worker + D1 + R2, Cloudflare Email Routing para entrada e Resend para saída.

O schema atual possui migrations até `0010_auth_ip_protection.sql`. **Aplique as migrations antes de publicar o Worker que depende delas.**

## Pré-requisito novo: Cloudflare Turnstile

Antes do deploy da proteção de login:

1. No Cloudflare Dashboard, crie um widget Turnstile para `mail.gtrz.com.br` em modo Managed.
2. Copie a site key e a secret key somente para o terminal autorizado.
3. Configure sem colar os valores em chats, commits ou issues:

```powershell
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

O Worker valida o token no servidor. O frontend sozinho não decide se o CAPTCHA foi aceito.

## Publicar esta versão

Na máquina autorizada:

```powershell
cd C:\Users\CRIACAO\gtrzmail
git pull --ff-only
npm install
npm run db:migrate:remote
npm run deploy
```

Se Web Push ainda não estiver configurado, execute uma vez `npm run push:setup`. Não use `--force` em operação normal.

Depois do deploy, feche totalmente o PWA e abra novamente para assumir o shell mais recente.

## Proteção de senha

Fluxo de login por IP:

1. 3 senhas incorretas;
2. bloqueio de 30 minutos;
3. Turnstile obrigatório;
4. mais 3 tentativas;
5. terceira senha incorreta da segunda sequência bloqueia o IP até liberação administrativa.

A contagem fica no D1 e usa `CF-Connecting-IP`. Cookies, localStorage, modo anônimo, troca de e-mail tentado e `X-Forwarded-For` não reiniciam o contador. Uma lease atômica no D1 serializa a verificação de senha por IP para impedir rajadas paralelas de passarem várias tentativas antes da atualização do contador.

IPs permanentemente bloqueados não recebem a aplicação/API. O administrador, após step-up recente, vê `IPs bloqueados` em Configurações e pode liberar cada endereço.

### Recuperação de emergência

Se o próprio IP do administrador for bloqueado e não houver outro acesso ao painel:

```powershell
npm run auth:unblock-ip
```

O comando lista os IPs bloqueados. Para liberar um:

```powershell
npm run auth:unblock-ip -- 203.0.113.10
```

Também aceita o hash completo mostrado pelo D1. O comando exige Wrangler autenticado na máquina autorizada.

A reautenticação por senha usada em ações sensíveis também é serializada. Três confirmações erradas bloqueiam novas confirmações por 30 minutos.

## Passkeys / administração

- Passkeys WebAuthn exigem verificação local do usuário.
- Administração exige step-up recente por senha ou passkey.
- Cadastro/remoção de passkeys exige step-up.
- Troca de senha revoga outras sessões e gira o token atual.
- Usuário pode listar/revogar dispositivos conectados.
- Eventos de segurança ficam disponíveis em Configurações.

## Cache do PWA

- `/api/*` não é cacheado pelo Service Worker.
- assets Vite com hash continuam cache-first.
- navegações são network-first para que um bloqueio permanente de IP seja aplicado pelo servidor mesmo quando existe shell antigo no cache; em indisponibilidade de rede continua existindo fallback offline.
- `/sw.js` não é servido pelo próprio cache.

## Conteúdo e anexos

- HTML recebido é sanitizado no Worker.
- imagens remotas ficam bloqueadas por padrão;
- conteúdo HTML é isolado em iframe sandbox de origem opaca;
- anexos ativos como HTML/SVG/XML/JS são forçados para download;
- somente PNG/JPEG/GIF/WebP podem ser exibidos inline;
- texto, HTML, RFC822 e anexos ficam criptografados no R2 privado.

## Rotação da chave mestra

O sistema suporta dois slots de KEK e rewrap online das DEKs. A rotação real já foi exercitada com promoção de versão e retirada segura do slot aposentado.

Para uma rotação futura:

```powershell
npm run secret:rotate-master-key
```

Se uma rotação for interrompida, não apague manualmente os slots nem `KEY_ROTATION_TOKEN`; corrija a causa e execute o comando novamente.

## DNS e entregabilidade

SPF, DKIM e DMARC já foram validados em mensagem real recebida pelo Gmail; a política observada é `p=REJECT; sp=REJECT`. O domínio também está verificado no Google Postmaster Tools.

Diagnóstico:

```powershell
npm run dns:check
```

## Testes mínimos após deploy

1. Confirmar `/api/health`.
2. Login correto e logout.
3. Errar senha uma vez e confirmar indicação de tentativas restantes.
4. Em IP controlado de teste, validar três falhas → cooldown de 30 min. Não faça esse teste no único IP administrativo disponível.
5. Após o cooldown, confirmar exibição/validação do Turnstile.
6. Validar segunda sequência em um IP de teste e confirmar página de bloqueio após a terceira falha.
7. De outro IP administrativo, abrir Configurações → IPs bloqueados e liberar o IP de teste.
8. Confirmar que o IP liberado volta a abrir a página.
9. Testar `npm run auth:unblock-ip` apenas com um IP de teste quando for necessário validar a recuperação de emergência.
10. Confirmar que duas requisições de senha paralelas para o mesmo IP não avançam simultaneamente: uma deve receber o estado de validação em andamento.
11. Validar passkey em dispositivo real.
12. Enviar/receber e-mail, HTML, inline image e anexo.
13. Confirmar Web Push com o PWA totalmente fechado.
14. Confirmar thread/reply/reply-all/forward e ações de pasta.
15. Testar agenda/autocomplete em `Para/Cc/Cco`.

## Controles externos ainda recomendados

- `Always Use HTTPS` na Cloudflare;
- WAF Managed Rules;
- rate limiting/Managed Challenge no edge para `/api/auth/*` e outros endpoints caros;
- DNSSEC depois de validar o registrador;
- MFA/passkey nas contas Cloudflare, GitHub, registrador e Google.

Mesmo com o contador forte no Worker, um invasor que realmente troca de IP público passa a ter outra identidade de rede. O rate limiting/WAF no edge é a camada adequada para reduzir ataques distribuídos por muitos IPs.
