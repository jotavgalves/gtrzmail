import type { AppEnv } from './env';
import { base64ToBytes, constantTimeEqual, randomToken, sha256Hex } from './crypto';
import { json, readJson } from './http';
import {
  clearPasswordFailures,
  enforceLoginProtection,
  recordPasswordFailure
} from './ip-security';

const encoder = new TextEncoder();
const COOKIE_NAME = 'gtrz_session';
const ACCOUNT_COOKIE_PREFIX = 'gtrz_account_';
const MAX_PBKDF2_ITERATIONS = 100000;
const DUMMY_SALT = encoder.encode('gtrz-mail-password-timing-v2');

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

function sessionMaxAge(env: AppEnv): number {
  const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS || '7')));
  return days * 86400;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(maxAge))}`;
}

async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
  if (!Number.isInteger(user.password_iterations) || user.password_iterations < 1 || user.password_iterations > MAX_PBKDF2_ITERATIONS) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'auth.password_hash_unsupported',
      userId: user.id,
      iterations: user.password_iterations
    }));
    return false;
  }

  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: base64ToBytes(user.password_salt),
    iterations: user.password_iterations,
    hash: 'SHA-256'
  }, material, 256));
  return constantTimeEqual(derived, base64ToBytes(user.password_hash));
}

async function dummyPasswordWork(password: string): Promise<void> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: DUMMY_SALT,
    iterations: MAX_PBKDF2_ITERATIONS,
    hash: 'SHA-256'
  }, material, 256);
}

async function audit(env: AppEnv, userId: string, action: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, 'user', targetId, Math.floor(Date.now() / 1000)).run();
}

export async function loginHardened(request: Request, env: AppEnv): Promise<Response> {
  let payload: { email?: string; password?: string; turnstileToken?: string };
  try {
    payload = await readJson(request);
  } catch {
    return json({ error: 'Requisição inválida.' }, 400);
  }

  const email = (payload.email || '').trim().toLowerCase();
  const password = payload.password || '';
  if (!email || !password) return json({ error: 'Informe e-mail e senha.' }, 400);

  // The gate is entirely server-side and keyed from Cloudflare's CF-Connecting-IP.
  // Clearing cookies, changing browser storage, rotating usernames or forging
  // X-Forwarded-For therefore does not reset the attempt state.
  const denied = await enforceLoginProtection(request, env, payload.turnstileToken);
  if (denied) return denied;

  const user = await env.DB.prepare(
    'SELECT id, email, display_name, password_salt, password_hash, password_iterations, is_active, is_admin FROM users WHERE email = ? LIMIT 1'
  ).bind(email).first<UserRow>();

  let valid = false;
  if (user?.is_active === 1) valid = await verifyPassword(password, user);
  else await dummyPasswordWork(password);

  if (!user || !valid) {
    const state = await recordPasswordFailure(request, env, email);
    if (state.permanentlyBlocked) {
      return json({
        error: 'Este IP foi bloqueado após a segunda sequência de três senhas incorretas. Um administrador precisa liberá-lo.',
        code: 'IP_BLOCKED'
      }, 403);
    }
    if (state.cooldownSeconds > 0) {
      return json({
        error: 'Três senhas incorretas. Este IP ficará bloqueado por 30 minutos; depois será exigido um CAPTCHA para liberar mais três tentativas.',
        code: 'AUTH_COOLDOWN',
        retryAfterSeconds: state.cooldownSeconds,
        attemptsRemaining: state.attemptsRemaining
      }, 429, { 'retry-after': String(state.cooldownSeconds) });
    }
    return json({
      error: `Credenciais inválidas. Restam ${state.attemptsRemaining} tentativa${state.attemptsRemaining === 1 ? '' : 's'} antes do bloqueio.`,
      code: 'INVALID_CREDENTIALS',
      attemptsRemaining: state.attemptsRemaining
    }, 401);
  }

  await clearPasswordFailures(request, env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();

  const token = randomToken(32);
  const sessionId = await sha256Hex(token);
  const maxAge = sessionMaxAge(env);
  const ipFingerprint = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 24);

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, user_agent, ip_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    sessionId,
    user.id,
    now + maxAge,
    now,
    now,
    (request.headers.get('user-agent') || '').slice(0, 300),
    ipFingerprint
  ).run();

  await audit(env, user.id, 'auth.login', user.id);

  const headers = new Headers();
  headers.append('set-cookie', secureCookie(COOKIE_NAME, token, maxAge));
  headers.append('set-cookie', secureCookie(`${ACCOUNT_COOKIE_PREFIX}${user.id}`, token, maxAge));
  return json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin === 1
    }
  }, 200, headers);
}
