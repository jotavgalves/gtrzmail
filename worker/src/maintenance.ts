import type { AppEnv } from './env';

const DAY = 24 * 60 * 60;

export async function runSecurityMaintenance(env: AppEnv): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const auditCutoff = now - 180 * DAY;
  const webhookCutoff = now - 90 * DAY;
  const rateCutoff = now - 2 * DAY;
  const loginCutoff = now - 2 * DAY;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM request_rate_limits WHERE window_started_at <= ?').bind(rateCutoff),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_started_at <= ? AND blocked_until <= ?').bind(loginCutoff, now),
    env.DB.prepare('DELETE FROM webhook_events WHERE created_at <= ?').bind(webhookCutoff),
    env.DB.prepare('DELETE FROM audit_logs WHERE created_at <= ?').bind(auditCutoff)
  ]);
}
