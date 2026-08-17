import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ORIGIN = (process.env.GTRZ_MAIL_ORIGIN || 'https://mail.gtrz.com.br').replace(/\/+$/, '');
const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerBin = path.resolve(here, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const token = crypto.randomBytes(32).toString('base64url');

function runWrangler(args, input = undefined, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    input,
    stdio: input === undefined ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`Wrangler terminou com código ${result.status ?? 'desconhecido'}.`);
  return result.status === 0;
}

function putSecret(name, value) {
  runWrangler(['secret', 'put', name], `${value}\n`);
}

function deleteSecret(name, allowFailure = false) {
  return runWrangler(['secret', 'delete', name], 'y\n', { allowFailure });
}

function secretNameForSlot(slot) {
  return slot === 'A' ? 'MASTER_KEY_B64' : 'MASTER_KEY_SLOT_B_B64';
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function rotationRequest(pathname, method = 'GET') {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function waitForRotationApi() {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await rotationRequest('/api/internal/key-rotation/status');
    } catch (error) {
      lastError = error;
      await sleep(1500);
    }
  }
  throw new Error(`O Worker não respondeu ao endpoint seguro de rotação. Aplique a migration 0007 e faça deploy antes de rodar este comando. ${lastError?.message || ''}`.trim());
}

console.log('Rotação segura da chave mestra do GTRZ Mail.');
console.log('Nenhuma chave ou token será exibido no terminal.');
console.log('O corpo dos e-mails não será recriptografado; somente as DEKs serão reembrulhadas.');

try {
  // The bearer token is deliberately ephemeral. Re-running the command can replace
  // it even when a prior rotation was interrupted; it is not used to encrypt data.
  putSecret('KEY_ROTATION_TOKEN', token);
  await sleep(1800);

  let status = await waitForRotationApi();

  if (status.phase === 'stable') {
    const targetSlot = status.activeSlot === 'A' ? 'B' : 'A';
    const targetSecret = secretNameForSlot(targetSlot);

    // If the previous run completed but crashed before cleanup, the inactive slot
    // may still contain the retired key. It is safe to delete because D1 says the
    // other slot is the only active slot in stable phase.
    deleteSecret(targetSecret, true);

    const nextKey = crypto.randomBytes(32).toString('base64');
    putSecret(targetSecret, nextKey);
    await sleep(1800);

    status = await rotationRequest('/api/internal/key-rotation/prepare', 'POST');
    console.log(`Rotação iniciada: versão ${status.activeVersion} → ${status.targetVersion}.`);
  } else {
    console.log(`Retomando rotação interrompida para a versão ${status.targetVersion}.`);
  }

  let previousRemaining = Number.POSITIVE_INFINITY;
  let stalledRounds = 0;
  while (status.phase === 'rewrapping') {
    const batch = await rotationRequest('/api/internal/key-rotation/batch?limit=100', 'POST');
    const remaining = Number(batch.remainingMessages || 0);
    process.stdout.write(`\rDEKs reembrulhadas. Restantes: ${remaining}   `);

    if (remaining === 0) break;
    if (remaining >= previousRemaining) stalledRounds += 1;
    else stalledRounds = 0;
    if (stalledRounds >= 5) throw new Error('A rotação não está progredindo. O estado foi preservado; rode o comando novamente após investigar o Worker.');
    previousRemaining = remaining;
  }
  process.stdout.write('\n');

  const finalized = await rotationRequest('/api/internal/key-rotation/finalize', 'POST');
  console.log(`Versão ${finalized.activeVersion} ativada no slot ${finalized.activeSlot}.`);

  // Other Worker isolates may keep the prior rotation state in memory for at most
  // five seconds. Keep both secrets available for a conservative grace period.
  await sleep(12_000);
  const retiredSecret = secretNameForSlot(finalized.retiredSlot);
  deleteSecret(retiredSecret, true);
  deleteSecret('KEY_ROTATION_TOKEN', true);

  console.log('Rotação concluída. A chave antiga foi retirada dos secrets do Worker.');
  console.log('Mensagens e anexos existentes continuam usando as mesmas DEKs e permanecem legíveis.');
} catch (error) {
  console.error('\nA rotação não foi concluída:', error instanceof Error ? error.message : String(error));
  console.error('O estado foi deixado de forma retomável. NÃO apague MASTER_KEY_B64, MASTER_KEY_SLOT_B_B64 ou KEY_ROTATION_TOKEN manualmente.');
  console.error('Depois de corrigir a causa, execute novamente: npm run secret:rotate-master-key');
  process.exit(1);
}
