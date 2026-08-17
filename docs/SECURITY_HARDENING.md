# GTRZ Mail — baseline de segurança

Este documento descreve a defesa em profundidade do GTRZ Mail. Não contém secrets, senhas, tokens ou chaves.

## Perímetro

- HTTPS obrigatório no edge da Cloudflare (ativar `Always Use HTTPS` na zona).
- TLS 1.0/1.1 recusados; smoke remoto valida TLS 1.2+.
- HSTS, CSP, `nosniff`, `frame-ancestors 'none'`, COOP/CORP, Referrer-Policy e Permissions-Policy tanto no Worker quanto nos Static Assets.
- APIs sempre `Cache-Control: no-store` e sem CORS wildcard.
- Mutações exigem `Origin` exatamente igual a `APP_ORIGIN`.
- Smoke remoto diário e manual valida o ambiente público sem credenciais.

## Autenticação e sessões

- Senhas PBKDF2-HMAC-SHA256 com salt aleatório; runtime atual limita o custo a 100.000 iterações.
- Sessão é um token opaco de 256 bits; somente SHA-256(token) fica no D1.
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`.
- Limite absoluto de sessão + 12 horas de inatividade.
- Sessão vinculada ao User-Agent original; alteração revoga o token.
- Mudanças de rede/IP são auditadas sem bloquear redes móveis legítimas.
- Troca de senha revoga todas as outras sessões e gira o token atual.
- Usuário consegue listar e revogar dispositivos/sessões.
- Brute force limitado simultaneamente por e-mail+IP, por e-mail e por IP.
- E-mails inexistentes executam trabalho PBKDF2 de compensação para reduzir enumeração por tempo.

## Passkeys / WebAuthn

- Passkeys baseadas em WebAuthn com `userVerification: required`.
- Face ID, Touch ID, Windows Hello/PIN ou autenticador FIDO2 podem confirmar o usuário.
- A chave privada nunca chega ao GTRZ Mail.
- Desafios duram 5 minutos e são consumidos uma única vez.
- Passkeys podem fazer login sem senha.
- Operações administrativas exigem step-up recente (10 minutos) por senha ou passkey.
- Cadastro e remoção de passkeys também exigem step-up.

## Conteúdo de e-mail

- HTML é sanitizado no Worker antes de chegar à UI.
- Scripts, handlers, iframes, forms, objects, `javascript:` e CSS fora da allowlist são removidos/bloqueados.
- Imagens HTTP/HTTPS recebidas são bloqueadas por padrão para impedir tracking pixels.
- Imagens CID são entregues somente pelo endpoint autenticado do próprio GTRZ Mail.
- Na UI, o HTML da mensagem é copiado para um `iframe sandbox` com origem opaca, sem scripts, forms, network/connect, objects ou frames.
- Anexos HTML/SVG/XML/JavaScript nunca são executados inline; são forçados para download como conteúdo não ativo.
- Somente PNG/JPEG/GIF/WebP podem ser exibidos inline.

## Criptografia

- Cada mensagem usa uma DEK AES-256-GCM independente.
- Corpo, HTML, MIME e anexos ficam criptografados no R2 privado.
- A DEK é embrulhada por uma KEK mestra.
- Rotação usa dois slots de KEK e rewrap em lotes, sem recriptografar todo o conteúdo.
- A chave antiga só é removida depois de todas as DEKs migrarem.
- O token operacional de rotação é temporário e separado das chaves criptográficas.

## Administração

- Rotas administrativas verificam `is_admin` no Worker.
- Listagem e mutações administrativas exigem step-up recente.
- Alteração de senha administrativa derruba sessões da conta afetada.
- Eventos `auth.*`, `admin.*` e `crypto.*` são mantidos em audit log e expostos apenas à conta autenticada; visão global exige admin + step-up.

## Supply chain

- GitHub Actions oficiais fixadas por commit SHA, não apenas tag móvel.
- Checkout não persiste credencial Git no job.
- Instalação no CI usa `--ignore-scripts`.
- `npm audit --omit=dev --audit-level=high` bloqueia vulnerabilidades altas/críticas de produção.
- Dependabot acompanha npm e GitHub Actions semanalmente.
- CodeQL `security-extended` analisa JavaScript/TypeScript automaticamente.

## Testes remotos

`scripts/remote-security-smoke.sh` confirma, sem credenciais:

- headers de segurança no shell público;
- redirecionamento HTTP → HTTPS;
- `401` nas APIs protegidas;
- `no-store` e ausência de CORS wildcard;
- bloqueio cross-origin de login, passkeys, reautenticação e envio;
- proteção da rota interna de rotação;
- TRACE recusado;
- TLS legado desabilitado.

## Controles que ficam no painel Cloudflare

Estes itens não podem ser efetivados apenas pelo repositório:

1. `Always Use HTTPS` na zona.
2. WAF Managed Rules compatíveis com o plano.
3. Rate limiting no edge para `/api/auth/*`, `/api/messages/send` e endpoints caros.
4. Managed Challenge/Turnstile para tráfego de login considerado abusivo.
5. Cloudflare Access ou service token para um hostname administrativo/interno, se adotado.
6. DNSSEC na zona, depois de validar o registrador.

## Operação

- Nunca armazenar secrets em commits, issues, Actions logs ou chats.
- Usar tokens Cloudflare com menor privilégio possível; evitar Global API Key.
- Cloudflare, GitHub, registrador e Conta Google devem usar MFA resistente a phishing (passkey/chave FIDO2 quando disponível).
- Revisar eventos de segurança e sessões ativas periodicamente.
- Fazer restore testado de D1/R2 e manter recuperação da KEK fora da mesma conta/host da produção.
