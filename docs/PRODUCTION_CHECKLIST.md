# GTRZ Mail — checklist de produção

## Estado funcional

O GTRZ Mail usa Cloudflare Worker + D1 + R2, Cloudflare Email Routing para entrada e Resend para saída.

A migration `0002_product_features.sql` já foi aplicada no D1 remoto. Ela adiciona `users.is_admin`, promove a conta mais antiga existente a administradora e adiciona estado de restauração às mensagens.

## Publicar uma versão sem migration pendente

Na máquina autorizada:

```powershell
cd C:\Users\CRIACAO\gtrzmail
git pull --ff-only
npm install
npm run build
npm run typecheck
npm run deploy:dry
npm run deploy
```

Se uma versão futura adicionar alteração de schema, aplique a migration D1 primeiro e só então publique o Worker que depende dela.

## Alternância de contas

A alternância usa sessões independentes com cookies HttpOnly separados por conta.

- o chip com avatar, nome, e-mail e seta no topo direito é o seletor principal;
- clicar no chip abre as contas autenticadas no navegador;
- cada nova conta precisa ser autenticada uma vez antes de ficar disponível para troca rápida;
- a senha e os tokens de sessão não são armazenados no `localStorage`;
- `Nova caixa`/alias pertence ao mesmo usuário e não cria um login separado;
- `Criar conta` no painel administrativo cria um usuário com login próprio;
- sair encerra a sessão da conta atualmente ativa.

## Chave mestra: não rotacionar às cegas

`MASTER_KEY_B64` protege as chaves de dados das mensagens armazenadas. Trocar a chave sem reempacotar as chaves de dados existentes torna as mensagens antigas ilegíveis.

Procedimento seguro para o estado atual do projeto:

1. Se só houver mensagens de teste e elas puderem ser descartadas, exclua os testes pelo próprio GTRZ Mail, confirme que não há conteúdo que precise ser preservado e então rode `npm run secret:rotate-master-key`.
2. Se houver qualquer mensagem que precise ser preservada, NÃO execute a rotação simples. Primeiro implemente/execute uma operação de rewrap das DEKs com a chave antiga e a nova em uma janela coordenada.
3. Nunca copie `MASTER_KEY_B64`, `RESEND_API_KEY` ou `RESEND_WEBHOOK_SECRET` para issues, commits, logs ou conversas.

## DNS e entregabilidade

Execute:

```powershell
npm run dns:check
```

O script verifica publicamente SPF, DKIM do Resend, DMARC e MX. Se DMARC estiver ausente, use inicialmente uma política de observação e endureça depois de validar o tráfego legítimo.

Ponto de partida conservador:

```text
v=DMARC1; p=none; adkim=s; aspf=s
```

Depois de observar autenticação e reputação, migre gradualmente para `quarantine` e, por fim, `reject` se todo o tráfego legítimo estiver alinhado.

## Testes mínimos após deploy

1. Login e logout.
2. Clicar no chip da conta no topo e abrir o menu.
3. Adicionar uma segunda conta e alternar entre as duas sem redigitar senha durante a validade das sessões.
4. Receber mensagem externa em uma caixa configurada.
5. Abrir e baixar um anexo.
6. Responder e confirmar threading no destinatário.
7. Responder a todos.
8. Encaminhar.
9. Criar rascunho, fechar composer, reabrir e enviar.
10. Arquivar, mover para lixeira, restaurar e excluir permanentemente.
11. Enviar mensagem e confirmar `sent → delivered` pelo webhook.
12. Criar uma conta de teste pelo painel administrativo e fazer login nela.
13. Criar uma caixa adicional e confirmar envio. Para recebimento, a Cloudflare precisa ter uma regra compatível ou catch-all apontando para o Worker.
14. Ativar notificações e verificar badge de não lidas no PWA compatível.

## Observações de segurança

- O R2 permanece privado.
- Conteúdo de mensagem e anexos permanece criptografado em nível de aplicação.
- Metadados necessários à busca e roteamento ficam no D1 em texto claro.
- Sessões usam cookie `HttpOnly`, `Secure` e `SameSite=Strict`.
- Senhas usam PBKDF2-HMAC-SHA256 com 100.000 iterações por limitação atual do runtime usado pelo Worker.
- O painel administrativo só é exposto a usuários com `is_admin = 1`.
