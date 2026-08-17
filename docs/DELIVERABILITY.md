# GTRZ Mail — Entregabilidade

## Estado validado em produção

Uma mensagem real enviada por `gtrz.com.br` e recebida pelo Gmail foi validada pelos cabeçalhos `Authentication-Results` do próprio Gmail:

- SPF: `pass`
- DKIM: `pass`, assinatura alinhada com `d=gtrz.com.br`, selector `resend`
- DMARC: `pass`
- política DMARC observada pelo Gmail: `p=REJECT`, `sp=REJECT`
- transporte até o Gmail: TLS 1.3
- Return-Path: subdomínio `send.gtrz.com.br`

Conclusão: não reduzir a política DMARC para `none` ou `quarantine`. A política atual já é de enforcement máximo e o fluxo legítimo do GTRZ Mail passa na autenticação.

## Verificação local

```powershell
npm run dns:check
```

O diagnóstico consulta SPF, DMARC, DKIM do Resend e MX públicos. O teste deve ser repetido após qualquer alteração de DNS, Resend ou Email Routing.

## Google Postmaster Tools

O Postmaster Tools depende de uma Conta Google e de um TXT de verificação gerado especificamente pelo Google. Esse TXT não deve ser inventado nem armazenado no repositório.

Procedimento:

1. Entrar no Google Postmaster Tools com a Conta Google que administrará o domínio.
2. Adicionar `gtrz.com.br` como domínio de envio.
3. Copiar exatamente o TXT de verificação exibido pelo Google.
4. Criar esse TXT no DNS autoritativo de `gtrz.com.br`.
5. Voltar ao Postmaster Tools e concluir a verificação.
6. Monitorar reputação do domínio, autenticação, taxa de spam e erros de entrega.

Em domínios com pouco volume, alguns painéis podem permanecer sem dados por limiares de privacidade do Google. Isso não significa falha de configuração.

## Regras operacionais

- Não enviar testes repetitivos com assuntos/corpos aleatórios em grande volume.
- Preservar o DKIM do domínio e o Return-Path configurado no Resend.
- Não criar um segundo registro SPF no mesmo hostname.
- Não alterar `_dmarc.gtrz.com.br` sem validar primeiro SPF/DKIM/alinhamento em uma mensagem real.
- Se o GTRZ Mail passar a enviar marketing/assinaturas em grande volume, implementar `List-Unsubscribe` e cancelamento com um clique antes de usar esse fluxo para campanhas.
