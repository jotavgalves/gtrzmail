# Arquitetura

```text
Internet
   |
   | HTTPS / SMTP
   v
Cloudflare
   |
   +-- mail.gtrz.com.br ------------------------------+
   |                                                  |
   |                         Worker Static Assets     |
   |                         React PWA                |
   |                                                  |
   +-- Email Routing --> email() handler              |
                              |                       |
                              +--> PostalMime         |
                              +--> AES-256-GCM        |
                              |       |               |
                              |       +--> R2 privado |
                              |                       |
                              +--> D1 metadados       |
                                                      |
PWA --> /api/* --> Worker ----------------------------+
                    |
                    +--> autenticação/sessões D1
                    +--> R2 decrypt sob autorização
                    +--> Resend para saída
                    +--> webhook Resend para status
```

## Entrada

1. O MX do domínio continua no Cloudflare Email Routing.
2. A regra de `@gtrz.com.br` entrega a mensagem ao Worker `gtrz-mail`.
3. O `email()` handler recebe o RFC822 bruto.
4. `postal-mime` extrai remetente, destinatários, texto e anexos.
5. O e-mail bruto recebe uma chave de dados (DEK) aleatória e criptografia AES-256-GCM.
6. A DEK é criptografada com a chave mestra (KEK), guardada apenas como Worker Secret.
7. Conteúdo e anexos vão ao R2 privado.
8. D1 recebe metadados e referências dos objetos.

## Saída

1. O frontend envia a composição para `/api/messages/send`.
2. O Worker confirma sessão e que a caixa remetente pertence ao usuário.
3. A cópia de enviados é criptografada e persistida.
4. O Worker envia pelo Resend usando `RESEND_API_KEY`.
5. Eventos assinados do Resend atualizam `sent`, `delivered`, `delayed`, `bounced` ou `failed`.

## Privacidade

O frontend nunca acessa D1/R2 diretamente. Downloads de anexos passam pelo Worker, que valida a sessão antes de recuperar e descriptografar o objeto. O HTML recebido não é renderizado na primeira versão; apenas texto seguro é mostrado.
