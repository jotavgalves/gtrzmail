import type { AppEnv, SessionUser } from './env';
import { base64ToBytes, bytesToBase64, constantTimeEqual, randomToken, sha256Hex } from './crypto';
import { json, readJson } from './http';

const encoder = new TextEncoder();
const COOKIE_NAME = 'gtrz_session';
const ACCOUNT_COOKIE_PREFIX = 'gtrz_account_';
const MAX_PBKDF2_ITERATIONS = 100000;
const SESSION_HEARTBEAT_SECONDS = 5 * 60;

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  is_active: number;
  is_admin: number;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  is_admin: number;
  expires_at: number;
  last_seen_at: number;
};

function cookieEntries(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    try {
      result.set(key, decodeURIComponent(rest.join('=')));
    } catch {
      result.set(key, rest.join('='));
    }
  }
  return result;
}

function cookieValue(request: Request, name: string): string | null {
  return cookieEntries(request).get(name) || null;
}

function accountCookieName(userId: string): string {
  return `${ACCOUNT_COOKIE_PREFIX}${userId}`;
}

function sessionMaxAge(env: AppEnv): number {
  const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS || '7')));
  return days * 86400;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

async function sessionForToken(env: AppEnv, token: string, now = Math.floor(Date.now() / 1000)): Promise<SessionRow | null> {
  const sessionId = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.expires_at, s.last_seen_at, u.email, u.display_name, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.is_active = 1 LIMIT 1`
  ).bind(sessionId, now).first<SessionRow>();
}

function sessionUser(row: SessionRow): SessionUser {
  return {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1
  };
}

async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
  if (!Number.isInteger(user.password_iterations) || user.password_iterations < 1 || user.password_iterations > MAX_PBKDF2_ITERATIONS) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'auth.password_hash_unsupported',
      userId: user.id,
      iterations: user.password_iterations,
      maxSupportedIterations: MAX_PBKDF2_ITERATIONS
    }));
    return false;
  }

  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: base64ToBytes(user.password_salt),
        iterations: user.password_iterations,
        hash: 'SHA-256'
      },
      material,
      256
    )
  );
  return constantTimeEqual(derived, base64ToBytes(user.password_hash));
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt,
    iterations: MAX_PBKDF2_ITERATIONS,
    hash: 'SHA-256'
  }, material, 256));
  return { salt: bytesToBase64(salt), hash: bytesToBase64(derived) };
}

async function rateKey(request: Request, email: string): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256Hex(`${email.toLowerCase()}|${ip}`);
}

async function isRateLimited(env: AppEnv, key: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT attempts, window_started_at, blocked_until FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<{ attempts: number; window_started_at: number; blocked_until: number }>();
  return Boolean(row && row.blocked_until > now);
}

async function recordFailure(env: AppEnv, key: string, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT attempts, window_started_at FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<{ attempts: number; window_started_at: number }>();
  const windowSeconds = 15 * 60;
  const withinWindow = row && now - row.window_started_at < windowSeconds;
  const attempts = withinWindow ? row.attempts + 1 : 1;
  const started = withinWindow ? row.window_started_at : now;
  const blockedUntil = attempts >= 5 ? now + windowSeconds : 0;

  await env.DB.prepare(
    'INSERT INTO login_attempts (key, attempts, window_started_at, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts, window_started_at=excluded.window_started_at, blocked_until=excluded.blocked_until'
  ).bind(key, attempts, started, blockedUntil).run();
}

export async function login(request: Request, env: AppEnv): Promise<Response> {
  let payload: { email?: string; password?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Requisição inválida.' }, 400);
  }

  const email = payload.email?.trim().toLowerCase() || '';
  const password = payload.password || '';
  if (!email || !password) return json({ error: 'Informe e-mail e senha.' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const key = await rateKey(request, email);
  if (await isRateLimited(env, key, now)) return json({ error: 'Muitas tentativas. Tente novamente mais tarde.' }, 429);

  const user = await env.DB.prepare(
    'SELECT id, email, display_name, password_salt, password_hash, password_iterations, is_active, is_admin FROM users WHERE email = ? LIMIT 1'
  ).bind(email).first<UserRow>();

  const valid = user && user.is_active === 1 ? await verifyPassword(password, user) : false;
  if (!user || !valid) {
    await recordFailure(env, key, now);
    return json({ error: 'Credenciais inválidas.' }, 401);
  }

  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();

  const token = randomToken(32);
  const sessionId = await sha256Hex(token);
  const maxAge = sessionMaxAge(env);
  const ipFingerprint = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 24);

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, user_agent, ip_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(sessionId, user.id, now + maxAge, now, now, (request.headers.get('user-agent') || '').slice(0, 300), ipFingerprint).run();

  await env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, 'auth.login', 'user', user.id, now).run();

  const headers = new Headers();
  headers.append('set-cookie', secureCookie(COOKIE_NAME, token, maxAge));
  headers.append('set-cookie', secureCookie(accountCookieName(user.id), token, maxAge));

  return json(
    { user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin === 1 } },
    200,
    headers
  );
}

export async function getSessionUser(request: Request, env: AppEnv): Promise<SessionUser | null> {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await sessionForToken(env, token, now);
  if (!row) return null;

  // Avoid turning every API read into a D1 write. A five-minute heartbeat is
  // sufficient for diagnostics while dramatically reducing request latency.
  if (row.last_seen_at <= now - SESSION_HEARTBEAT_SECONDS) {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.session_id).run();
  }
  return sessionUser(row);
}

export async function sessionResponse(request: Request, env: AppEnv): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ user: null }, 401);
  const mailboxes = await env.DB.prepare('SELECT id, address, display_name, is_default FROM mailboxes WHERE user_id = ? ORDER BY is_default DESC, address ASC')
    .bind(user.id)
    .all<{ id: string; address: string; display_name: string; is_default: number }>();

  const headers = new Headers();
  const token = cookieValue(request, COOKIE_NAME);
  if (token) headers.append('set-cookie', secureCookie(accountCookieName(user.id), token, sessionMaxAge(env)));
  return json({ user, mailboxes: mailboxes.results }, 200, headers);
}

export async function listSessionAccounts(request: Request, env: AppEnv, currentUser: SessionUser): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const cookies = cookieEntries(request);
  const accounts = new Map<string, SessionUser>();

  const currentToken = cookies.get(COOKIE_NAME);
  if (currentToken) {
    const currentRow = await sessionForToken(env, currentToken, now);
    if (currentRow) accounts.set(currentRow.user_id, sessionUser(currentRow));
  }

  for (const [name, token] of cookies.entries()) {
    if (!name.startsWith(ACCOUNT_COOKIE_PREFIX) || !token) continue;
    const row = await sessionForToken(env, token, now);
    if (!row) continue;
    accounts.set(row.user_id, sessionUser(row));
  }

  return json({
    accounts: [...accounts.values()]
      .map((account) => ({ ...account, current: account.id === currentUser.id }))
      .sort((a, b) => Number(b.current) - Number(a.current) || a.email.localeCompare(b.email))
  });
}

export async function switchAccount(request: Request, env: AppEnv, currentUser: SessionUser): Promise<Response> {
  let payload: { userId?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }
  const userId = payload.userId?.trim() || '';
  if (!userId) return json({ error: 'Informe a conta.' }, 400);
  const token = cookieValue(request, accountCookieName(userId));
  if (!token) return json({ error: 'Essa conta ainda não foi autenticada neste navegador.' }, 401);

  const now = Math.floor(Date.now() / 1000);
  const row = await sessionForToken(env, token, now);
  if (!row || row.user_id !== userId) return json({ error: 'A sessão dessa conta expirou. Entre novamente.' }, 401);

  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, row.session_id).run();
  await env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), currentUser.id, 'auth.account_switched', 'user', row.user_id, now).run();

  const remaining = Math.max(1, row.expires_at - now);
  return json(
    { ok: true, user: sessionUser(row) },
    200,
    { 'set-cookie': secureCookie(COOKIE_NAME, token, remaining) }
  );
}

export async function changePassword(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: { currentPassword?: string; newPassword?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Dados inválidos.' }, 400);
  }
  const currentPassword = payload.currentPassword || '';
  const newPassword = payload.newPassword || '';
  if (newPassword.length < 12) return json({ error: 'A nova senha precisa ter pelo menos 12 caracteres.' }, 400);

  const row = await env.DB.prepare(
    'SELECT id, email, display_name, password_salt, password_hash, password_iterations, is_active, is_admin FROM users WHERE id = ? LIMIT 1'
  ).bind(user.id).first<UserRow>();
  if (!row || !(await verifyPassword(currentPassword, row))) return json({ error: 'Senha atual incorreta.' }, 401);

  const credentials = await hashPassword(newPassword);
  await env.DB.prepare(
    'UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ? WHERE id = ?'
  ).bind(credentials.salt, credentials.hash, MAX_PBKDF2_ITERATIONS, user.id).run();
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), user.id, 'auth.password_changed', 'user', user.id, Math.floor(Date.now() / 1000)).run();
  return json({ ok: true });
}

export async function logout(request: Request, env: AppEnv): Promise<Response> {
  const token = cookieValue(request, COOKIE_NAME);
  let userId: string | null = null;
  if (token) {
    const row = await sessionForToken(env, token);
    userId = row?.user_id || null;
    const id = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  }

  const headers = new Headers();
  headers.append('set-cookie', clearCookie(COOKIE_NAME));
  if (userId) headers.append('set-cookie', clearCookie(accountCookieName(userId)));
  return json({ ok: true }, 200, headers);
}
