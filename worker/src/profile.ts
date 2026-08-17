import type { AppEnv, SessionUser } from './env';
import { sanitizeSignatureHtml } from './html';
import { json, readJson } from './http';

export async function getSignature(env: AppEnv, user: SessionUser): Promise<Response> {
  const row = await env.DB.prepare('SELECT signature_html FROM users WHERE id = ? LIMIT 1')
    .bind(user.id)
    .first<{ signature_html: string }>();
  return json({ html: row?.signature_html || '' });
}

export async function updateSignature(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: { html?: string };
  try {
    payload = await readJson<{ html?: string }>(request);
  } catch {
    return json({ error: 'Assinatura inválida.' }, 400);
  }

  const html = sanitizeSignatureHtml(payload.html || '');
  await env.DB.prepare('UPDATE users SET signature_html = ? WHERE id = ?')
    .bind(html, user.id)
    .run();

  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), user.id, 'account.signature_changed', 'user', user.id, Math.floor(Date.now() / 1000)).run();

  return json({ ok: true, html });
}
