import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateVAPIDKeys } from 'web-push-neo';

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerBin = path.resolve(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const force = process.argv.includes('--force');

function wrangler(args, input) {
  return spawnSync(process.execPath, [wranglerBin, ...args], {
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'inherit'] : ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
    windowsHide: true
  });
}

const listed = wrangler(['secret', 'list', '--format', 'json']);
if (listed.error) {
  console.error('Não foi possível consultar os secrets do Worker:', listed.error.message);
  process.exit(1);
}
if (listed.status !== 0) process.exit(listed.status ?? 1);

let names = [];
try {
  names = JSON.parse(listed.stdout || '[]').map((item) => item?.name).filter(Boolean);
} catch {
  console.error('Não foi possível interpretar a lista de secrets do Wrangler.');
  process.exit(1);
}

const alreadyConfigured = names.includes('VAPID_PUBLIC_KEY') && names.includes('VAPID_PRIVATE_KEY');
if (alreadyConfigured && !force) {
  console.log('Web Push já possui VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no Worker. Nenhuma chave foi alterada.');
  console.log('Use --force somente se quiser invalidar todas as inscrições push existentes e gerar um novo par.');
  process.exit(0);
}

if ((names.includes('VAPID_PUBLIC_KEY') || names.includes('VAPID_PRIVATE_KEY')) && !force) {
  console.error('Existe apenas uma das chaves VAPID. Corrija o estado antes de continuar ou execute com --force conscientemente.');
  process.exit(1);
}

console.log('Gerando um par VAPID e enviando os valores ao Worker sem exibi-los no terminal...');
const keys = await generateVAPIDKeys();

for (const [name, value] of [
  ['VAPID_PUBLIC_KEY', keys.publicKey],
  ['VAPID_PRIVATE_KEY', keys.privateKey]
]) {
  const result = wrangler(['secret', 'put', name], `${value}\n`);
  if (result.error) {
    console.error(`Falha ao executar Wrangler para ${name}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('Web Push configurado. As chaves não foram exibidas nem gravadas em arquivo local.');
