import type { AppEnv, SessionUser } from './env';
import { sha256Hex } from './crypto';
import { json } from './http';

const FIRST_STAGE_ATTEMPTS = 3;
const SECOND_STAGE_ATTEMPTS = 3;
const COOLDOWN_SECONDS = 30 * 60;
const REAUTH_ATTEMPTS = 3;
const REAUTH_COOLDOWN_SECONDS = 30 * 60;
const TURNSTILE_ACTION = 'login_after_failures';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type IpSecurityRow = {
  ip_hash: string;
  ip_address: string;
  stage: 1 | 2;
  failures: number;
  cooldown_until: number;
  captcha_required: number;
  permanently_blocked: number;
  blocked_at: number | null;
  last_failed_at: number | null;
  last_email: string | null;
  user_agent: string | null;
  created_at: number;
  updated_at: number;
};

type TurnstileResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
};

export type LoginProtectionState = {
  stage: 1 | 2;
  attemptsRemaining: number;
  cooldownSeconds: number;
  captchaRequired: boolean;
  captchaConfigured: boolean;
  siteKey: string | null;
};

function clientIp(request: Request): string {
  // On Cloudflare Workers this header is authored by Cloudflare. We deliberately
  // do not trust X-Forwarded-For or a client-supplied cookie/header for counting.
  return (request.headers.get('CF-Connecting-IP') || 'unknown').trim().slice(0, 96);
}

export async function clientIpHash(request: Request): Promise<string> {
  return sha256Hex(`gtrz-auth-ip:${clientIp(request)}`);
}

function turnstileConfigured(env: AppEnv): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

async function rowForRequest(request: Request, env: AppEnv): Promise<IpSecurityRow | null> {
  const hash = await clientIpHash(request);
  return env.DB.prepare(
    `SELECT ip_hash, ip_address, stage, failures, cooldown_until, captcha_required,
            permanently_blocked, blocked_at, last_failed_at, last_email, user_agent,
            created_at, updated_at
     FROM auth_ip_security WHERE ip_hash = ? LIMIT 1`
  ).bind(hash).first<IpSecurityRow>();
}

async function audit(env: AppEnv, action: string, targetId: string, userId: string | null = null): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, 'ip_security', targetId, Math.floor(Date.now() / 1000)).run();
}

function protectionState(row: IpSecurityRow | null, env: AppEnv, now = Math.floor(Date.now() / 1000)): LoginProtectionState {
  if (!row) {
    return {
      stage: 1,
      attemptsRemaining: FIRST_STAGE_ATTEMPTS,
      cooldownSeconds: 0,
      captchaRequired: false,
      captchaConfigured: turnstileConfigured(env),
      siteKey: env.TURNSTILE_SITE_KEY || null
    };
  }

  const cooldownSeconds = Math.max(0, Number(row.cooldown_until || 0) - now);
  const limit = row.stage === 1 ? FIRST_STAGE_ATTEMPTS : SECOND_STAGE_ATTEMPTS;
  return {
    stage: row.stage,
    attemptsRemaining: Math.max(0, limit - Number(row.failures || 0)),
    cooldownSeconds,
    captchaRequired: row.stage === 2 && cooldownSeconds === 0 && row.captcha_required === 1,
    captchaConfigured: turnstileConfigured(env),
    siteKey: env.TURNSTILE_SITE_KEY || null
  };
}

export async function loginProtectionState(request: Request, env: AppEnv): Promise<Response> {
  const row = await rowForRequest(request, env);
  if (row?.permanently_blocked) return blockedJson(row.ip_hash);
  return json(protectionState(row, env));
}

async function verifyTurnstile(request: Request, env: AppEnv, token: string): Promise<boolean> {
  if (!turnstileConfigured(env) || !token || token.length > 2048) return false;

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: clientIp(request),
        idempotency_key: crypto.randomUUID()
      }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return false;
  }

  if (!response.ok) return false;
  const result = await response.json().catch(() => ({})) as TurnstileResult;
  if (!result.success || result.action !== TURNSTILE_ACTION) return false;

  const expectedHostname = new URL(env.APP_ORIGIN).hostname.toLowerCase();
  return Boolean(result.hostname && result.hostname.toLowerCase() === expectedHostname);
}

export async function enforceLoginProtection(
  request: Request,
  env: AppEnv,
  turnstileToken: string | undefined
): Promise<Response | null> {
  const row = await rowForRequest(request, env);
  if (!row) return null;
  if (row.permanently_blocked) return blockedJson(row.ip_hash);

  const now = Math.floor(Date.now() / 1000);
  if (row.cooldown_until > now) {
    const retryAfter = row.cooldown_until - now;
    return json({
      error: 'Muitas senhas incorretas. Este IP está temporariamente bloqueado por 30 minutos.',
      code: 'AUTH_COOLDOWN',
      retryAfterSeconds: retryAfter
    }, 429, { 'retry-after': String(retryAfter) });
  }

  if (row.stage === 2 && row.captcha_required === 1) {
    if (!turnstileConfigured(env)) {
      return json({
        error: 'A verificação anti-bot ainda não está configurada no servidor.',
        code: 'CAPTCHA_NOT_CONFIGURED'
      }, 503);
    }
    if (!turnstileToken) {
      return json({ error: 'Conclua a verificação anti-bot antes de tentar novamente.', code: 'CAPTCHA_REQUIRED' }, 428);
    }
    if (!(await verifyTurnstile(request, env, turnstileToken))) {
      return json({ error: 'A verificação anti-bot não foi aceita. Gere um novo desafio e tente novamente.', code: 'CAPTCHA_INVALID' }, 403);
    }

    await env.DB.prepare(
      `UPDATE auth_ip_security
       SET captcha_required = 0, updated_at = ?
       WHERE ip_hash = ? AND stage = 2 AND permanently_blocked = 0`
    ).bind(now, row.ip_hash).run();
    await audit(env, 'auth.turnstile_passed', row.ip_hash.slice(0, 16));
  }

  return null;
}

export async function recordPasswordFailure(request: Request, env: AppEnv, email: string): Promise<LoginProtectionState & { permanentlyBlocked: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const hash = await clientIpHash(request);
  const ip = clientIp(request);
  const userAgent = (request.headers.get('user-agent') || '').slice(0, 300);
  const normalizedEmail = email.trim().toLowerCase().slice(0, 254);

  const row = await env.DB.prepare(
    `INSERT INTO auth_ip_security (
       ip_hash, ip_address, stage, failures, cooldown_until, captcha_required,
       permanently_blocked, blocked_at, last_failed_at, last_email, user_agent,
       created_at, updated_at
     ) VALUES (?, ?, 1, 1, 0, 0, 0, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(ip_hash) DO UPDATE SET
       ip_address = excluded.ip_address,
       stage = CASE
         WHEN auth_ip_security.permanently_blocked = 1 THEN auth_ip_security.stage
         WHEN auth_ip_security.stage = 1 AND auth_ip_security.failures + 1 >= ? THEN 2
         ELSE auth_ip_security.stage
       END,
       failures = CASE
         WHEN auth_ip_security.permanently_blocked = 1 THEN auth_ip_security.failures
         WHEN auth_ip_security.stage = 1 AND auth_ip_security.failures + 1 >= ? THEN 0
         WHEN auth_ip_security.stage = 2 AND auth_ip_security.failures + 1 >= ? THEN ?
         ELSE auth_ip_security.failures + 1
       END,
       cooldown_until = CASE
         WHEN auth_ip_security.stage = 1 AND auth_ip_security.failures + 1 >= ? THEN ?
         ELSE auth_ip_security.cooldown_until
       END,
       captcha_required = CASE
         WHEN auth_ip_security.stage = 1 AND auth_ip_security.failures + 1 >= ? THEN 1
         ELSE auth_ip_security.captcha_required
       END,
       permanently_blocked = CASE
         WHEN auth_ip_security.stage = 2 AND auth_ip_security.failures + 1 >= ? THEN 1
         ELSE auth_ip_security.permanently_blocked
       END,
       blocked_at = CASE
         WHEN auth_ip_security.stage = 2 AND auth_ip_security.failures + 1 >= ? THEN ?
         ELSE auth_ip_security.blocked_at
       END,
       last_failed_at = ?,
       last_email = excluded.last_email,
       user_agent = excluded.user_agent,
       updated_at = ?
     RETURNING ip_hash, ip_address, stage, failures, cooldown_until, captcha_required,
               permanently_blocked, blocked_at, last_failed_at, last_email, user_agent,
               created_at, updated_at`
  ).bind(
    hash, ip, now, normalizedEmail || null, userAgent || null, now, now,
    FIRST_STAGE_ATTEMPTS,
    FIRST_STAGE_ATTEMPTS,
    SECOND_STAGE_ATTEMPTS, SECOND_STAGE_ATTEMPTS,
    FIRST_STAGE_ATTEMPTS, now + COOLDOWN_SECONDS,
    FIRST_STAGE_ATTEMPTS,
    SECOND_STAGE_ATTEMPTS,
    SECOND_STAGE_ATTEMPTS, now,
    now, now
  ).first<IpSecurityRow>();

  if (!row) throw new Error('Could not persist login protection state');

  if (row.permanently_blocked) {
    await audit(env, 'auth.ip_permanently_blocked', hash.slice(0, 16));
  } else if (row.stage === 2 && row.cooldown_until > now && row.failures === 0) {
    await audit(env, 'auth.ip_cooldown_started', hash.slice(0, 16));
  }

  return { ...protectionState(row, env, now), permanentlyBlocked: row.permanently_blocked === 1 };
}

export async function clearPasswordFailures(request: Request, env: AppEnv): Promise<void> {
  const hash = await clientIpHash(request);
  await env.DB.prepare('DELETE FROM auth_ip_security WHERE ip_hash = ? AND permanently_blocked = 0').bind(hash).run();
}

function blockedJson(hash: string): Response {
  return json({
    error: 'Acesso bloqueado por segurança. O administrador precisa liberar este IP.',
    code: 'IP_BLOCKED',
    reference: hash.slice(0, 12)
  }, 403);
}

function blockedHtml(hash: string): Response {
  const reference = hash.slice(0, 12);
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Acesso bloqueado · GTRZ Mail</title><style>html,body{height:100%;margin:0;background:#050505;color:#f2f2f3;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{min-height:100%;display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(480px,100%);padding:30px;border:1px solid #2b2b30;border-radius:18px;background:#0d0d0f;text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#9a9aa1;line-height:1.55;margin:8px 0}.ref{display:inline-block;margin-top:12px;padding:7px 10px;border-radius:999px;background:#171719;color:#c7c7cc;font:12px ui-monospace,monospace}</style></head><body><main><section class="card"><h1>Acesso bloqueado</h1><p>Este endereço de rede foi bloqueado após repetidas tentativas de autenticação inválidas.</p><p>O desbloqueio precisa ser feito por um administrador do GTRZ Mail.</p><span class="ref">Referência ${reference}</span></section></main></body></html>`, {
    status: 403,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow'
    }
  });
}

export async function ipAccessGate(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const check = url.pathname.startsWith('/api/') || request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/sw.js';
  if (!check || url.pathname === '/api/health' || url.pathname === '/api/webhooks/resend') return null;

  const hash = await clientIpHash(request);
  const row = await env.DB.prepare('SELECT permanently_blocked FROM auth_ip_security WHERE ip_hash = ? LIMIT 1')
    .bind(hash).first<{ permanently_blocked: number }>();
  if (!row?.permanently_blocked) return null;

  return url.pathname.startsWith('/api/') ? blockedJson(hash) : blockedHtml(hash);
}

export async function listBlockedIps(env: AppEnv, user: SessionUser): Promise<Response> {
  if (!user.isAdmin) return json({ error: 'Acesso restrito ao administrador.' }, 403);
  const result = await env.DB.prepare(
    `SELECT ip_hash, ip_address, blocked_at, last_failed_at, last_email, user_agent, updated_at
     FROM auth_ip_security
     WHERE permanently_blocked = 1
     ORDER BY blocked_at DESC, updated_at DESC
     LIMIT 250`
  ).all<{
    ip_hash: string;
    ip_address: string;
    blocked_at: number | null;
    last_failed_at: number | null;
    last_email: string | null;
    user_agent: string | null;
    updated_at: number;
  }>();

  return json({
    ips: result.results.map((row) => ({
      id: row.ip_hash,
      ip: row.ip_address,
      blockedAt: row.blocked_at,
      lastFailedAt: row.last_failed_at,
      lastEmail: row.last_email,
      userAgent: row.user_agent,
      updatedAt: row.updated_at
    }))
  });
}

export async function unblockIp(env: AppEnv, user: SessionUser, ipHash: string): Promise<Response> {
  if (!user.isAdmin) return json({ error: 'Acesso restrito ao administrador.' }, 403);
  if (!/^[a-f0-9]{64}$/i.test(ipHash)) return json({ error: 'Identificador de IP inválido.' }, 400);

  const row = await env.DB.prepare('SELECT ip_address FROM auth_ip_security WHERE ip_hash = ? AND permanently_blocked = 1 LIMIT 1')
    .bind(ipHash).first<{ ip_address: string }>();
  if (!row) return json({ error: 'IP bloqueado não encontrado.' }, 404);

  await env.DB.prepare('DELETE FROM auth_ip_security WHERE ip_hash = ?').bind(ipHash).run();
  await audit(env, 'admin.ip_unblocked', ipHash.slice(0, 16), user.id);
  return json({ ok: true });
}

export async function enforcePasswordReauthLimit(request: Request, env: AppEnv, user: SessionUser): Promise<Response | null> {
  const hash = await clientIpHash(request);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT failures, blocked_until FROM password_reauth_limits WHERE user_id = ? AND ip_hash = ? LIMIT 1'
  ).bind(user.id, hash).first<{ failures: number; blocked_until: number }>();
  if (!row || row.blocked_until <= now) return null;
  const retryAfter = row.blocked_until - now;
  return json({ error: 'Muitas confirmações de senha incorretas. Tente novamente em 30 minutos.', code: 'REAUTH_COOLDOWN' }, 429, { 'retry-after': String(retryAfter) });
}

export async function recordPasswordReauthFailure(request: Request, env: AppEnv, user: SessionUser): Promise<void> {
  const hash = await clientIpHash(request);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO password_reauth_limits (user_id, ip_hash, failures, blocked_until, updated_at)
     VALUES (?, ?, 1, 0, ?)
     ON CONFLICT(user_id, ip_hash) DO UPDATE SET
       failures = CASE
         WHEN password_reauth_limits.blocked_until > ? THEN password_reauth_limits.failures
         WHEN password_reauth_limits.failures + 1 >= ? THEN 0
         ELSE password_reauth_limits.failures + 1
       END,
       blocked_until = CASE
         WHEN password_reauth_limits.blocked_until > ? THEN password_reauth_limits.blocked_until
         WHEN password_reauth_limits.failures + 1 >= ? THEN ?
         ELSE 0
       END,
       updated_at = ?`
  ).bind(user.id, hash, now, now, REAUTH_ATTEMPTS, now, REAUTH_ATTEMPTS, now + REAUTH_COOLDOWN_SECONDS, now).run();
}

export async function clearPasswordReauthFailures(request: Request, env: AppEnv, user: SessionUser): Promise<void> {
  const hash = await clientIpHash(request);
  await env.DB.prepare('DELETE FROM password_reauth_limits WHERE user_id = ? AND ip_hash = ?').bind(user.id, hash).run();
}
