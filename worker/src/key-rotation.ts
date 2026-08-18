import type { AppEnv } from './env';
import {
  constantTimeEqual,
  getKeyRotationState,
  invalidateKeyRotationStateCache,
  rewrapEncryptedDataKey,
  unwrapDataKey,
  type KeySlot
} from './crypto';
import { json } from './http';

const encoder = new TextEncoder();

type RotationRow = {
  active_slot: KeySlot;
  active_version: number;
  target_slot: KeySlot | null;
  target_version: number | null;
  phase: 'stable' | 'rewrapping';
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
};

type MessageKeyRow = {
  id: string;
  encrypted_key: string;
  key_iv: string;
};

function tokenAuthorized(request: Request, env: AppEnv): boolean {
  if (!env.KEY_ROTATION_TOKEN) return false;
  const authorization = request.headers.get('authorization') || '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!provided) return false;
  return constantTimeEqual(encoder.encode(provided), encoder.encode(env.KEY_ROTATION_TOKEN));
}

function slotConfigured(env: AppEnv, slot: KeySlot): boolean {
  return Boolean(slot === 'A' ? env.MASTER_KEY_B64 : env.MASTER_KEY_SLOT_B_B64);
}

async function stateRow(env: AppEnv): Promise<RotationRow> {
  const row = await env.DB.prepare(
    `SELECT active_slot, active_version, target_slot, target_version, phase,
            started_at, completed_at, updated_at
     FROM key_rotation_state WHERE id = 1 LIMIT 1`
  ).first<RotationRow>();
  if (!row) throw new Error('Key rotation state is missing. Apply database migrations first.');
  return row;
}

async function remainingCount(env: AppEnv, targetVersion: number | null): Promise<number> {
  if (targetVersion === null) return 0;
  const targetPrefix = `v${targetVersion}:%`;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM messages WHERE encrypted_key NOT LIKE ?'
  ).bind(targetPrefix).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function audit(env: AppEnv, action: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), action, 'key_rotation', targetId, Math.floor(Date.now() / 1000)).run();
}

export async function keyRotationStatus(request: Request, env: AppEnv): Promise<Response> {
  if (!tokenAuthorized(request, env)) return json({ error: 'Não autorizado.' }, 403);
  const row = await stateRow(env);
  const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first<{ count: number }>();
  const remaining = row.phase === 'rewrapping' ? await remainingCount(env, row.target_version) : 0;
  return json({
    ok: true,
    phase: row.phase,
    activeSlot: row.active_slot,
    activeVersion: Number(row.active_version),
    targetSlot: row.target_slot,
    targetVersion: row.target_version === null ? null : Number(row.target_version),
    totalMessages: Number(total?.count || 0),
    remainingMessages: remaining,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  });
}

export async function prepareKeyRotation(request: Request, env: AppEnv): Promise<Response> {
  if (!tokenAuthorized(request, env)) return json({ error: 'Não autorizado.' }, 403);
  const row = await stateRow(env);
  if (row.phase === 'rewrapping') {
    return keyRotationStatus(request, env);
  }

  const targetSlot: KeySlot = row.active_slot === 'A' ? 'B' : 'A';
  if (!slotConfigured(env, targetSlot)) {
    return json({ error: `O slot ${targetSlot} ainda não possui a nova chave.` }, 409);
  }

  const targetVersion = Number(row.active_version) + 1;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE key_rotation_state
     SET target_slot = ?, target_version = ?, phase = 'rewrapping', started_at = ?, completed_at = NULL, updated_at = ?
     WHERE id = 1 AND phase = 'stable'`
  ).bind(targetSlot, targetVersion, now, now).run();
  invalidateKeyRotationStateCache();
  await getKeyRotationState(env, true);
  await audit(env, 'crypto.key_rotation_started', `${row.active_version}->${targetVersion}`);
  return keyRotationStatus(request, env);
}

export async function rewrapKeyBatch(request: Request, env: AppEnv): Promise<Response> {
  if (!tokenAuthorized(request, env)) return json({ error: 'Não autorizado.' }, 403);
  const state = await getKeyRotationState(env, true);
  if (state.phase !== 'rewrapping' || state.targetVersion === null) {
    return json({ error: 'Nenhuma rotação está em andamento.' }, 409);
  }

  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || '100')));
  const targetPrefix = `v${state.targetVersion}:%`;
  const rows = await env.DB.prepare(
    `SELECT id, encrypted_key, key_iv
     FROM messages
     WHERE encrypted_key NOT LIKE ?
     ORDER BY id
     LIMIT ?`
  ).bind(targetPrefix, limit).all<MessageKeyRow>();

  if (!rows.results.length) {
    return json({ ok: true, processed: 0, remainingMessages: 0, targetVersion: state.targetVersion });
  }

  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const rewrapped = await rewrapEncryptedDataKey(row.encrypted_key, row.key_iv, env);
    // AES-GCM unwrap with the target slot must succeed before D1 is allowed to
    // forget the old wrapper. This verifies integrity and target-key usability.
    await unwrapDataKey(rewrapped.encryptedKey, rewrapped.keyIv, env);
    statements.push(
      env.DB.prepare(
        'UPDATE messages SET encrypted_key = ?, key_iv = ? WHERE id = ? AND encrypted_key = ?'
      ).bind(rewrapped.encryptedKey, rewrapped.keyIv, row.id, row.encrypted_key)
    );
  }
  await env.DB.batch(statements);

  const remaining = await remainingCount(env, state.targetVersion);
  return json({
    ok: true,
    processed: rows.results.length,
    remainingMessages: remaining,
    targetVersion: state.targetVersion
  });
}

export async function finalizeKeyRotation(request: Request, env: AppEnv): Promise<Response> {
  if (!tokenAuthorized(request, env)) return json({ error: 'Não autorizado.' }, 403);
  const row = await stateRow(env);
  if (row.phase !== 'rewrapping' || !row.target_slot || row.target_version === null) {
    return json({ error: 'Nenhuma rotação está pronta para finalizar.' }, 409);
  }

  const remaining = await remainingCount(env, row.target_version);
  if (remaining !== 0) {
    return json({ error: 'Ainda existem mensagens usando a chave anterior.', remainingMessages: remaining }, 409);
  }

  const oldSlot = row.active_slot;
  const oldVersion = Number(row.active_version);
  const newSlot = row.target_slot;
  const newVersion = Number(row.target_version);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE key_rotation_state
     SET active_slot = ?, active_version = ?, target_slot = NULL, target_version = NULL,
         phase = 'stable', completed_at = ?, updated_at = ?
     WHERE id = 1 AND phase = 'rewrapping'`
  ).bind(newSlot, newVersion, now, now).run();
  invalidateKeyRotationStateCache();
  await getKeyRotationState(env, true);
  await audit(env, 'crypto.key_rotation_completed', `${oldVersion}->${newVersion}`);

  return json({
    ok: true,
    phase: 'stable',
    activeSlot: newSlot,
    activeVersion: newVersion,
    retiredSlot: oldSlot,
    retiredVersion: oldVersion
  });
}
