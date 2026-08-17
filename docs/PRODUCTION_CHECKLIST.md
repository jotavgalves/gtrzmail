# GTRZ Mail — checklist de produção

## Estado funcional

O GTRZ Mail usa Cloudflare Worker + D1 + R2, Cloudflare Email Routing para entrada e Resend para saída. Antes de cada publicação de alterações de schema, aplique as migrations D1 primeiro e só então faça deploy do Worker.

## Publicar esta versão

Na máquina autorizada:

```powershell
git pull --ff-only
npm install
npm run db:migrate:remote
npm run build
npm run typecheck
npm run deploy:dry
npm run deploy
```

A migration `0002_product_features.sql` adiciona `users.is_admin`, promove a conta mais antiga existente a administradora e adiciona estado de restauração às mensagens.

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
2. Receber mensagem externa em `joao@gtrz.com.br`.
3. Abrir e baixar um anexo.
4. Responder e confirmar threading no destinatário.
5. Responder a todos.
6. Encaminhar.
7. Criar rascunho, fechar composer, reabrir e enviar.
8. Arquivar, mover para lixeira, restaurar e excluir permanentemente.
9. Enviar mensagem e confirmar `sent → delivered` pelo webhook.
10. Criar uma conta de teste pelo painel administrativo e fazer login nela.
11. Criar uma caixa adicional e confirmar envio. Para recebimento, a Cloudflare precisa ter uma regra compatível ou catch-all apontando para o Worker.
12. Ativar notificações e verificar badge de não lidas no PWA compatível.

## Observações de segurança

- O R2 permanece privado.
- Conteúdo de mensagem e anexos permanece criptografado em nível de aplicação.
- Metadados necessários à busca e roteamento ficam no D1 em texto claro.
- Sessões usam cookie `HttpOnly`, `Secure` e `SameSite=Strict`.
- Senhas usam PBKDF2-HMAC-SHA256 com 100.000 iterações por limitação atual do runtime usado pelo Worker.
- O painel administrativo só é exposto a usuários com `is_admin = 1`.
