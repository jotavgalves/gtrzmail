# GTRZ Mail — baseline de segurança

Este documento descreve a defesa em profundidade do GTRZ Mail. Não contém secrets, senhas, tokens ou chaves.

## Perímetro

- HTTPS obrigatório no edge da Cloudflare.
- TLS legado é verificado pelo smoke remoto; TLS 1.2+ precisa permanecer disponível.
- HSTS, CSP, `nosniff`, `frame-ancestors 'none'`, COOP/CORP, Referrer-Policy e Permissions-Policy tanto no Worker quanto nos Static Assets.
- APIs sempre `Cache-Control: no-store` e sem CORS wildcard.
- Mutações exigem `Origin` exatamente igual a `APP_ORIGIN`.
- O shell PWA usa navegação network-first para que um IP permanentemente bloqueado não consiga reaproveitar uma página antiga do cache para contornar a tela de bloqueio.

## Autenticação e sessões

- Senhas PBKDF2-HMAC-SHA256 com salt aleatório; runtime atual usa até 100.000 iterações.
- Sessão é um token opaco de 256 bits; somente SHA-256(token) fica no D1.
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`.
- Limite absoluto de sessão + 12 horas de inatividade.
- Sessão vinculada ao User-Agent original; alteração revoga o token.
- Mudanças de rede/IP são auditadas sem bloquear redes móveis legítimas.
- Troca de senha revoga todas as outras sessões e gira o token atual.
- Usuário consegue listar e revogar dispositivos/sessões.
- E-mails inexistentes executam o mesmo trabalho PBKDF2 para reduzir enumeração por tempo.

### Tentativas de senha e bloqueio por IP

A migration `0010_auth_ip_protection.sql` mantém o estado no D1; o navegador não é a fonte da contagem.

1. O IP recebe até **3 senhas incorretas**.
2. A terceira senha incorreta inicia bloqueio temporário de **30 minutos**.
3. Encerrado o prazo, um **Cloudflare Turnstile** válido é obrigatório antes da segunda sequência.
4. Depois do Turnstile, o IP recebe mais **3 tentativas**.
5. A terceira senha incorreta da segunda sequência torna o IP **bloqueado até intervenção administrativa**.
6. Um IP permanentemente bloqueado recebe `403` nas APIs e uma página de bloqueio nas navegações.
7. O administrador pode liberar o IP pelo painel de segurança; existe também `npm run auth:unblock-ip` como recuperação de emergência fora do navegador.

Defesas contra manipulação da contagem:

- a chave principal é `CF-Connecting-IP`, inserida pela Cloudflare; `X-Forwarded-For`, cookies, localStorage, query string e e-mail digitado não controlam o identificador do IP;
- a contagem fica no D1, portanto limpar dados do navegador, trocar navegador ou abrir modo anônimo não reinicia o estado;
- trocar o endereço de e-mail tentado não reinicia o contador do IP; o estado registra quando houve alvos diferentes para impedir que um login válido em outra conta seja usado como atalho para apagar falhas anteriores;
- antes de executar PBKDF2, o Worker adquire uma lease curta e atômica no D1; apenas uma verificação de senha por IP pode avançar de cada vez, impedindo rajadas paralelas de passarem várias senhas antes da persistência da terceira falha;
- se o Worker cair durante a verificação, a lease expira sozinha; uma tentativa não fica travada indefinidamente;
- o Turnstile é validado no servidor, com `remoteip`, hostname e `action` esperados; o token não é aceito apenas porque o frontend diz que o CAPTCHA passou;
- o frontend descarta o token do Turnstile depois do uso e não tenta reutilizá-lo;
- a mesma serialização é aplicada ao step-up por senha; três confirmações incorretas bloqueiam novas confirmações por 30 minutos.

Um invasor que realmente muda de endereço IP público cria uma nova identidade de rede; nenhum contador puramente por IP consegue provar que é a mesma origem. Por isso o próximo nível de proteção fica no edge: rate limiting/WAF/Managed Challenge para `/api/auth/*`, além de Turnstile e monitoramento de eventos.

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
- Eventos `auth.*`, `admin.*`, `crypto.*` e bloqueios de abuso são mantidos em audit log.
- O painel `IPs bloqueados` é visível somente após autenticação administrativa + step-up recente.
- A liberação de IP pelo endpoint administrativo também exige essas duas condições no Worker; ocultar o botão no frontend não é o controle de segurança.

## Supply chain

- GitHub Actions oficiais fixadas por commit SHA, não apenas tag móvel.
- Checkout não persiste credencial Git no job.
- Instalação no CI usa `--ignore-scripts`.
- `npm audit --omit=dev --audit-level=high` bloqueia vulnerabilidades altas/críticas de produção.
- Dependabot acompanha npm e GitHub Actions semanalmente.
- CodeQL `security-extended` analisa JavaScript/TypeScript automaticamente.

## Turnstile

O frontend usa renderização explícita do widget somente quando o primeiro lote de três falhas já terminou e o cooldown expirou. A validação decisiva acontece no Worker.

Bindings necessários em produção:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

Esses valores não devem ser enviados para issues, commits ou conversas. Configure-os diretamente com Wrangler depois de criar o widget para `mail.gtrz.com.br` no painel Cloudflare.

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

Os testes automatizados não provocam seis senhas erradas em produção, pois isso bloquearia o IP do runner. O fluxo destrutivo de bloqueio deve ser validado de forma controlada com um IP de teste que possa ser liberado imediatamente pelo painel ou pelo comando de emergência.

## Controles que ficam no painel Cloudflare

1. `Always Use HTTPS` na zona.
2. WAF Managed Rules compatíveis com o plano.
3. Rate limiting no edge para `/api/auth/*`, `/api/messages/send` e endpoints caros.
4. Managed Challenge adicional para tráfego anômalo, se desejado.
5. Cloudflare Access ou service token para uma superfície administrativa separada, se adotado.
6. DNSSEC na zona, depois de validar o registrador.

## Operação

- Nunca armazenar secrets em commits, issues, Actions logs ou chats.
- Usar tokens Cloudflare com menor privilégio possível; evitar Global API Key.
- Cloudflare, GitHub, registrador e Conta Google devem usar MFA resistente a phishing.
- Revisar eventos de segurança, IPs bloqueados e sessões ativas periodicamente.
- Fazer restore testado de D1/R2 e manter recuperação da KEK fora da mesma conta/host da produção.
