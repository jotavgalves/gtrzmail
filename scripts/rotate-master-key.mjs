import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const secret = crypto.randomBytes(32).toString('base64');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

console.log('Gerando e enviando uma nova MASTER_KEY_B64 de 256 bits para o Worker...');
console.log('O valor não será exibido no terminal.');

const result = spawnSync(
  npx,
  ['wrangler', 'secret', 'put', 'MASTER_KEY_B64'],
  {
    input: `${secret}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8'
  }
);

if (result.error) {
  console.error('Não foi possível executar o Wrangler:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`O Wrangler terminou com código ${result.status ?? 'desconhecido'}.`);
  process.exit(result.status ?? 1);
}

console.log('MASTER_KEY_B64 substituída com sucesso sem expor o valor.');
