# GTRZ Mail — checklist de produção

## Estado funcional

O GTRZ Mail usa Cloudflare Worker + D1 + R2, Cloudflare Email Routing para entrada e Resend para saída.

As migrations `0001_initial.sql` e `0002_product_features.sql` já foram aplicadas no D1 remoto.

A versão de rich email adiciona `0003_rich_email.sql`, que cria a assinatura HTML por conta.

A versão de conversas + Web Push adiciona `0004_threads_push.sql`, que:

- adiciona `messages.thread_id`;
- cria índice para threads;
- cria `push_subscriptions` por usuário/dispositivo;
- preserva uma mesma inscrição do navegador para mais de uma conta GTRZ quando cada conta for usada naquele navegador.

**Aplique todas as migrations pendentes antes de publicar o Worker novo.**

## Publicar esta versão

Na máquina autorizada:

```powershell
cd C:\Users\CRIACAO\gtrzmail
git pull --ff-only
npm install
npm run db:migrate:remote
npm run push:setup
npm run deploy
```

`npm run push:setup` consulta apenas os nomes dos secrets existentes. Se `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` já existirem, não altera nada. Na primeira execução ele gera o par VAPID e envia os dois valores ao Worker sem exibi-los nem gravá-los em arquivo local. Não use `npm run push:setup -- --force` em operação normal, porque trocar o par VAPID invalida as inscrições push existentes.

O `npm run deploy` já executa o build antes do Wrangler. O CI do branch valida migrations, build, typecheck e bundle do Worker.

## Conversas agrupadas

- mensagens recebem `thread_id` derivado de `Message-ID`, `In-Reply-To` e `References`;
- o reconciliador de threads corrige mensagens antigas quando existem referências RFC suficientes;
- a lista mostra apenas uma linha por thread dentro da pasta atual;
- a linha recebe contador quando a conversa contém mais de uma mensagem;
- ao abrir uma thread, todas as mensagens relacionadas são mostradas na mesma conversa, em ordem cronológica;
- cada mensagem da conversa pode ser expandida/recolhida;
- respostas enviadas e mensagens recebidas podem aparecer juntas na mesma conversa;
- webhooks atuais do Resend alimentam `message_id` dos e-mails enviados quando o provedor disponibiliza esse campo.

## Web Push com o PWA fechado

- o navegador usa `PushManager` + Service Worker;
- inscrições são gravadas em D1 e associadas à conta autenticada;
- o Worker envia Web Push após a entrada ser persistida com sucesso;
- payloads usam VAPID e `aes128gcm` via biblioteca compatível com Web Crypto/Cloudflare Workers;
- inscrições expiradas (`404`/`410` no push service) são removidas automaticamente;
- o Service Worker mostra a notificação mesmo sem uma aba do GTRZ Mail aberta;
- clicar na notificação foca uma janela existente ou abre o PWA e tenta selecionar a mensagem/thread recebida;
- depois de o usuário permitir notificações uma vez, a inscrição existente é sincronizada automaticamente com a conta ativa ao abrir o GTRZ Mail.

## Editor HTML e leitura rica

- compositor `contentEditable` com negrito, itálico, sublinhado, tachado, títulos, listas, citações, alinhamento, links, cores, destaque e limpeza de formatação;
- imagens PNG/JPG/GIF/WebP podem ser selecionadas, coladas ou arrastadas para dentro do corpo;
- imagens inseridas no corpo são transformadas no Worker em anexos inline CID no envio;
- o e-mail mantém uma versão `text/plain` como fallback e uma versão HTML sanitizada;
- o HTML de rascunhos e enviados é armazenado no R2 criptografado com a mesma DEK da mensagem e IV próprio;
- mensagens HTML recebidas são extraídas do MIME criptografado e sanitizadas antes de chegar à interface;
- imagens CID recebidas são resolvidas para o endpoint autenticado de anexos;
- anexos inline não aparecem duplicados na grade de anexos;
- a assinatura HTML é configurável por conta e é inserida automaticamente em mensagens novas, respostas e encaminhamentos;
- imagens dentro da assinatura são bloqueadas para reduzir superfície de abuso e rastreamento.

### Sanitização

A sanitização decisiva ocorre no Worker, mesmo que o navegador também faça uma limpeza preliminar ao colar conteúdo. Scripts, iframes, formulários, objetos, eventos `on*`, URLs `javascript:` e CSS fora da allowlist não são preservados. Links são normalizados com `noopener noreferrer`.

## Cache do PWA

O frontend usa cache-first para tornar a navegação e os assets instantâneos sem congelar atualizações do produto.

- navegações e recursos estáveis usam stale-while-revalidate: o cache responde imediatamente e a versão da rede atualiza o cache em segundo plano;
- assets gerados pelo Vite em `/assets/` usam cache-first, pois o hash do nome muda quando o conteúdo muda;
- `/sw.js` nunca é servido pelo próprio cache e o registro usa `updateViaCache: none`;
- `/api/*` nunca é interceptado pelo service worker;
- mensagens, sessões, contagens, estados de entrega e anexos continuam sempre dinâmicos.

## Alternância de contas

A alternância usa sessões independentes com cookies HttpOnly separados por conta.

- o chip com avatar, nome, e-mail e seta no topo direito é o seletor principal;
- cada nova conta precisa ser autenticada uma vez antes de ficar disponível para troca rápida;
- a senha e os tokens de sessão não são armazenados no `localStorage`;
- `Nova caixa`/alias pertence ao mesmo usuário e não cria um login separado;
- `Criar conta` no painel administrativo cria um usuário com login próprio.

## Chave mestra: não rotacionar às cegas

`MASTER_KEY_B64` protege as chaves de dados das mensagens armazenadas. Trocar a chave sem reempacotar as chaves de dados existentes torna as mensagens antigas ilegíveis.

1. Se só houver mensagens de teste e elas puderem ser descartadas, exclua os testes pelo próprio GTRZ Mail, confirme que não há conteúdo que precise ser preservado e então rode `npm run secret:rotate-master-key`.
2. Se houver qualquer mensagem que precise ser preservada, NÃO execute a rotação simples. Primeiro implemente/execute uma operação de rewrap das DEKs com a chave antiga e a nova em uma janela coordenada.
3. Nunca copie `MASTER_KEY_B64`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` ou `VAPID_PRIVATE_KEY` para issues, commits, logs ou conversas.

## DNS e entregabilidade

Execute:

```powershell
npm run dns:check
```

Se DMARC estiver ausente, use inicialmente uma política de observação e endureça depois de validar o tráfego legítimo.

```text
v=DMARC1; p=none; adkim=s; aspf=s
```

Depois de observar autenticação e reputação, migre gradualmente para `quarantine` e, por fim, `reject` se todo o tráfego legítimo estiver alinhado.

## Testes mínimos após deploy

1. Login e logout.
2. Abrir o seletor de contas e alternar entre duas contas autenticadas.
3. Abrir Configurações, criar uma assinatura formatada, salvar e reabrir.
4. Criar uma mensagem com negrito, itálico, sublinhado, lista, link, cor e destaque.
5. Colar uma imagem no corpo, enviar para Gmail e confirmar que ela aparece inline.
6. Abrir a mensagem em Enviados e confirmar que HTML e imagem inline são exibidos.
7. Criar um rascunho rico, fechar o composer, reabrir e confirmar preservação da formatação.
8. Receber um e-mail HTML externo e confirmar renderização sanitizada.
9. Abrir e baixar um anexo tradicional.
10. Responder uma mensagem e confirmar que a lista mostra uma única conversa com contador maior que 1.
11. Abrir a conversa e confirmar mensagens recebidas/enviadas agrupadas cronologicamente.
12. Responder a todos e encaminhar.
13. Arquivar, mover para lixeira, restaurar e excluir permanentemente.
14. Enviar mensagem e confirmar `sent → delivered` pelo webhook.
15. Em Configurações, clicar `Ativar notificações` e permitir notificações no navegador.
16. Fechar completamente o GTRZ Mail/PWA, enviar um e-mail externo para a conta e confirmar a notificação do sistema operacional.
17. Clicar na notificação e confirmar abertura/foco do GTRZ Mail e seleção da mensagem quando ela estiver na Entrada.
18. Reabrir o PWA e confirmar carregamento imediato pelo cache.

## Observações de segurança

- O R2 permanece privado.
- Texto, HTML de mensagem e anexos permanecem criptografados em nível de aplicação.
- Metadados necessários à busca, threading e roteamento ficam no D1 em texto claro.
- Endpoints e chaves públicas de inscrição Web Push ficam no D1; a chave VAPID privada fica somente como Worker secret.
- A assinatura é configuração de conta e fica no D1 já sanitizada.
- Sessões usam cookie `HttpOnly`, `Secure` e `SameSite=Strict`.
- Senhas usam PBKDF2-HMAC-SHA256 com 100.000 iterações por limitação atual do runtime usado pelo Worker.
- O painel administrativo só é exposto a usuários com `is_admin = 1`.
