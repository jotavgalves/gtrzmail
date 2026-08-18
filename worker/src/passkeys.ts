import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential
} from '@simplewebauthn/server';
import type { AppEnv, SessionUser } from './env';
import { base64ToBytes, bytesToBase64, constantTimeEqual, randomToken, sha256Hex } from './crypto';
import { json, readJson } from './http';

const encoder = new TextEncoder();
const RP_NAME = 'GTRZ Mail';
const RP_ID = 'mail.gtrz.com.br';
const EXPECTED_ORIGIN = 'https://mail.gtrz.com.br';
const CHALLENGE_TTL_SECONDS = 5 * 60;
const STEP_UP_TTL_SECONDS = 10 * 60;
const PBKDF2_ITERATIONS_MAX = 100000;
const COOKIE_NAME = 'gtrz_session';
const ACCOUNT_COOKIE_PREFIX = 'gtrz_account_';

type PasskeyRow = {
  credential_id: string;
  user_id: string;
  public_key_b64: string;
  webauthn_user_id: string;
  counter: number;
  device_type: string;
  backed_up: number;
  transports_json: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
};

type UserPasswordRow = {
  id: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
};

type ChallengeRow = {
  id: string;
  user_id: string | null;
  kind: 'registration' | 'stepup' | 'login';
  challenge: string;
  expires_at: number;
};

function parseCookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    try { result.set(name, decodeURIComponent(rest.join('='))); }
    catch { result.set(name, rest.join('=')); }
  }
  return result;
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(maxAge))}`;
}

function sessionMaxAge(env: AppEnv): number {
  const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS || '7')));
  return days * 86400;
}

async function currentSessionId(request: Request): Promise<string | null> {
  const token = parseCookies(request).get(COOKIE_NAME);
  return token ? sha256Hex(token) : null;
}

function transports(row: PasskeyRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.transports_json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function credential(row: PasskeyRow): WebAuthnCredential {
  return {
    id: row.credential_id,
    publicKey: base64ToBytes(row.public_key_b64),
    counter: Number(row.counter || 0),
    transports: transports(row) as WebAuthnCredential['transports']
  };
}

async function audit(env: AppEnv, userId: string | null, action: string, targetType: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, targetType, targetId, Math.floor(Date.now() / 1000)).run();
}

async function cleanupChallenges(env: AppEnv, now: number): Promise<void> {
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').bind(now).run();
}

async function saveChallenge(
  env: AppEnv,
  userId: string | null,
  kind: ChallengeRow['kind'],
  challenge: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  await cleanupChallenges(env, now);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, kind, challenge, now + CHALLENGE_TTL_SECONDS, now).run();
  return id;
}

async function consumeChallenge(
  env: AppEnv,
  id: string,
  kind: ChallengeRow['kind'],
  expectedUserId?: string
): Promise<ChallengeRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT id, user_id, kind, challenge, expires_at FROM webauthn_challenges WHERE id = ? AND kind = ? LIMIT 1'
  ).bind(id, kind).first<ChallengeRow>();
  if (!row) return null;
  // One-time use even if verification fails. A fresh browser ceremony must create a fresh challenge.
  await env.DB.prepare('DELETE FROM webauthn_challenges WHERE id = ?').bind(id).run();
  if (row.expires_at <= now) return null;
  if (expectedUserId && row.user_id !== expectedUserId) return null;
  return row;
}

async function listPasskeyRows(env: AppEnv, userId: string): Promise<PasskeyRow[]> {
  const result = await env.DB.prepare(
    `SELECT credential_id, user_id, public_key_b64, webauthn_user_id, counter, device_type,
            backed_up, transports_json, name, created_at, last_used_at
     FROM passkeys WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(userId).all<PasskeyRow>();
  return result.results;
}

async function markStepUp(request: Request, env: AppEnv, userId: string): Promise<boolean> {
  const sessionId = await currentSessionId(request);
  if (!sessionId) return false;
  const result = await env.DB.prepare(
    'UPDATE sessions SET reauthenticated_at = ?, last_seen_at = ? WHERE id = ? AND user_id = ?'
  ).bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), sessionId, userId).run();
  return Boolean(result.meta.changes);
}

export async function hasRecentStepUp(request: Request, env: AppEnv, user: SessionUser): Promise<boolean> {
  const sessionId = await currentSessionId(request);
  if (!sessionId) return false;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT reauthenticated_at FROM sessions WHERE id = ? AND user_id = ? LIMIT 1'
  ).bind(sessionId, user.id).first<{ reauthenticated_at: number | null }>();
  return Boolean(row?.reauthenticated_at && row.reauthenticated_at >= now - STEP_UP_TTL_SECONDS);
}

export async function requireRecentStepUp(request: Request, env: AppEnv, user: SessionUser): Promise<Response | null> {
  if (await hasRecentStepUp(request, env, user)) return null;
  return json({
    error: 'Confirme sua identidade para realizar esta ação sensível.',
    code: 'STEP_UP_REQUIRED'
  }, 428);
}

async function verifyPassword(password: string, row: UserPasswordRow): Promise<boolean> {
  if (!Number.isInteger(row.password_iterations) || row.password_iterations < 1 || row.password_iterations > PBKDF2_ITERATIONS_MAX) return false;
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: base64ToBytes(row.password_salt),
    iterations: row.password_iterations,
    hash: 'SHA-256'
  }, material, 256));
  return constantTimeEqual(derived, base64ToBytes(row.password_hash));
}

export async function passwordStepUp(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: { password?: string };
  try { payload = await readJson(request); }
  catch { return json({ error: 'Requisição inválida.' }, 400); }
  const row = await env.DB.prepare(
    'SELECT id, password_salt, password_hash, password_iterations FROM users WHERE id = ? AND is_active = 1 LIMIT 1'
  ).bind(user.id).first<UserPasswordRow>();
  if (!row || !(await verifyPassword(payload.password || '', row))) {
    await audit(env, user.id, 'auth.step_up_password_failed', 'user', user.id);
    return json({ error: 'Senha incorreta.' }, 401);
  }
  if (!(await markStepUp(request, env, user.id))) return json({ error: 'Sessão não encontrada.' }, 401);
  await audit(env, user.id, 'auth.step_up_password_succeeded', 'user', user.id);
  return json({ ok: true, validForSeconds: STEP_UP_TTL_SECONDS });
}

export async function securityStatus(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const passkeys = await env.DB.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?')
    .bind(user.id).first<{ count: number }>();
  return json({
    passkeyCount: Number(passkeys?.count || 0),
    stepUpValid: await hasRecentStepUp(request, env, user),
    stepUpTtlSeconds: STEP_UP_TTL_SECONDS
  });
}

export async function registrationOptions(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const denied = await requireRecentStepUp(request, env, user);
  if (denied) return denied;
  const passkeys = await listPasskeyRows(env, user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email,
    userDisplayName: user.displayName,
    userID: encoder.encode(user.id),
    attestationType: 'none',
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: passkeys.map((row) => ({
      id: row.credential_id,
      transports: transports(row) as never
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required'
    }
  });
  const challengeId = await saveChallenge(env, user.id, 'registration', options.challenge);
  return json({ challengeId, options });
}

export async function verifyRegistration(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const denied = await requireRecentStepUp(request, env, user);
  if (denied) return denied;
  let payload: { challengeId?: string; response?: RegistrationResponseJSON; name?: string };
  try { payload = await readJson(request); }
  catch { return json({ error: 'Resposta WebAuthn inválida.' }, 400); }
  if (!payload.challengeId || !payload.response) return json({ error: 'Resposta WebAuthn incompleta.' }, 400);
  const challenge = await consumeChallenge(env, payload.challengeId, 'registration', user.id);
  if (!challenge) return json({ error: 'Desafio expirado ou já utilizado.' }, 400);

  try {
    const verification = await verifyRegistrationResponse({
      response: payload.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) return json({ error: 'Não foi possível verificar a passkey.' }, 400);
    const { credential: registered, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const name = (payload.name || 'Passkey').trim().slice(0, 80) || 'Passkey';
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO passkeys (
        credential_id, user_id, public_key_b64, webauthn_user_id, counter, device_type,
        backed_up, transports_json, name, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).bind(
      registered.id,
      user.id,
      bytesToBase64(registered.publicKey),
      String((await generateRegistrationOptions({ rpName: RP_NAME, rpID: RP_ID, userName: user.email, userID: encoder.encode(user.id) })).user.id),
      registered.counter,
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      JSON.stringify(registered.transports || payload.response.response.transports || []),
      name,
      now
    ).run();
    await audit(env, user.id, 'auth.passkey_registered', 'passkey', registered.id.slice(0, 16));
    return json({ ok: true, id: registered.id, name });
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', event: 'webauthn.registration_failed', userId: user.id, message: error instanceof Error ? error.message : 'Unknown error' }));
    return json({ error: 'A passkey não pôde ser verificada.' }, 400);
  }
}

export async function listPasskeys(env: AppEnv, user: SessionUser): Promise<Response> {
  const rows = await listPasskeyRows(env, user.id);
  return json({
    passkeys: rows.map((row) => ({
      id: row.credential_id,
      name: row.name,
      deviceType: row.device_type,
      backedUp: row.backed_up === 1,
      transports: transports(row),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at
    }))
  });
}

export async function deletePasskey(request: Request, env: AppEnv, user: SessionUser, credentialId: string): Promise<Response> {
  const denied = await requireRecentStepUp(request, env, user);
  if (denied) return denied;
  const result = await env.DB.prepare('DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?')
    .bind(credentialId, user.id).run();
  if (!result.meta.changes) return json({ error: 'Passkey não encontrada.' }, 404);
  await audit(env, user.id, 'auth.passkey_deleted', 'passkey', credentialId.slice(0, 16));
  return json({ ok: true });
}

async function authenticationOptionsForUser(env: AppEnv, userId: string, kind: 'stepup' | 'login') {
  const passkeys = await listPasskeyRows(env, userId);
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: passkeys.map((row) => ({ id: row.credential_id, transports: transports(row) as never }))
  });
  const challengeId = await saveChallenge(env, userId, kind, options.challenge);
  return { options, challengeId, available: passkeys.length > 0 };
}

export async function stepUpOptions(env: AppEnv, user: SessionUser): Promise<Response> {
  const payload = await authenticationOptionsForUser(env, user.id, 'stepup');
  return json(payload);
}

export async function verifyStepUp(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: { challengeId?: string; response?: AuthenticationResponseJSON };
  try { payload = await readJson(request); }
  catch { return json({ error: 'Resposta WebAuthn inválida.' }, 400); }
  if (!payload.challengeId || !payload.response) return json({ error: 'Resposta WebAuthn incompleta.' }, 400);
  const challenge = await consumeChallenge(env, payload.challengeId, 'stepup', user.id);
  if (!challenge) return json({ error: 'Desafio expirado ou já utilizado.' }, 400);
  const row = await env.DB.prepare(
    `SELECT credential_id, user_id, public_key_b64, webauthn_user_id, counter, device_type,
            backed_up, transports_json, name, created_at, last_used_at
     FROM passkeys WHERE credential_id = ? AND user_id = ? LIMIT 1`
  ).bind(payload.response.id, user.id).first<PasskeyRow>();
  if (!row) return json({ error: 'Passkey não reconhecida.' }, 401);

  try {
    const verification = await verifyAuthenticationResponse({
      response: payload.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      credential: credential(row),
      requireUserVerification: true
    });
    if (!verification.verified) return json({ error: 'Passkey não verificada.' }, 401);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND user_id = ?')
      .bind(verification.authenticationInfo.newCounter, now, row.credential_id, user.id).run();
    if (!(await markStepUp(request, env, user.id))) return json({ error: 'Sessão não encontrada.' }, 401);
    await audit(env, user.id, 'auth.step_up_passkey_succeeded', 'passkey', row.credential_id.slice(0, 16));
    return json({ ok: true, validForSeconds: STEP_UP_TTL_SECONDS });
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', event: 'webauthn.step_up_failed', userId: user.id, message: error instanceof Error ? error.message : 'Unknown error' }));
    return json({ error: 'A passkey não pôde ser verificada.' }, 401);
  }
}

export async function loginOptions(request: Request, env: AppEnv): Promise<Response> {
  let payload: { email?: string };
  try { payload = await readJson(request); }
  catch { return json({ error: 'Informe o e-mail.' }, 400); }
  const email = (payload.email || '').trim().toLowerCase();
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND is_active = 1 LIMIT 1')
    .bind(email).first<{ id: string }>();

  // Unknown accounts still receive a normal-looking ceremony to avoid a direct
  // account-enumeration oracle. Verification will fail because user_id is null.
  if (!user) {
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'required' });
    const challengeId = await saveChallenge(env, null, 'login', options.challenge);
    return json({ challengeId, options, available: true });
  }

  const payloadOptions = await authenticationOptionsForUser(env, user.id, 'login');
  return json({ ...payloadOptions, available: true });
}

export async function verifyLogin(request: Request, env: AppEnv): Promise<Response> {
  let payload: { challengeId?: string; response?: AuthenticationResponseJSON };
  try { payload = await readJson(request); }
  catch { return json({ error: 'Resposta WebAuthn inválida.' }, 400); }
  if (!payload.challengeId || !payload.response) return json({ error: 'Resposta WebAuthn incompleta.' }, 400);
  const challenge = await consumeChallenge(env, payload.challengeId, 'login');
  if (!challenge?.user_id) return json({ error: 'Não foi possível entrar com esta passkey.' }, 401);
  const row = await env.DB.prepare(
    `SELECT p.credential_id, p.user_id, p.public_key_b64, p.webauthn_user_id, p.counter, p.device_type,
            p.backed_up, p.transports_json, p.name, p.created_at, p.last_used_at
     FROM passkeys p JOIN users u ON u.id = p.user_id
     WHERE p.credential_id = ? AND p.user_id = ? AND u.is_active = 1 LIMIT 1`
  ).bind(payload.response.id, challenge.user_id).first<PasskeyRow>();
  if (!row) return json({ error: 'Não foi possível entrar com esta passkey.' }, 401);

  try {
    const verification = await verifyAuthenticationResponse({
      response: payload.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      credential: credential(row),
      requireUserVerification: true
    });
    if (!verification.verified) return json({ error: 'Não foi possível entrar com esta passkey.' }, 401);

    const now = Math.floor(Date.now() / 1000);
    const token = randomToken(32);
    const sessionId = await sha256Hex(token);
    const maxAge = sessionMaxAge(env);
    const ipFingerprint = (await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')).slice(0, 24);
    const user = await env.DB.prepare('SELECT email, display_name, is_admin FROM users WHERE id = ? LIMIT 1')
      .bind(row.user_id).first<{ email: string; display_name: string; is_admin: number }>();
    if (!user) return json({ error: 'Não foi possível entrar com esta passkey.' }, 401);

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, user_agent, ip_fingerprint, reauthenticated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(sessionId, row.user_id, now + maxAge, now, now, (request.headers.get('user-agent') || '').slice(0, 300), ipFingerprint, now),
      env.DB.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND user_id = ?')
        .bind(verification.authenticationInfo.newCounter, now, row.credential_id, row.user_id),
      env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), row.user_id, 'auth.passkey_login', 'passkey', row.credential_id.slice(0, 16), now)
    ]);

    const headers = new Headers();
    headers.append('set-cookie', secureCookie(COOKIE_NAME, token, maxAge));
    headers.append('set-cookie', secureCookie(`${ACCOUNT_COOKIE_PREFIX}${row.user_id}`, token, maxAge));
    return json({
      ok: true,
      user: { id: row.user_id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin === 1 }
    }, 200, headers);
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', event: 'webauthn.login_failed', userId: row.user_id, message: error instanceof Error ? error.message : 'Unknown error' }));
    return json({ error: 'Não foi possível entrar com esta passkey.' }, 401);
  }
}
