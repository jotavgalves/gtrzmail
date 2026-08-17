# GTRZ Mail — checklist de produção

## Estado funcional

O GTRZ Mail usa Cloudflare Worker + D1 + R2, Cloudflare Email Routing para entrada e Resend para saída.

As migrations devem ser aplicadas antes de publicar um Worker que dependa delas. O projeto atualmente possui migrations até `0007_key_rotation.sql`.

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
- a lista mostra apenas uma linha por thread dentro da pasta atual;
- a linha recebe contador quando a conversa contém mais de uma mensagem;
- mensagens antigas da conversa são buscadas sob demanda;
- respostas enviadas e mensagens recebidas podem aparecer juntas na mesma conversa;
- webhooks atuais do Resend alimentam `message_id` dos e-mails enviados quando o provedor disponibiliza esse campo.

## Web Push com o PWA fechado

- o navegador usa `PushManager` + Service Worker;
- inscrições são gravadas em D1 e associadas à conta autenticada;
- o Worker envia Web Push após a entrada ser persistida com sucesso;
- inscrições expiradas (`404`/`410` no push service) são removidas automaticamente;
- o Service Worker mostra a notificação mesmo sem uma aba do GTRZ Mail aberta;
- clicar na notificação foca uma janela existente ou abre o PWA e tenta selecionar a mensagem/thread recebida.

## Editor HTML e leitura rica

- compositor `contentEditable` com negrito, itálico, sublinhado, listas, alinhamento, links, cores e limpeza de formatação;
- imagens PNG/JPG/GIF/WebP podem ser inseridas no corpo e são transformadas em anexos inline CID;
- o e-mail mantém `text/plain` como fallback e HTML sanitizado;
- texto, HTML, RFC822 e anexos ficam criptografados no R2;
- assinatura HTML é configurável por conta;
- a sanitização decisiva ocorre no Worker.

## Agenda / contatos

- contatos persistentes por usuário no D1;
- nome, telefone opcional, notas e favorito;
- vários e-mails por contato, com rótulo e endereço principal;
- criar, editar e excluir;
- endereços recentes do histórico continuam disponíveis;
- autocomplete em `Para`, `Cc` e `Cco` no desktop e mobile.

## Cache do PWA

- navegações e recursos estáveis usam cache-first/stale-while-revalidate;
- assets Vite com hash usam cache-first;
- `/sw.js` não é servido pelo próprio cache;
- `/api/*` nunca é interceptado pelo Service Worker;
- mensagens, sessões, contagens, estados de entrega e anexos continuam dinâmicos.

## Alternância de contas

A alternância usa sessões independentes com cookies HttpOnly separados por conta. Senhas e tokens de sessão não são armazenados no `localStorage`.

## Rotação segura da chave mestra

A instalação original usa `MASTER_KEY_B64` como slot A. O sistema agora suporta dois slots de KEK e rewrap online das DEKs:

- slot A: `MASTER_KEY_B64`;
- slot B: `MASTER_KEY_SLOT_B_B64`;
- `0007_key_rotation.sql` cria o estado persistente da rotação;
- chaves antigas sem prefixo são versão 1;
- novos invólucros usam `vN:<ciphertext>` em `messages.encrypted_key`;
- durante a rotação, novas mensagens passam imediatamente a usar o slot novo;
- as DEKs existentes são reembrulhadas em lotes sem recriptografar corpo, HTML, RFC822 ou anexos;
- cada novo invólucro é testado com AES-GCM antes de substituir o antigo;
- a chave antiga só é removida dos Worker secrets depois que nenhuma mensagem depende dela.

Primeiro publique a migration e o Worker compatível:

```powershell
npm run db:migrate:remote
npm run deploy
```

Depois execute:

```powershell
npm run secret:rotate-master-key
```

O comando não imprime nem grava KEKs em arquivo e pode retomar uma rotação interrompida. Se houver falha depois do início do rewrap, **não apague manualmente** `MASTER_KEY_B64`, `MASTER_KEY_SLOT_B_B64` ou `KEY_ROTATION_TOKEN`; apenas corrija a causa e rode o comando novamente.

Detalhes: `docs/KEY_ROTATION.md`.

## DNS e entregabilidade

O domínio já foi validado com SPF, DKIM e DMARC passando em mensagem real recebida pelo Gmail. A política DMARC observada está em `p=REJECT; sp=REJECT`. O domínio `gtrz.com.br` também foi verificado no Google Postmaster Tools.

Para diagnóstico:

```powershell
npm run dns:check
```

Não reduza a política DMARC sem motivo operacional comprovado.

## Testes mínimos após deploy

1. Login e logout.
2. Alternar entre duas contas autenticadas.
3. Criar assinatura formatada.
4. Enviar HTML com imagem inline e anexo.
5. Reabrir Enviados e confirmar HTML/anexos.
6. Criar e reabrir rascunho.
7. Receber e-mail HTML externo.
8. Responder, responder a todos e encaminhar.
9. Confirmar uma única conversa/thread quando houver respostas relacionadas.
10. Arquivar, lixeira, restaurar e excluir permanentemente.
11. Confirmar `sent → delivered` pelo webhook.
12. Ativar Web Push, fechar totalmente o PWA e confirmar notificação.
13. Clicar na notificação e confirmar abertura da mensagem correta.
14. Criar, editar e excluir contato e testar autocomplete em `Para/Cc/Cco`.
15. Após uma rotação de KEK, abrir mensagem antiga e baixar anexo antigo para confirmar legibilidade.

## Observações de segurança

- O R2 permanece privado.
- Texto, HTML, RFC822 e anexos permanecem criptografados em nível de aplicação.
- Metadados necessários à busca, threading e roteamento ficam no D1 em texto claro.
- A DEK de cada mensagem é protegida por envelope encryption AES-256-GCM.
- A rotação troca apenas o invólucro da DEK; não altera o ciphertext dos conteúdos.
- Sessões usam cookie `HttpOnly`, `Secure` e `SameSite=Strict`.
- Senhas usam PBKDF2-HMAC-SHA256 com 100.000 iterações por limitação atual do runtime usado pelo Worker.
- O painel administrativo só é exposto a usuários com `is_admin = 1`.
