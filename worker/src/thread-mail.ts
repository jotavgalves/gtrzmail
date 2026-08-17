import type { AppEnv, SessionUser } from './env';
import { json } from './http';
import { getMessageRich } from './mail-rich';
import { handleResendWebhook } from './mail';
import { ensureUserThreads } from './threads';
import { sendPushToUser } from './push';

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function listThreadedMessages(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  // Never rebuild threads while the user is waiting for the inbox.
  // Reconciliation is maintenance work performed on inbound/webhook paths.
  const url = new URL(request.url);
  const allowedFolders = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive', 'spam']);
  const requestedFolder = url.searchParams.get('folder') || '';
  const folder = allowedFolders.has(requestedFolder) ? requestedFolder : 'inbox';
  const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const starred = url.searchParams.get('starred') === '1';
  const unread = url.searchParams.get('unread') === '1';
  const hasAttachment = url.searchParams.get('hasAttachment') === '1';
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || '30')));

  let sql = `SELECT m.id, m.direction, m.folder, m.from_name, m.from_address, m.to_json, m.subject, m.preview,
                    m.is_read, m.is_starred, m.sent_status, m.received_at, COALESCE(m.thread_id, m.id) AS thread_id,
                    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count,
                    (SELECT COUNT(*) FROM messages tx INDEXED BY idx_messages_thread_id
                      WHERE COALESCE(tx.thread_id, tx.id) = COALESCE(m.thread_id, m.id)
                        AND tx.folder NOT IN ('trash', 'spam', 'drafts')) AS thread_count
             FROM messages m
             JOIN mailboxes mb ON mb.id = m.mailbox_id
             WHERE mb.user_id = ? AND m.folder = ?`;
  const binds: Array<string | number> = [user.id, folder];

  if (starred) sql += ' AND m.is_starred = 1';
  if (unread) sql += ' AND m.is_read = 0';
  if (hasAttachment) sql += ' AND EXISTS (SELECT 1 FROM attachments ax WHERE ax.message_id = m.id)';
  if (query) {
    sql += ' AND (m.subject LIKE ? OR m.from_address LIKE ? OR m.from_name LIKE ? OR m.preview LIKE ? OR m.to_json LIKE ?)';
    const like = `%${query}%`;
    binds.push(like, like, like, like, like);
  }

  // We only need enough rows to collapse recent messages into the requested number of threads.
  sql += ' ORDER BY m.received_at DESC LIMIT ?';
  binds.push(Math.min(160, Math.max(limit, limit * 4)));

  const result = await env.DB.prepare(sql).bind(...binds).all<{
    id: string;
    direction: string;
    folder: string;
    from_name: string | null;
    from_address: string;
    to_json: string;
    subject: string;
    preview: string;
    is_read: number;
    is_starred: number;
    sent_status: string | null;
    received_at: number;
    thread_id: string;
    attachment_count: number;
    thread_count: number;
  }>();

  const grouped = new Map<string, typeof result.results[number]>();
  for (const row of result.results) {
    const existing = grouped.get(row.thread_id);
    if (!existing || row.received_at > existing.received_at) grouped.set(row.thread_id, row);
  }

  const rows = [...grouped.values()].sort((a, b) => b.received_at - a.received_at).slice(0, limit);
  return json({
    messages: rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      threadCount: Math.max(1, row.thread_count || 0),
      direction: row.direction,
      folder: row.folder,
      fromName: row.from_name,
      fromAddress: row.from_address,
      to: parseJsonArray(row.to_json),
      subject: row.subject,
      preview: row.preview,
      isRead: row.is_read === 1,
      isStarred: row.is_starred === 1,
      sentStatus: row.sent_status,
      receivedAt: row.received_at,
      attachmentCount: row.attachment_count
    }))
  });
}

export async function getThreadedMessage(env: AppEnv, user: SessionUser, messageId: string): Promise<Response> {
  // Message detail is intentionally independent from global thread maintenance.
  const response = await getMessageRich(env, user, messageId);
  if (!response.ok) return response;
  const payload = await response.json() as { message?: Record<string, unknown> };
  const row = await env.DB.prepare(
    `SELECT COALESCE(m.thread_id, m.id) AS thread_id
     FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.id = ? AND mb.user_id = ? LIMIT 1`
  ).bind(messageId, user.id).first<{ thread_id: string }>();
  if (payload.message) payload.message.threadId = row?.thread_id || messageId;
  return json(payload);
}

export async function handleThreadedResendWebhook(request: Request, env: AppEnv): Promise<Response> {
  const copy = request.clone();
  const response = await handleResendWebhook(request, env);
  if (!response.ok) return response;

  try {
    const event = JSON.parse(await copy.text()) as {
      data?: { email_id?: string; message_id?: string };
    };
    const providerId = event.data?.email_id;
    const messageId = event.data?.message_id?.trim();
    if (providerId && messageId) {
      await env.DB.prepare('UPDATE messages SET message_id = COALESCE(message_id, ?) WHERE provider_id = ?')
        .bind(messageId, providerId)
        .run();
      const owner = await env.DB.prepare(
        `SELECT mb.user_id FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
         WHERE m.provider_id = ? LIMIT 1`
      ).bind(providerId).first<{ user_id: string }>();
      // Webhook work is off the interactive path, so maintenance can happen here.
      if (owner) await ensureUserThreads(env, owner.user_id);
    }
  } catch {
    // O webhook de status já foi processado; falha na melhoria de threading não deve invalidá-lo.
  }
  return response;
}

export async function notifyLatestInbound(env: AppEnv, toAddress: string, fromAddress: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT m.id, COALESCE(m.thread_id, m.id) AS thread_id, m.subject, m.preview, m.from_name, m.from_address, mb.user_id
     FROM messages m
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.direction = 'inbound' AND m.created_at >= ?
       AND (mb.address = ? COLLATE NOCASE OR m.from_address = ? COLLATE NOCASE)
     ORDER BY m.created_at DESC LIMIT 1`
  ).bind(now - 120, toAddress.toLowerCase(), fromAddress.toLowerCase()).first<{
    id: string;
    thread_id: string;
    subject: string;
    preview: string;
    from_name: string | null;
    from_address: string;
    user_id: string;
  }>();
  if (!row) return;

  // This runs under ctx.waitUntil after the message is already stored. It may reconcile
  // threads without delaying the inbox UI or the sender's SMTP transaction.
  await ensureUserThreads(env, row.user_id);
  const current = await env.DB.prepare('SELECT COALESCE(thread_id, id) AS thread_id FROM messages WHERE id = ? LIMIT 1')
    .bind(row.id).first<{ thread_id: string }>();

  await sendPushToUser(env, row.user_id, {
    messageId: row.id,
    threadId: current?.thread_id || row.thread_id,
    title: row.from_name || row.from_address || 'Novo e-mail',
    body: row.subject || row.preview || 'Você recebeu uma nova mensagem.',
    fromAddress: row.from_address
  });
}
