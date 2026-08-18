import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerBin = path.resolve(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const value = (process.argv[2] || '').trim();

function run(command) {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, 'd1', 'execute', 'gtrz-mail', '--remote', '--command', command],
    { stdio: 'inherit', windowsHide: true }
  );
  if (result.error) {
    console.error('Não foi possível executar o Wrangler:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!value) {
  console.log('IPs atualmente bloqueados no GTRZ Mail:\n');
  run(`SELECT ip_address AS ip,
              datetime(blocked_at, 'unixepoch') AS bloqueado_em,
              last_email AS ultima_conta,
              substr(ip_hash, 1, 12) AS referencia
       FROM auth_ip_security
       WHERE permanently_blocked = 1
       ORDER BY blocked_at DESC
       LIMIT 250;`);
  console.log('\nPara desbloquear: npm run auth:unblock-ip -- <IP-ou-hash>');
  process.exit(0);
}

const hash = /^[a-f0-9]{64}$/i.test(value)
  ? value.toLowerCase()
  : crypto.createHash('sha256').update(`gtrz-auth-ip:${value}`).digest('hex');

console.log(`Removendo o bloqueio da referência ${hash.slice(0, 12)}...`);
run(`DELETE FROM auth_ip_security WHERE ip_hash = '${hash}' AND permanently_blocked = 1;`);
console.log('Comando concluído. Se o IP estava bloqueado, o acesso foi liberado.');
