import PostalMime, { type Address, type Mailbox } from 'postal-mime';
import type { AppEnv, SessionUser } from './env';
import { base64ToBytes, constantTimeEqual, createEnvelope, decryptWithDataKey, encryptWithDataKey, unwrapDataKey } from './crypto';
import { json, readJson, safeFilename } from './http';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type MailboxRow = {
  id: string;
  user_id: string;
  address: string;
  display_name: string;
  is_default: number;
};

type MessageRow = {
  id: string;
  mailbox_id: string;
  direction: 'inbound' | 'outbound';
  folder: string;
  provider_id: string | null;
  message_id: string | null;
  from_name: string | null;
  from_address: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  preview: string;
  storage_type: 'rfc822' | 'text';
  r2_key: string;
  encrypted_key: string;
  key_iv: string;
  body_iv: string;
  is_read: number;
  is_starred: number;
  sent_status: string | null;
  received_at: number;
};

type OutboundAttachment = {
  filename: string;
  mimeType?: string;
  contentBase64: string;
};

type SendPayload = {
  fromMailboxId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  attachments?: OutboundAttachment[];
  inReplyTo?: string;
};

function mailboxFromAddress(address: Address | undefined): Mailbox | null {
  if (!address) return null;
  if ('group' in address && address.group) return address.group[0] || null;
  return address as Mailbox;
}

function addresses(items: Address[] | undefined): string[] {
  if (!items) return [];
  const out: string[] = [];
  for (const item of items) {
    if ('group' in item && item.group) {
      for (const member of item.group) if (member.address) out.push(member.address.toLowerCase());
    } else {
      const box = item as Mailbox;
      if (box.address) out.push(box.address.toLowerCase());
    }
  }
  return out;
}

function safeText(text: string | undefined, html: string | undefined): string {
  if (text?.trim()) return text.trim();
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function parseJsonArray(value: string): string[] {
  try {
    const result: unknown = JSON.parse(value);
    return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeRecipients(value: string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((item) => item.trim().toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))];
}

async function incomingMailbox(env: AppEnv, destination: string): Promise<MailboxRow | null> {
  const exact = await env.DB.prepare(
    'SELECT id, user_id, address, display_name, is_default FROM mailboxes WHERE address = ? LIMIT 1'
  ).bind(destination.toLowerCase()).first<MailboxRow>();
  if (exact) return exact;
  return env.DB.prepare(
    'SELECT id, user_id, address, display_name, is_default FROM mailboxes WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1'
  ).first<MailboxRow>();
}

export async function receiveEmail(message: ForwardableEmailMessage, env: AppEnv): Promise<void> {
  const mailbox = await incomingMailbox(env, message.to);
  if (!mailbox) {
    message.setReject('GTRZ Mail: mailbox not configured');
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw, { maxNestingDepth: 80, maxHeadersSize: 524288 });
  const from = mailboxFromAddress(parsed.from);
  const text = safeText(parsed.text, parsed.html);
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const r2Key = `messages/${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}/${id}/message.eml.enc`;
  const envelope = await createEnvelope(raw, env);

  await env.MAIL_BUCKET.put(r2Key, envelope.ciphertext, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { version: 'gtrz-envelope-v1' }
  });

  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [String(parsed.references)]
      : [];

  await env.DB.prepare(
    `INSERT INTO messages (
      id, mailbox_id, direction, folder, provider_id, message_id, in_reply_to, references_json,
      from_name, from_address, to_json, cc_json, bcc_json, subject, preview, storage_type,
      r2_key, encrypted_key, key_iv, body_iv, is_read, is_starred, sent_status, received_at, created_at
    ) VALUES (?, ?, 'inbound', 'inbox', NULL, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'rfc822', ?, ?, ?, ?, 0, 0, NULL, ?, ?)`
  ).bind(
    id,
    mailbox.id,
    parsed.messageId || null,
    parsed.inReplyTo || null,
    JSON.stringify(refs),
    from?.name || '',
    from?.address?.toLowerCase() || message.from.toLowerCase(),
    JSON.stringify(addresses(parsed.to)),
    JSON.stringify(addresses(parsed.cc)),
    parsed.subject || '(sem assunto)',
    previewOf(text),
    r2Key,
    envelope.encryptedKey,
    envelope.keyIv,
    envelope.bodyIv,
    now,
    now
  ).run();

  const attachmentStatements: D1PreparedStatement[] = [];
  for (const attachment of parsed.attachments || []) {
    const attachmentId = crypto.randomUUID();
    const attachmentKey = `attachments/${id}/${attachmentId}.enc`;
    const content = attachment.content instanceof ArrayBuffer
      ? attachment.content
      : typeof attachment.content === 'string'
        ? encoder.encode(attachment.content)
        : new Uint8Array(attachment.content as ArrayBuffer);
    const encrypted = await encryptWithDataKey(content, envelope.dataKey);
    await env.MAIL_BUCKET.put(attachmentKey, encrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1' }
    });
    const size = content instanceof ArrayBuffer ? content.byteLength : content.byteLength;
    attachmentStatements.push(
      env.DB.prepare(
        'INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, r2_key, body_iv, content_id, disposition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        attachmentId,
        id,
        attachment.filename || 'anexo',
        attachment.mimeType || 'application/octet-stream',
        size,
        attachmentKey,
        encrypted.iv,
        attachment.contentId || null,
        attachment.disposition || 'attachment',
        now
      )
    );
  }
  if (attachmentStatements.length) await env.DB.batch(attachmentStatements);

  await env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), mailbox.user_id, 'mail.received', 'message', id, now).run();
}

export async function listMessages(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  const url = new URL(request.url);
  const allowedFolders = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive', 'spam']);
  const folder = allowedFolders.has(url.searchParams.get('folder') || '') ? (url.searchParams.get('folder') as string) : 'inbox';
  const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || '50')));

  let sql = `SELECT m.id, m.direction, m.folder, m.from_name, m.from_address, m.to_json, m.subject, m.preview,
                    m.is_read, m.is_starred, m.sent_status, m.received_at,
                    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
             FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
             WHERE mb.user_id = ? AND m.folder = ?`;
  const binds: Array<string | number> = [user.id, folder];
  if (query) {
    sql += ' AND (m.subject LIKE ? OR m.from_address LIKE ? OR m.from_name LIKE ? OR m.preview LIKE ?)';
    const like = `%${query}%`;
    binds.push(like, like, like, like);
  }
  sql += ' ORDER BY m.received_at DESC LIMIT ?';
  binds.push(limit);

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
    attachment_count: number;
  }>();

  return json({
    messages: result.results.map((row) => ({
      id: row.id,
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

async function userMessage(env: AppEnv, userId: string, messageId: string): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT m.* FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.id = ? AND mb.user_id = ? LIMIT 1`
  ).bind(messageId, userId).first<MessageRow>();
}

export async function getMessage(env: AppEnv, user: SessionUser, messageId: string): Promise<Response> {
  const row = await userMessage(env, user.id, messageId);
  if (!row) return json({ error: 'Mensagem não encontrada.' }, 404);
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return json({ error: 'Conteúdo da mensagem indisponível.' }, 404);

  const dataKey = await unwrapDataKey(row.encrypted_key, row.key_iv, env);
  const decrypted = await decryptWithDataKey(await object.arrayBuffer(), row.body_iv, dataKey);
  let bodyText = '';
  if (row.storage_type === 'rfc822') {
    const parsed = await PostalMime.parse(decrypted, { maxNestingDepth: 80, maxHeadersSize: 524288 });
    bodyText = safeText(parsed.text, parsed.html);
  } else {
    bodyText = decoder.decode(decrypted);
  }

  const attachments = await env.DB.prepare(
    'SELECT id, filename, mime_type, size_bytes, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY created_at ASC'
  ).bind(row.id).all<{ id: string; filename: string; mime_type: string; size_bytes: number; content_id: string | null; disposition: string | null }>();

  if (!row.is_read) {
    await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(row.id).run();
  }

  return json({
    message: {
      id: row.id,
      direction: row.direction,
      folder: row.folder,
      fromName: row.from_name,
      fromAddress: row.from_address,
      to: parseJsonArray(row.to_json),
      cc: parseJsonArray(row.cc_json),
      bcc: parseJsonArray(row.bcc_json),
      subject: row.subject,
      bodyText,
      isRead: true,
      isStarred: row.is_starred === 1,
      sentStatus: row.sent_status,
      receivedAt: row.received_at,
      attachments: attachments.results.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        contentId: a.content_id,
        disposition: a.disposition
      }))
    }
  });
}

export async function updateMessageAction(env: AppEnv, user: SessionUser, messageId: string, action: 'read' | 'star' | 'trash' | 'archive', value?: boolean): Promise<Response> {
  const row = await userMessage(env, user.id, messageId);
  if (!row) return json({ error: 'Mensagem não encontrada.' }, 404);

  if (action === 'read') {
    await env.DB.prepare('UPDATE messages SET is_read = ? WHERE id = ?').bind(value === false ? 0 : 1, messageId).run();
  } else if (action === 'star') {
    await env.DB.prepare('UPDATE messages SET is_starred = ? WHERE id = ?').bind(value === false ? 0 : 1, messageId).run();
  } else if (action === 'trash') {
    await env.DB.prepare("UPDATE messages SET folder = 'trash' WHERE id = ?").bind(messageId).run();
  } else if (action === 'archive') {
    await env.DB.prepare("UPDATE messages SET folder = 'archive' WHERE id = ?").bind(messageId).run();
  }
  return json({ ok: true });
}

export async function downloadAttachment(env: AppEnv, user: SessionUser, attachmentId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.r2_key, a.body_iv, m.encrypted_key, m.key_iv
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE a.id = ? AND mb.user_id = ? LIMIT 1`
  ).bind(attachmentId, user.id).first<{
    id: string;
    filename: string;
    mime_type: string;
    r2_key: string;
    body_iv: string;
    encrypted_key: string;
    key_iv: string;
  }>();
  if (!row) return json({ error: 'Anexo não encontrado.' }, 404);

  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return json({ error: 'Arquivo indisponível.' }, 404);
  const dataKey = await unwrapDataKey(row.encrypted_key, row.key_iv, env);
  const decrypted = await decryptWithDataKey(await object.arrayBuffer(), row.body_iv, dataKey);
  const filename = safeFilename(row.filename);
  const headers = new Headers({
    'content-type': row.mime_type || 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  });
  return new Response(decrypted, { status: 200, headers });
}

export async function sendMessage(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: SendPayload;
  try {
    payload = await readJson<SendPayload>(request);
  } catch {
    return json({ error: 'Mensagem inválida.' }, 400);
  }

  const to = normalizeRecipients(payload.to);
  const cc = normalizeRecipients(payload.cc);
  const bcc = normalizeRecipients(payload.bcc);
  const subject = (payload.subject || '').trim().slice(0, 998) || '(sem assunto)';
  const text = (payload.text || '').slice(0, 500_000);
  if (!to.length) return json({ error: 'Informe pelo menos um destinatário.' }, 400);

  const mailbox = payload.fromMailboxId
    ? await env.DB.prepare('SELECT id, user_id, address, display_name, is_default FROM mailboxes WHERE id = ? AND user_id = ? LIMIT 1')
      .bind(payload.fromMailboxId, user.id).first<MailboxRow>()
    : await env.DB.prepare('SELECT id, user_id, address, display_name, is_default FROM mailboxes WHERE user_id = ? ORDER BY is_default DESC LIMIT 1')
      .bind(user.id).first<MailboxRow>();
  if (!mailbox) return json({ error: 'Caixa de envio não configurada.' }, 400);

  const attachments = payload.attachments || [];
  let totalAttachmentBytes = 0;
  const decodedAttachments: Array<OutboundAttachment & { bytes: Uint8Array }> = [];
  for (const attachment of attachments.slice(0, 20)) {
    if (!attachment.filename || !attachment.contentBase64) continue;
    const bytes = base64ToBytes(attachment.contentBase64);
    totalAttachmentBytes += bytes.byteLength;
    decodedAttachments.push({ ...attachment, bytes });
  }
  const maxBytes = Number(env.MAX_OUTBOUND_ATTACHMENT_BYTES || '18874368');
  if (totalAttachmentBytes > maxBytes) return json({ error: 'Os anexos excedem o limite permitido pelo GTRZ Mail.' }, 413);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const r2Key = `sent/${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}/${id}/body.txt.enc`;
  const envelope = await createEnvelope(encoder.encode(text), env);
  await env.MAIL_BUCKET.put(r2Key, envelope.ciphertext, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { version: 'gtrz-envelope-v1' }
  });

  await env.DB.prepare(
    `INSERT INTO messages (
      id, mailbox_id, direction, folder, provider_id, message_id, in_reply_to, references_json,
      from_name, from_address, to_json, cc_json, bcc_json, subject, preview, storage_type,
      r2_key, encrypted_key, key_iv, body_iv, is_read, is_starred, sent_status, received_at, created_at
    ) VALUES (?, ?, 'outbound', 'sent', NULL, NULL, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?, 1, 0, 'sending', ?, ?)`
  ).bind(
    id,
    mailbox.id,
    payload.inReplyTo || null,
    mailbox.display_name,
    mailbox.address,
    JSON.stringify(to),
    JSON.stringify(cc),
    JSON.stringify(bcc),
    subject,
    previewOf(text),
    r2Key,
    envelope.encryptedKey,
    envelope.keyIv,
    envelope.bodyIv,
    now,
    now
  ).run();

  const attachmentStatements: D1PreparedStatement[] = [];
  for (const attachment of decodedAttachments) {
    const attachmentId = crypto.randomUUID();
    const attachmentKey = `attachments/${id}/${attachmentId}.enc`;
    const encrypted = await encryptWithDataKey(attachment.bytes, envelope.dataKey);
    await env.MAIL_BUCKET.put(attachmentKey, encrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1' }
    });
    attachmentStatements.push(
      env.DB.prepare(
        'INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, r2_key, body_iv, content_id, disposition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)'
      ).bind(
        attachmentId,
        id,
        attachment.filename.slice(0, 180),
        attachment.mimeType || 'application/octet-stream',
        attachment.bytes.byteLength,
        attachmentKey,
        encrypted.iv,
        'attachment',
        now
      )
    );
  }
  if (attachmentStatements.length) await env.DB.batch(attachmentStatements);

  const resendPayload: Record<string, unknown> = {
    from: `${mailbox.display_name} <${mailbox.address}>`,
    to,
    subject,
    text
  };
  if (cc.length) resendPayload.cc = cc;
  if (bcc.length) resendPayload.bcc = bcc;
  if (decodedAttachments.length) {
    resendPayload.attachments = decodedAttachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.contentBase64
    }));
  }

  const providerResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(resendPayload)
  });

  const providerBody = await providerResponse.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
  if (!providerResponse.ok || !providerBody.id) {
    await env.DB.prepare("UPDATE messages SET sent_status = 'failed' WHERE id = ?").bind(id).run();
    return json({ error: providerBody.message || 'Falha ao enviar pelo provedor.', messageId: id }, 502);
  }

  await env.DB.prepare("UPDATE messages SET provider_id = ?, sent_status = 'sent' WHERE id = ?")
    .bind(providerBody.id, id).run();
  await env.DB.prepare('INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, 'mail.sent', 'message', id, now).run();

  return json({ ok: true, messageId: id, providerId: providerBody.id, status: 'sent' }, 201);
}

async function verifyResendWebhook(request: Request, env: AppEnv, payload: string): Promise<boolean> {
  const id = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');
  const signatures = request.headers.get('svix-signature');
  if (!id || !timestamp || !signatures || !env.RESEND_WEBHOOK_SECRET) return false;
  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;

  const secretText = env.RESEND_WEBHOOK_SECRET.startsWith('whsec_')
    ? env.RESEND_WEBHOOK_SECRET.slice(6)
    : env.RESEND_WEBHOOK_SECRET;
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(secretText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${payload}`)));

  for (const item of signatures.split(' ')) {
    const [version, encoded] = item.split(',');
    if (version !== 'v1' || !encoded) continue;
    try {
      if (constantTimeEqual(expected, base64ToBytes(encoded))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function handleResendWebhook(request: Request, env: AppEnv): Promise<Response> {
  const payload = await request.text();
  if (!(await verifyResendWebhook(request, env, payload))) return json({ error: 'Assinatura inválida.' }, 400);

  const svixId = request.headers.get('svix-id') as string;
  let event: { type?: string; created_at?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(payload) as typeof event;
  } catch {
    return json({ error: 'JSON inválido.' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const eventTime = event.created_at ? Math.floor(new Date(event.created_at).getTime() / 1000) : now;
  try {
    await env.DB.prepare(
      'INSERT INTO webhook_events (id, provider, provider_event_id, event_type, provider_message_id, event_created_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), 'resend', svixId, event.type || 'unknown', event.data?.email_id || null, eventTime, now).run();
  } catch {
    return json({ ok: true, duplicate: true });
  }

  const statusByEvent: Record<string, string> = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'delayed',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
    'email.failed': 'failed',
    'email.suppressed': 'suppressed'
  };
  const status = event.type ? statusByEvent[event.type] : undefined;
  if (status && event.data?.email_id) {
    await env.DB.prepare('UPDATE messages SET sent_status = ? WHERE provider_id = ?')
      .bind(status, event.data.email_id).run();
  }
  return json({ ok: true });
}
