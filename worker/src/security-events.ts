import type { AppEnv, SessionUser } from './env';
import { json } from './http';

const SECURITY_PREFIXES = [
  'auth.%',
  'admin.%',
  'crypto.%'
];

export async function listSecurityEvents(env: AppEnv, user: SessionUser): Promise<Response> {
  const predicates = SECURITY_PREFIXES.map(() => 'a.action LIKE ?').join(' OR ');
  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.created_at
     FROM audit_logs a
     WHERE a.user_id = ? AND (${predicates})
     ORDER BY a.created_at DESC
     LIMIT 60`
  ).bind(user.id, ...SECURITY_PREFIXES).all<{
    id: string;
    action: string;
    target_type: string;
    target_id: string;
    created_at: number;
  }>();

  return json({
    events: result.results.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      createdAt: row.created_at
    }))
  });
}

export async function listAdminSecurityEvents(env: AppEnv, user: SessionUser): Promise<Response> {
  if (!user.isAdmin) return json({ error: 'Acesso restrito ao administrador.' }, 403);
  const predicates = SECURITY_PREFIXES.map(() => 'a.action LIKE ?').join(' OR ');
  const result = await env.DB.prepare(
    `SELECT a.id, a.user_id, u.email, a.action, a.target_type, a.target_id, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE ${predicates}
     ORDER BY a.created_at DESC
     LIMIT 120`
  ).bind(...SECURITY_PREFIXES).all<{
    id: string;
    user_id: string | null;
    email: string | null;
    action: string;
    target_type: string;
    target_id: string;
    created_at: number;
  }>();

  return json({
    events: result.results.map((row) => ({
      id: row.id,
      userId: row.user_id,
      email: row.email,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      createdAt: row.created_at
    }))
  });
}
