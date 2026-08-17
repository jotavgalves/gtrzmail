# Rotação segura da chave mestra

O GTRZ Mail usa envelope encryption: cada mensagem possui uma DEK AES-256-GCM própria e a chave mestra (KEK) protege apenas essa DEK. A rotação segura troca o invólucro das DEKs; corpos, HTML, RFC822 e anexos no R2 não são recriptografados.

## Modelo de dois slots

- slot A: `MASTER_KEY_B64` (compatível com a instalação original);
- slot B: `MASTER_KEY_SLOT_B_B64`;
- `key_rotation_state` no D1 registra slot/versão ativos e, durante a rotação, slot/versão de destino;
- chaves de dados antigas sem prefixo são interpretadas como versão 1;
- novas DEKs embrulhadas usam `vN:<ciphertext>` no campo `messages.encrypted_key`.

Em estado estável somente um slot precisa existir. A cada rotação o script coloca a nova KEK no slot inativo, muda novas escritas para esse slot, reembrulha as DEKs existentes em lotes, verifica cada novo invólucro com AES-GCM, promove o slot novo e só então remove a KEK antiga.

## Rollout inicial

A migration e o Worker compatível precisam estar em produção antes da primeira rotação:

```powershell
cd C:\Users\CRIACAO\gtrzmail
git pull --ff-only
npm install
npm run db:migrate:remote
npm run deploy
```

A migration relevante é `0007_key_rotation.sql`.

## Executar a rotação

Depois do deploy acima:

```powershell
npm run secret:rotate-master-key
```

O comando:

1. gera um token operacional de 256 bits e o envia como `KEY_ROTATION_TOKEN` sem exibi-lo;
2. consulta o estado da rotação no Worker;
3. se estiver estável, gera uma nova KEK de 256 bits no processo e a envia diretamente ao slot inativo, sem imprimir nem gravar em arquivo;
4. coloca o D1 em `rewrapping`, fazendo novas mensagens usarem imediatamente a nova KEK;
5. reembrulha até 100 DEKs por chamada, mantendo a DEK original e criando novo IV AES-GCM;
6. valida que cada novo invólucro pode ser aberto pelo slot de destino antes de atualizar o D1;
7. só finaliza quando nenhuma mensagem continuar na versão anterior;
8. espera a expiração do cache de estado entre isolates;
9. remove o secret do slot aposentado e remove `KEY_ROTATION_TOKEN`.

Nenhuma chave é exibida no terminal.

## Interrupções

A operação é retomável. Se o processo, a rede ou o computador interromperem a rotação depois de `rewrapping` começar, **não apague nem altere manualmente** `MASTER_KEY_B64`, `MASTER_KEY_SLOT_B_B64` ou `KEY_ROTATION_TOKEN`.

Execute novamente:

```powershell
npm run secret:rotate-master-key
```

O script substitui apenas o token operacional e continua usando a KEK de destino que já está no Worker. Ele não sobrescreve o slot de destino enquanto existirem DEKs reembrulhadas por ele.

## Invariantes de segurança

- o slot antigo não é removido enquanto houver uma única mensagem que ainda dependa dele;
- novas mensagens não voltam a usar o slot antigo depois que a fase de rewrap começa;
- atualização concorrente de um rascunho não pode ser sobrescrita pelo batch: o UPDATE compara o `encrypted_key` que foi lido;
- AES-GCM autentica o invólucro e o Worker testa o novo invólucro antes de persistir a troca;
- anexos continuam legíveis porque usam a mesma DEK da mensagem;
- o token de rotação é temporário e não participa da criptografia dos dados;
- o valor das KEKs não deve aparecer em logs, issues, commits, conversas ou capturas de tela.
