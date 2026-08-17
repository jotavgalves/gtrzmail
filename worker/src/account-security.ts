import type { AppEnv, SessionUser } from './env';
import { changePassword, getSessionUser } from './auth';
import { json } from './http';
import { randomToken, sha256Hex } from './crypto';

const COOKIE_NAME = 'gtrz_session';
const ACCOUNT_COOKIE_PREFIX = 'gtrz_account_';
const IDLE_TIMEOUT_SECONDS = 12 * 60 * 60;

function cookieEntries(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    try { result.set(key, decodeURIComponent(rest.join('='))); }
    catch { result.set(key, rest.join('=')); }
  }
  return result;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

async function currentSessionId(request: Request): Promise<string | null> {
  const token = cookieEntries(request).get(COOKIE_NAME);
  return token ? sha256Hex(token) : null;
}

async function audit(env: AppEnv, userId: string, action: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, 'session', targetId, Math.floor(Date.now() / 1000)).run();
}

/**
 * Enforces absolute expiry in the base auth layer plus a 12h idle timeout here.
 * A session is also bound to the original browser user-agent. IP changes are not
 * blocked because mobile networks legitimately rotate addresses, but are audited.
 */
export async function getSessionUserHardened(request: Request, env: AppEnv): Promise<SessionUser | null> {
  const id = await currentSessionId(request);
  if (!id) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT user_id, last_seen_at, user_agent, ip_fingerprint FROM sessions WHERE id = ? AND expires_at > ? LIMIT 1'
  ).bind(id, now).first<{ user_id: string; last_seen_at: number; user_agent: string | null; ip_fingerprint: string | null }>();
  if (!row) return null;

  if (row.last_seen_at <= now - IDLE_TIMEOUT_SECONDS) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    await audit(env, row.user_id, 'auth.session_idle_expired', id.slice(0, 16));
    return null;
  }

  const currentUserAgent = (request.headers.get('user-agent') || '').slice(0, 300);
  const originalUserAgent = row.user_agent || '';
  if (originalUserAgent && currentUserAgent && originalUserAgent !== currentUserAgent) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    await audit(env, row.user_id, 'auth.session_user_agent_mismatch_revoked', id.slice(0, 16));
    return null;
  }

  const currentIp = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 24);
  if (row.ip_fingerprint && currentIp !== row.ip_fingerprint) {
    await env.DB.prepare('UPDATE sessions SET ip_fingerprint = ? WHERE id = ?').bind(currentIp, id).run();
    await audit(env, row.user_id, 'auth.session_network_changed', id.slice(0, 16));
  }

  return getSessionUser(request, env);
}

export async function listUserSessions(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const currentId = await currentSessionId(request);
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip_fingerprint
     FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`
  ).bind(user.id, now).all<{
    id: string; created_at: number; last_seen_at: number; expires_at: number;
    user_agent: string | null; ip_fingerprint: string | null;
  }>();
  return json({ sessions: rows.results.map((row) => ({
    id: row.id,
    current: row.id === currentId,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent || 'Dispositivo desconhecido',
    ipFingerprint: row.ip_fingerprint ? row.ip_fingerprint.slice(0, 8) : null
  })) });
}

export async function revokeUserSession(request: Request, env: AppEnv, user: SessionUser, sessionId: string): Promise<Response> {
  const currentId = await currentSessionId(request);
  if (currentId && sessionId === currentId) return json({ error: 'Use Sair para encerrar a sessão atual.' }, 400);
  const result = await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(sessionId, user.id).run();
  if (!result.meta.changes) return json({ error: 'Sessão não encontrada.' }, 404);
  await audit(env, user.id, 'auth.session_revoked', sessionId.slice(0, 16));
  return json({ ok: true });
}

export async function revokeOtherSessions(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const currentId = await currentSessionId(request);
  if (!currentId) return json({ error: 'Sessão atual não encontrada.' }, 401);
  const result = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(user.id, currentId).run();
  await audit(env, user.id, 'auth.other_sessions_revoked', currentId.slice(0, 16));
  return json({ ok: true, revoked: Number(result.meta.changes || 0) });
}

export async function changePasswordHardened(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const original = await changePassword(request, env, user);
  if (!original.ok) return original;

  const cookies = cookieEntries(request);
  const oldToken = cookies.get(COOKIE_NAME);
  if (!oldToken) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true, sessionsRevoked: true });
  }

  const oldId = await sha256Hex(oldToken);
  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ? AND user_id = ? LIMIT 1')
    .bind(oldId, user.id).first<{ expires_at: number }>();
  if (!session) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true, sessionsRevoked: true });
  }

  const newToken = randomToken(32);
  const newId = await sha256Hex(newToken);
  const remaining = Math.max(1, session.expires_at - now);
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
  const ipFingerprint = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 24);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(user.id, oldId),
    env.DB.prepare('UPDATE sessions SET id = ?, last_seen_at = ?, reauthenticated_at = ?, user_agent = ?, ip_fingerprint = ? WHERE id = ? AND user_id = ?')
      .bind(newId, now, now, userAgent, ipFingerprint, oldId, user.id),
    env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), user.id, 'auth.session_rotated_after_password_change', 'session', newId.slice(0, 16), now)
  ]);

  const headers = new Headers();
  headers.append('set-cookie', secureCookie(COOKIE_NAME, newToken, remaining));
  headers.append('set-cookie', secureCookie(`${ACCOUNT_COOKIE_PREFIX}${user.id}`, newToken, remaining));
  return json({ ok: true, sessionsRevoked: true, sessionRotated: true }, 200, headers);
}
