import type { AppEnv, SessionUser } from './env';
import { json } from './http';
import { messageStats } from './mail';
import { listThreadedMessages } from './thread-mail';

export async function bootstrapApp(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const inboxRequest = new Request(`${new URL(request.url).origin}/api/messages?folder=inbox&limit=30`, {
    method: 'GET',
    headers: request.headers
  });

  const [mailboxes, listResponse, statsResponse] = await Promise.all([
    env.DB.prepare(
      'SELECT id, address, display_name, is_default FROM mailboxes WHERE user_id = ? ORDER BY is_default DESC, address ASC'
    ).bind(user.id).all<{ id: string; address: string; display_name: string; is_default: number }>(),
    listThreadedMessages(inboxRequest, env, user),
    messageStats(env, user)
  ]);

  const list = await listResponse.json() as { messages?: unknown[] };
  const stats = await statsResponse.json() as { folders?: Record<string, { total: number; unread: number }> };

  return json({
    user,
    mailboxes: mailboxes.results,
    messages: list.messages || [],
    folders: stats.folders || {}
  });
}
