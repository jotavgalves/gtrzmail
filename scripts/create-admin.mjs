import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = readline.createInterface({ input, output });
const email = (await rl.question('E-mail do administrador: ')).trim().toLowerCase();
const displayName = (await rl.question('Nome exibido: ')).trim();
const mailbox = (await rl.question(`Caixa principal [${email}]: `)).trim() || email;
const password = await rl.question('Senha inicial: ');
rl.close();

if (!email.includes('@') || password.length < 12) {
  console.error('Use um e-mail válido e senha com no mínimo 12 caracteres.');
  process.exit(1);
}

const iterations = 100000;
const salt = crypto.randomBytes(32);
const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const userId = crypto.randomUUID();
const mailboxId = crypto.randomUUID();
const now = Math.floor(Date.now() / 1000);

const esc = (value) => value.replaceAll("'", "''");

console.log('\nExecute no D1 remoto:\n');
console.log(`INSERT INTO users (id,email,display_name,password_salt,password_hash,password_iterations,is_active,created_at) VALUES ('${userId}','${esc(email)}','${esc(displayName)}','${salt.toString('base64')}','${hash.toString('base64')}',${iterations},1,${now});`);
console.log(`INSERT INTO mailboxes (id,user_id,address,display_name,is_default,created_at) VALUES ('${mailboxId}','${userId}','${esc(mailbox.toLowerCase())}','${esc(displayName)}',1,${now});`);
console.log('\nExemplo: npx wrangler d1 execute gtrz-mail --remote --command "<SQL>"');
