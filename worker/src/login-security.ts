import type { AppEnv } from './env';
import { login } from './auth';
import { sha256Hex } from './crypto';
import { json } from './http';

const encoder = new TextEncoder();
const WINDOW_SECONDS = 30 * 60;
const BLOCK_SECONDS = 30 * 60;
const EMAIL_FAILURE_LIMIT = 10;
const IP_FAILURE_LIMIT = 30;
const DUMMY_SALT = encoder.encode('gtrz-mail-password-timing-v1');

type AttemptRow = { attempts: number; window_started_at: number; blocked_until: number };

async function key(kind: 'email' | 'ip', value: string): Promise<string> {
  return sha256Hex(`login:${kind}:${value.toLowerCase()}`);
}

async function blocked(env: AppEnv, attemptKey: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT blocked_until FROM login_attempts WHERE key = ? LIMIT 1')
    .bind(attemptKey).first<{ blocked_until: number }>();
  return Boolean(row && row.blocked_until > now);
}

async function recordFailure(env: AppEnv, attemptKey: string, limit: number, now: number): Promise<void> {
  const row = await env.DB.prepare('SELECT attempts, window_started_at, blocked_until FROM login_attempts WHERE key = ? LIMIT 1')
    .bind(attemptKey).first<AttemptRow>();
  const withinWindow = Boolean(row && now - row.window_started_at < WINDOW_SECONDS);
  const attempts = withinWindow ? Number(row!.attempts) + 1 : 1;
  const startedAt = withinWindow ? row!.window_started_at : now;
  const blockedUntil = attempts >= limit ? now + BLOCK_SECONDS : 0;
  await env.DB.prepare(
    `INSERT INTO login_attempts (key, attempts, window_started_at, blocked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       attempts = excluded.attempts,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until`
  ).bind(attemptKey, attempts, startedAt, blockedUntil).run();
}

async function dummyPasswordWork(password: string): Promise<void> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: DUMMY_SALT, iterations: 100000, hash: 'SHA-256' }, material, 256);
}

export async function loginHardened(request: Request, env: AppEnv): Promise<Response> {
  let payload: { email?: string; password?: string } = {};
  try { payload = await request.clone().json() as { email?: string; password?: string }; }
  catch { return login(request, env); }

  const email = (payload.email || '').trim().toLowerCase();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!email) return login(request, env);

  const now = Math.floor(Date.now() / 1000);
  const emailKey = await key('email', email);
  const ipKey = await key('ip', ip);
  if ((await blocked(env, emailKey, now)) || (await blocked(env, ipKey, now))) {
    return json({ error: 'Muitas tentativas. Tente novamente mais tarde.' }, 429);
  }

  // Equalize the most obvious unknown-account timing difference without exposing
  // whether the address exists. Rate limits are checked first to avoid a free CPU DoS.
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1 LIMIT 1')
    .bind(email).first<{ id: string }>();
  if (!exists) await dummyPasswordWork(payload.password || '');

  const response = await login(request, env);
  if (response.status === 200) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(emailKey),
      env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(ipKey)
    ]);
    return response;
  }

  if (response.status === 401) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO login_attempts (key, attempts, window_started_at, blocked_until) VALUES (?, 1, ?, 0)
         ON CONFLICT(key) DO NOTHING`
      ).bind(emailKey, now),
      env.DB.prepare(
        `INSERT INTO login_attempts (key, attempts, window_started_at, blocked_until) VALUES (?, 1, ?, 0)
         ON CONFLICT(key) DO NOTHING`
      ).bind(ipKey, now)
    ]);
    await recordFailure(env, emailKey, EMAIL_FAILURE_LIMIT, now);
    await recordFailure(env, ipKey, IP_FAILURE_LIMIT, now);
  }
  return response;
}
