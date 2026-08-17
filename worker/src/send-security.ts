import type { AppEnv, SessionUser } from './env';
import { json } from './http';
import { sendMessageRich } from './mail-rich';

const MAX_UNIQUE_RECIPIENTS = 50;
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const SHORT_WINDOW_SECONDS = 10 * 60;
const SHORT_WINDOW_LIMIT = 30;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DAILY_WINDOW_LIMIT = 300;

type SendShape = { to?: unknown; cc?: unknown; bcc?: unknown };

function recipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function incrementWindow(
  env: AppEnv,
  scope: string,
  key: string,
  windowSeconds: number,
  now: number
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO request_rate_limits (scope, key, window_started_at, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(scope, key) DO UPDATE SET
       count = CASE WHEN ? - request_rate_limits.window_started_at >= ? THEN 1 ELSE request_rate_limits.count + 1 END,
       window_started_at = CASE WHEN ? - request_rate_limits.window_started_at >= ? THEN ? ELSE request_rate_limits.window_started_at END
     RETURNING count`
  ).bind(scope, key, now, now, windowSeconds, now, windowSeconds, now).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function auditLimit(env: AppEnv, userId: string, scope: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, 'mail.rate_limited', 'rate_limit', scope, Math.floor(Date.now() / 1000)).run();
}

export async function sendMessageGuarded(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json({ error: 'Mensagem grande demais para processamento seguro.' }, 413);
  }

  let payload: SendShape;
  try {
    payload = await request.clone().json() as SendShape;
  } catch {
    return sendMessageRich(request, env, user);
  }

  const unique = new Set([
    ...recipients(payload.to),
    ...recipients(payload.cc),
    ...recipients(payload.bcc)
  ]);
  if (unique.size > MAX_UNIQUE_RECIPIENTS) {
    return json({ error: `Limite de ${MAX_UNIQUE_RECIPIENTS} destinatários por mensagem.` }, 413);
  }

  const now = Math.floor(Date.now() / 1000);
  const shortCount = await incrementWindow(env, 'mail-send-10m', user.id, SHORT_WINDOW_SECONDS, now);
  if (shortCount > SHORT_WINDOW_LIMIT) {
    await auditLimit(env, user.id, 'mail-send-10m');
    return json({ error: 'Muitos envios em pouco tempo. Aguarde alguns minutos.' }, 429, { 'retry-after': '600' });
  }

  const dailyCount = await incrementWindow(env, 'mail-send-24h', user.id, DAILY_WINDOW_SECONDS, now);
  if (dailyCount > DAILY_WINDOW_LIMIT) {
    await auditLimit(env, user.id, 'mail-send-24h');
    return json({ error: 'Limite diário de segurança atingido. Revise a atividade da conta.' }, 429, { 'retry-after': '3600' });
  }

  return sendMessageRich(request, env, user);
}
