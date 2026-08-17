import type { AppEnv, SessionUser } from './env';
import { json } from './http';

type MessageAction = 'read' | 'star' | 'trash' | 'archive' | 'restore' | 'delete';

type MessageRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  folder: string;
  previous_folder: string | null;
  sent_status: string | null;
  r2_key: string;
  html_r2_key: string | null;
};

async function userMessage(env: AppEnv, userId: string, messageId: string): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT m.id, m.direction, m.folder, m.previous_folder, m.sent_status, m.r2_key, m.html_r2_key
     FROM messages m
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.id = ? AND mb.user_id = ? LIMIT 1`
  ).bind(messageId, userId).first<MessageRow>();
}

async function audit(env: AppEnv, userId: string, action: string, messageId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, 'message', messageId, Math.floor(Date.now() / 1000)).run();
}

async function deleteMessageData(env: AppEnv, row: MessageRow): Promise<void> {
  const attachments = await env.DB.prepare('SELECT r2_key FROM attachments WHERE message_id = ?')
    .bind(row.id)
    .all<{ r2_key: string }>();
  await Promise.all([
    env.MAIL_BUCKET.delete(row.r2_key),
    ...(row.html_r2_key ? [env.MAIL_BUCKET.delete(row.html_r2_key)] : []),
    ...attachments.results.map((attachment) => env.MAIL_BUCKET.delete(attachment.r2_key))
  ]);
  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(row.id).run();
}

export async function updateMessageActionRich(
  env: AppEnv,
  user: SessionUser,
  messageId: string,
  action: MessageAction,
  value?: boolean
): Promise<Response> {
  const row = await userMessage(env, user.id, messageId);
  if (!row) return json({ error: 'Mensagem não encontrada.' }, 404);

  if (action === 'read') {
    await env.DB.prepare('UPDATE messages SET is_read = ? WHERE id = ?')
      .bind(value === false ? 0 : 1, messageId)
      .run();
  } else if (action === 'star') {
    await env.DB.prepare('UPDATE messages SET is_starred = ? WHERE id = ?')
      .bind(value === false ? 0 : 1, messageId)
      .run();
  } else if (action === 'trash') {
    if (row.folder !== 'trash') {
      await env.DB.prepare("UPDATE messages SET previous_folder = folder, folder = 'trash' WHERE id = ?")
        .bind(messageId)
        .run();
    }
  } else if (action === 'archive') {
    await env.DB.prepare("UPDATE messages SET folder = 'archive', previous_folder = NULL WHERE id = ?")
      .bind(messageId)
      .run();
  } else if (action === 'restore') {
    const fallback = row.direction === 'inbound' ? 'inbox' : row.sent_status === 'draft' ? 'drafts' : 'sent';
    const restoreFolder = row.previous_folder && ['inbox', 'sent', 'drafts', 'archive', 'spam'].includes(row.previous_folder)
      ? row.previous_folder
      : fallback;
    await env.DB.prepare('UPDATE messages SET folder = ?, previous_folder = NULL WHERE id = ?')
      .bind(restoreFolder, messageId)
      .run();
  } else {
    await deleteMessageData(env, row);
  }

  await audit(env, user.id, `mail.${action}`, messageId);
  return json({ ok: true });
}
