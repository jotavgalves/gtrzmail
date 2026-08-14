import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const secret = crypto.randomBytes(32).toString('base64');
const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerBin = path.resolve(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

console.log('Gerando e enviando uma nova MASTER_KEY_B64 de 256 bits para o Worker...');
console.log('O valor não será exibido no terminal.');

const result = spawnSync(
  process.execPath,
  [wranglerBin, 'secret', 'put', 'MASTER_KEY_B64'],
  {
    input: `${secret}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
    windowsHide: true
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
