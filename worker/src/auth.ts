import type { AppEnv, SessionUser } from './env';
import { base64ToBytes, constantTimeEqual, randomToken, sha256Hex } from './crypto';
import { json, readJson } from './http';

const encoder = new TextEncoder();
const COOKIE_NAME = 'gtrz_session';
const MAX_PBKDF2_ITERATIONS = 100000;

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  is_active: number;
};

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
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
    'SELECT id, email, display_name, password_salt, password_hash, password_iterations, is_active FROM users WHERE email = ? LIMIT 1'
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
  const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS || '7')));
  const maxAge = days * 86400;
  const ipFingerprint = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 24);

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, user_agent, ip_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(sessionId, user.id, now + maxAge, now, now, (request.headers.get('user-agent') || '').slice(0, 300), ipFingerprint).run();

  await env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, 'auth.login', 'user', user.id, now).run();

  return json(
    { user: { id: user.id, email: user.email, displayName: user.display_name } },
    200,
    { 'set-cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}` }
  );
}

export async function getSessionUser(request: Request, env: AppEnv): Promise<SessionUser | null> {
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) return null;
  const sessionId = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ? AND u.is_active = 1 LIMIT 1`
  ).bind(sessionId, now).first<{ id: string; email: string; display_name: string }>();
  if (!row) return null;

  return { id: row.id, email: row.email, displayName: row.display_name };
}

export async function sessionResponse(request: Request, env: AppEnv): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ user: null }, 401);
  const mailboxes = await env.DB.prepare('SELECT id, address, display_name, is_default FROM mailboxes WHERE user_id = ? ORDER BY is_default DESC, address ASC')
    .bind(user.id)
    .all<{ id: string; address: string; display_name: string; is_default: number }>();
  return json({ user, mailboxes: mailboxes.results });
}

export async function logout(request: Request, env: AppEnv): Promise<Response> {
  const token = cookieValue(request, COOKIE_NAME);
  if (token) {
    const id = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  }
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
}
