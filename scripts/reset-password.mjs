import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const PBKDF2_ITERATIONS = 100000;
const rl = readline.createInterface({ input, output });
const email = (await rl.question('E-mail da conta: ')).trim().toLowerCase();
const password = await rl.question('Nova senha: ');
rl.close();

if (!email.includes('@') || password.length < 12) {
  console.error('Use um e-mail válido e senha com no mínimo 12 caracteres.');
  process.exit(1);
}

const salt = crypto.randomBytes(32);
const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
const esc = (value) => value.replaceAll("'", "''");
const safeEmail = esc(email);
const sql = `UPDATE users SET password_salt='${salt.toString('base64')}', password_hash='${hash.toString('base64')}', password_iterations=${PBKDF2_ITERATIONS} WHERE email='${safeEmail}'; DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email='${safeEmail}');`;

console.log('\nExecute este comando no PowerShell para atualizar a senha no D1 remoto:\n');
console.log(`npx wrangler d1 execute gtrz-mail --remote --command "${sql}"`);
console.log('\nA senha não aparece no comando; somente salt e hash derivados são gravados no D1.');
