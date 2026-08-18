import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerBin = path.resolve(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

console.log('\nAtualizando a senha diretamente no D1 remoto...');
console.log('Salt, hash e senha não serão exibidos.');

const result = spawnSync(
  process.execPath,
  [wranglerBin, 'd1', 'execute', 'gtrz-mail', '--remote', '--command', sql],
  { stdio: 'inherit' }
);

if (result.error) {
  console.error('Não foi possível executar o Wrangler:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`O Wrangler terminou com código ${result.status ?? 'desconhecido'}.`);
  process.exit(result.status ?? 1);
}

console.log(`Senha de ${email} atualizada com PBKDF2 (${PBKDF2_ITERATIONS} iterações).`);
console.log('Sessões anteriores dessa conta foram invalidadas.');
