import type { AppEnv, SessionUser } from './env';
import { bytesToBase64 } from './crypto';
import { json, readJson } from './http';

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;

function requireAdmin(user: SessionUser): Response | null {
  return user.isAdmin ? null : json({ error: 'Acesso restrito ao administrador.' }, 403);
}

function normalizeDomainEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@gtrz\.com\.br$/i.test(email)) return null;
  return email;
}

async function passwordHash(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt,
    iterations: PBKDF2_ITERATIONS,
    hash: 'SHA-256'
  }, material, 256));
  return { salt: bytesToBase64(salt), hash: bytesToBase64(derived) };
}

async function audit(env: AppEnv, userId: string, action: string, targetType: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, targetType, targetId, Math.floor(Date.now() / 1000)).run();
}

export async function listAccounts(env: AppEnv, user: SessionUser): Promise<Response> {
  const denied = requireAdmin(user);
  if (denied) return denied;

  const [users, mailboxes] = await Promise.all([
    env.DB.prepare(
      'SELECT id, email, display_name, is_active, is_admin, created_at FROM users ORDER BY created_at ASC'
    ).all<{ id: string; email: string; display_name: string; is_active: number; is_admin: number; created_at: number }>(),
    env.DB.prepare(
      'SELECT id, user_id, address, display_name, is_default FROM mailboxes ORDER BY is_default DESC, address ASC'
    ).all<{ id: string; user_id: string; address: string; display_name: string; is_default: number }>()
  ]);

  return json({
    accounts: users.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      isActive: row.is_active === 1,
      isAdmin: row.is_admin === 1,
      createdAt: row.created_at,
      mailboxes: mailboxes.results
        .filter((mailbox) => mailbox.user_id === row.id)
        .map((mailbox) => ({
          id: mailbox.id,
          address: mailbox.address,
          displayName: mailbox.display_name,
          isDefault: mailbox.is_default === 1
        }))
    }))
  });
}

export async function createAccount(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let payload: { email?: string; displayName?: string; password?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }

  const email = normalizeDomainEmail(payload.email || '');
  const displayName = (payload.displayName || '').trim().slice(0, 120);
  const password = payload.password || '';
  if (!email) return json({ error: 'Use um endereço @gtrz.com.br válido.' }, 400);
  if (!displayName) return json({ error: 'Informe o nome exibido.' }, 400);
  if (password.length < 12) return json({ error: 'A senha precisa ter pelo menos 12 caracteres.' }, 400);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>();
  if (exists) return json({ error: 'Já existe uma conta com esse e-mail.' }, 409);

  const credentials = await passwordHash(password);
  const userId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id,email,display_name,password_salt,password_hash,password_iterations,is_active,created_at,is_admin) VALUES (?,?,?,?,?,?,1,?,0)'
    ).bind(userId, email, displayName, credentials.salt, credentials.hash, PBKDF2_ITERATIONS, now),
    env.DB.prepare(
      'INSERT INTO mailboxes (id,user_id,address,display_name,is_default,created_at) VALUES (?,?,?,?,1,?)'
    ).bind(mailboxId, userId, email, displayName, now)
  ]);

  await audit(env, user.id, 'admin.account_created', 'user', userId);
  return json({ ok: true, id: userId, mailboxId }, 201);
}

export async function addMailbox(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let payload: { userId?: string; address?: string; displayName?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }

  const address = normalizeDomainEmail(payload.address || '');
  const displayName = (payload.displayName || '').trim().slice(0, 120);
  if (!payload.userId || !address || !displayName) return json({ error: 'Informe conta, endereço e nome exibido.' }, 400);

  const owner = await env.DB.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').bind(payload.userId).first<{ id: string }>();
  if (!owner) return json({ error: 'Conta não encontrada.' }, 404);
  const exists = await env.DB.prepare('SELECT id FROM mailboxes WHERE address = ? LIMIT 1').bind(address).first<{ id: string }>();
  if (exists) return json({ error: 'Esse endereço já está em uso.' }, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO mailboxes (id,user_id,address,display_name,is_default,created_at) VALUES (?,?,?,?,0,?)'
  ).bind(id, payload.userId, address, displayName, Math.floor(Date.now() / 1000)).run();
  await audit(env, user.id, 'admin.mailbox_created', 'mailbox', id);
  return json({ ok: true, id }, 201);
}

export async function setAccountStatus(request: Request, env: AppEnv, user: SessionUser, targetId: string): Promise<Response> {
  const denied = requireAdmin(user);
  if (denied) return denied;
  if (targetId === user.id) return json({ error: 'Você não pode desativar sua própria conta.' }, 400);

  let payload: { active?: boolean };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }
  const active = payload.active !== false;
  const result = await env.DB.prepare('UPDATE users SET is_active = ? WHERE id = ?').bind(active ? 1 : 0, targetId).run();
  if (!result.meta.changes) return json({ error: 'Conta não encontrada.' }, 404);
  if (!active) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run();
  await audit(env, user.id, active ? 'admin.account_enabled' : 'admin.account_disabled', 'user', targetId);
  return json({ ok: true });
}

export async function resetAccountPassword(request: Request, env: AppEnv, user: SessionUser, targetId: string): Promise<Response> {
  const denied = requireAdmin(user);
  if (denied) return denied;

  let payload: { password?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }
  const password = payload.password || '';
  if (password.length < 12) return json({ error: 'A senha precisa ter pelo menos 12 caracteres.' }, 400);

  const credentials = await passwordHash(password);
  const result = await env.DB.prepare(
    'UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ? WHERE id = ?'
  ).bind(credentials.salt, credentials.hash, PBKDF2_ITERATIONS, targetId).run();
  if (!result.meta.changes) return json({ error: 'Conta não encontrada.' }, 404);
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run();
  await audit(env, user.id, 'admin.password_reset', 'user', targetId);
  return json({ ok: true });
}
