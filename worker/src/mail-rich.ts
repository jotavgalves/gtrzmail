import PostalMime from 'postal-mime';
import type { AppEnv, SessionUser } from './env';
import {
  base64ToBytes,
  createEnvelope,
  decryptWithDataKey,
  encryptWithDataKey,
  unwrapDataKey
} from './crypto';
import { json, readJson, safeFilename } from './http';
import { plainTextToHtml, prepareOutboundHtml, sanitizeEmailHtml } from './html';

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
  previous_folder: string | null;
  provider_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string;
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
  html_r2_key: string | null;
  html_body_iv: string | null;
  is_read: number;
  is_starred: number;
  sent_status: string | null;
  received_at: number;
};

type OutboundAttachment = {
  filename: string;
  mimeType?: string;
  contentBase64: string;
  contentId?: string;
  disposition?: 'attachment' | 'inline';
};

type SendPayload = {
  fromMailboxId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: OutboundAttachment[];
  inReplyTo?: string;
  references?: string[];
  draftId?: string;
};

type DraftPayload = {
  draftId?: string;
  fromMailboxId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
};

type StoredAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_id: string | null;
  disposition: string | null;
};

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeRecipients(value: string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(
    value
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
  )];
}

function normalizeReferences(value: string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(-50);
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function safeText(text: string | undefined, html: string | undefined): string {
  if (text?.trim()) return text.trim();
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
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

async function ownedMailbox(env: AppEnv, userId: string, mailboxId?: string): Promise<MailboxRow | null> {
  if (mailboxId) {
    return env.DB.prepare(
      'SELECT id, user_id, address, display_name, is_default FROM mailboxes WHERE id = ? AND user_id = ? LIMIT 1'
    ).bind(mailboxId, userId).first<MailboxRow>();
  }
  return env.DB.prepare(
    'SELECT id, user_id, address, display_name, is_default FROM mailboxes WHERE user_id = ? ORDER BY is_default DESC LIMIT 1'
  ).bind(userId).first<MailboxRow>();
}

async function userMessage(env: AppEnv, userId: string, messageId: string): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT m.* FROM messages m
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.id = ? AND mb.user_id = ? LIMIT 1`
  ).bind(messageId, userId).first<MessageRow>();
}

async function audit(env: AppEnv, userId: string | null, action: string, targetType: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, targetType, targetId, Math.floor(Date.now() / 1000)).run();
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

async function readStoredHtml(env: AppEnv, row: MessageRow, dataKey: CryptoKey): Promise<string | null> {
  if (!row.html_r2_key || !row.html_body_iv) return null;
  const object = await env.MAIL_BUCKET.get(row.html_r2_key);
  if (!object) return null;
  const decrypted = await decryptWithDataKey(await object.arrayBuffer(), row.html_body_iv, dataKey);
  return sanitizeEmailHtml(decoder.decode(decrypted), row.folder === 'drafts');
}

export async function getMessageRich(env: AppEnv, user: SessionUser, messageId: string): Promise<Response> {
  const row = await userMessage(env, user.id, messageId);
  if (!row) return json({ error: 'Mensagem não encontrada.' }, 404);

  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return json({ error: 'Conteúdo da mensagem indisponível.' }, 404);

  const dataKey = await unwrapDataKey(row.encrypted_key, row.key_iv, env);
  const decrypted = await decryptWithDataKey(await object.arrayBuffer(), row.body_iv, dataKey);
  let bodyText = '';
  let bodyHtml = await readStoredHtml(env, row, dataKey);

  if (row.storage_type === 'rfc822') {
    const parsed = await PostalMime.parse(decrypted, { maxNestingDepth: 80, maxHeadersSize: 524288 });
    bodyText = safeText(parsed.text, parsed.html);
    if (!bodyHtml && parsed.html) bodyHtml = sanitizeEmailHtml(parsed.html, false);
  } else {
    bodyText = decoder.decode(decrypted);
  }

  const attachments = await env.DB.prepare(
    'SELECT id, filename, mime_type, size_bytes, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY created_at ASC'
  ).bind(row.id).all<StoredAttachment>();

  if (!row.is_read && row.folder !== 'drafts') {
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
      bodyHtml,
      messageId: row.message_id,
      inReplyTo: row.in_reply_to,
      references: parseJsonArray(row.references_json),
      isRead: row.folder === 'drafts' ? row.is_read === 1 : true,
      isStarred: row.is_starred === 1,
      sentStatus: row.sent_status,
      receivedAt: row.received_at,
      attachments: attachments.results.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes,
        contentId: attachment.content_id,
        disposition: attachment.disposition
      }))
    }
  });
}

export async function downloadAttachmentRich(
  request: Request,
  env: AppEnv,
  user: SessionUser,
  attachmentId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT a.filename, a.mime_type, a.r2_key, a.body_iv, a.disposition, m.encrypted_key, m.key_iv
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE a.id = ? AND mb.user_id = ? LIMIT 1`
  ).bind(attachmentId, user.id).first<{
    filename: string;
    mime_type: string;
    r2_key: string;
    body_iv: string;
    disposition: string | null;
    encrypted_key: string;
    key_iv: string;
  }>();

  if (!row) return json({ error: 'Anexo não encontrado.' }, 404);
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return json({ error: 'Arquivo indisponível.' }, 404);

  const dataKey = await unwrapDataKey(row.encrypted_key, row.key_iv, env);
  const decrypted = await decryptWithDataKey(await object.arrayBuffer(), row.body_iv, dataKey);
  const filename = safeFilename(row.filename);
  const wantsInline = new URL(request.url).searchParams.get('inline') === '1' && row.mime_type.startsWith('image/');
  const disposition = wantsInline || row.disposition === 'inline' ? 'inline' : 'attachment';
  const headers = new Headers({
    'content-type': row.mime_type || 'application/octet-stream',
    'content-disposition': `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  });
  return new Response(decrypted, { status: 200, headers });
}

export async function saveDraftRich(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
  let payload: DraftPayload;
  try {
    payload = await readJson<DraftPayload>(request);
  } catch {
    return json({ error: 'Rascunho inválido.' }, 400);
  }

  const mailbox = await ownedMailbox(env, user.id, payload.fromMailboxId);
  if (!mailbox) return json({ error: 'Caixa de envio não configurada.' }, 400);

  const to = normalizeRecipients(payload.to);
  const cc = normalizeRecipients(payload.cc);
  const bcc = normalizeRecipients(payload.bcc);
  const subject = (payload.subject || '').trim().slice(0, 998);
  const text = (payload.text || '').slice(0, 500_000);
  const html = sanitizeEmailHtml(payload.html || plainTextToHtml(text), true);
  const references = normalizeReferences(payload.references);
  const now = Math.floor(Date.now() / 1000);
  const envelope = await createEnvelope(encoder.encode(text), env);
  const htmlEncrypted = await encryptWithDataKey(encoder.encode(html), envelope.dataKey);

  if (payload.draftId) {
    const existing = await userMessage(env, user.id, payload.draftId);
    if (!existing || existing.folder !== 'drafts') return json({ error: 'Rascunho não encontrado.' }, 404);
    const r2Key = `drafts/${payload.draftId}/body.txt.enc`;
    const htmlKey = `drafts/${payload.draftId}/body.html.enc`;
    await Promise.all([
      env.MAIL_BUCKET.put(r2Key, envelope.ciphertext, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { version: 'gtrz-envelope-v1' }
      }),
      env.MAIL_BUCKET.put(htmlKey, htmlEncrypted.ciphertext, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { version: 'gtrz-envelope-v1', content: 'sanitized-html' }
      })
    ]);
    if (existing.r2_key !== r2Key) await env.MAIL_BUCKET.delete(existing.r2_key);
    if (existing.html_r2_key && existing.html_r2_key !== htmlKey) await env.MAIL_BUCKET.delete(existing.html_r2_key);

    await env.DB.prepare(
      `UPDATE messages SET mailbox_id = ?, from_name = ?, from_address = ?, to_json = ?, cc_json = ?, bcc_json = ?,
       subject = ?, preview = ?, in_reply_to = ?, references_json = ?, r2_key = ?, encrypted_key = ?, key_iv = ?, body_iv = ?,
       html_r2_key = ?, html_body_iv = ?, received_at = ?, sent_status = 'draft', is_read = 1 WHERE id = ?`
    ).bind(
      mailbox.id, mailbox.display_name, mailbox.address, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc),
      subject, previewOf(text), payload.inReplyTo || null, JSON.stringify(references), r2Key,
      envelope.encryptedKey, envelope.keyIv, envelope.bodyIv, htmlKey, htmlEncrypted.iv, now, existing.id
    ).run();
    return json({ ok: true, id: existing.id, savedAt: now });
  }

  const id = crypto.randomUUID();
  const r2Key = `drafts/${id}/body.txt.enc`;
  const htmlKey = `drafts/${id}/body.html.enc`;
  await Promise.all([
    env.MAIL_BUCKET.put(r2Key, envelope.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1' }
    }),
    env.MAIL_BUCKET.put(htmlKey, htmlEncrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1', content: 'sanitized-html' }
    })
  ]);

  await env.DB.prepare(
    `INSERT INTO messages (
      id, mailbox_id, direction, folder, provider_id, message_id, in_reply_to, references_json,
      from_name, from_address, to_json, cc_json, bcc_json, subject, preview, storage_type,
      r2_key, encrypted_key, key_iv, body_iv, html_r2_key, html_body_iv,
      is_read, is_starred, sent_status, received_at, created_at, previous_folder
    ) VALUES (?, ?, 'outbound', 'drafts', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, 1, 0, 'draft', ?, ?, NULL)`
  ).bind(
    id, mailbox.id, payload.inReplyTo || null, JSON.stringify(references), mailbox.display_name, mailbox.address,
    JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, previewOf(text), r2Key,
    envelope.encryptedKey, envelope.keyIv, envelope.bodyIv, htmlKey, htmlEncrypted.iv, now, now
  ).run();
  await audit(env, user.id, 'mail.draft_created', 'message', id);
  return json({ ok: true, id, savedAt: now }, 201);
}

export async function sendMessageRich(request: Request, env: AppEnv, user: SessionUser): Promise<Response> {
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
  const references = normalizeReferences(payload.references);
  if (!to.length) return json({ error: 'Informe pelo menos um destinatário.' }, 400);

  const mailbox = await ownedMailbox(env, user.id, payload.fromMailboxId);
  if (!mailbox) return json({ error: 'Caixa de envio não configurada.' }, 400);

  const preparedHtml = prepareOutboundHtml(payload.html || plainTextToHtml(text));
  const regularAttachments = (payload.attachments || []).slice(0, 20);
  const attachments: OutboundAttachment[] = [
    ...regularAttachments.map((attachment) => ({ ...attachment, disposition: 'attachment' as const })),
    ...preparedHtml.inlineImages.map((image) => ({
      filename: image.filename,
      mimeType: image.mimeType,
      contentBase64: image.contentBase64,
      contentId: image.contentId,
      disposition: 'inline' as const
    }))
  ];
  if (attachments.length > 25) return json({ error: 'A mensagem contém anexos ou imagens demais.' }, 413);

  let totalAttachmentBytes = 0;
  const decodedAttachments: Array<OutboundAttachment & { bytes: Uint8Array<ArrayBuffer> }> = [];
  for (const attachment of attachments) {
    if (!attachment.filename || !attachment.contentBase64) continue;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = base64ToBytes(attachment.contentBase64);
    } catch {
      return json({ error: `Anexo inválido: ${attachment.filename}` }, 400);
    }
    totalAttachmentBytes += bytes.byteLength;
    decodedAttachments.push({ ...attachment, filename: attachment.filename.slice(0, 180), bytes });
  }

  const maxBytes = Number(env.MAX_OUTBOUND_ATTACHMENT_BYTES || '18874368');
  if (totalAttachmentBytes > maxBytes) {
    return json({ error: 'Os anexos e imagens excedem o limite permitido pelo GTRZ Mail.' }, 413);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const prefix = `sent/${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}/${id}`;
  const r2Key = `${prefix}/body.txt.enc`;
  const htmlKey = `${prefix}/body.html.enc`;
  const envelope = await createEnvelope(encoder.encode(text), env);
  const htmlEncrypted = await encryptWithDataKey(encoder.encode(preparedHtml.html), envelope.dataKey);

  await Promise.all([
    env.MAIL_BUCKET.put(r2Key, envelope.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1' }
    }),
    env.MAIL_BUCKET.put(htmlKey, htmlEncrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1', content: 'sanitized-html' }
    })
  ]);

  await env.DB.prepare(
    `INSERT INTO messages (
      id, mailbox_id, direction, folder, provider_id, message_id, in_reply_to, references_json,
      from_name, from_address, to_json, cc_json, bcc_json, subject, preview, storage_type,
      r2_key, encrypted_key, key_iv, body_iv, html_r2_key, html_body_iv,
      is_read, is_starred, sent_status, received_at, created_at, previous_folder
    ) VALUES (?, ?, 'outbound', 'sent', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, 1, 0, 'sending', ?, ?, NULL)`
  ).bind(
    id, mailbox.id, payload.inReplyTo || null, JSON.stringify(references), mailbox.display_name, mailbox.address,
    JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, previewOf(text), r2Key,
    envelope.encryptedKey, envelope.keyIv, envelope.bodyIv, htmlKey, htmlEncrypted.iv, now, now
  ).run();

  const statements: D1PreparedStatement[] = [];
  for (const attachment of decodedAttachments) {
    const attachmentId = crypto.randomUUID();
    const attachmentKey = `attachments/${id}/${attachmentId}.enc`;
    const encrypted = await encryptWithDataKey(attachment.bytes, envelope.dataKey);
    await env.MAIL_BUCKET.put(attachmentKey, encrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1' }
    });
    statements.push(
      env.DB.prepare(
        'INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, r2_key, body_iv, content_id, disposition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        attachmentId, id, attachment.filename, attachment.mimeType || 'application/octet-stream',
        attachment.bytes.byteLength, attachmentKey, encrypted.iv, attachment.contentId || null,
        attachment.disposition || 'attachment', now
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);

  const resendPayload: Record<string, unknown> = {
    from: `${mailbox.display_name} <${mailbox.address}>`,
    to,
    subject,
    text,
    html: preparedHtml.html
  };
  if (cc.length) resendPayload.cc = cc;
  if (bcc.length) resendPayload.bcc = bcc;
  if (payload.inReplyTo || references.length) {
    const headers: Record<string, string> = {};
    if (payload.inReplyTo) headers['In-Reply-To'] = payload.inReplyTo;
    if (references.length) headers.References = references.join(' ');
    resendPayload.headers = headers;
  }
  if (decodedAttachments.length) {
    resendPayload.attachments = decodedAttachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.contentBase64,
      ...(attachment.contentId ? { content_id: attachment.contentId } : {})
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
  const providerBody = await providerResponse.json().catch(() => ({})) as { id?: string; message?: string };

  if (!providerResponse.ok || !providerBody.id) {
    await env.DB.prepare("UPDATE messages SET sent_status = 'failed' WHERE id = ?").bind(id).run();
    await audit(env, user.id, 'mail.send_failed', 'message', id);
    return json({ error: providerBody.message || 'Falha ao enviar pelo provedor.', messageId: id }, 502);
  }

  await env.DB.prepare("UPDATE messages SET provider_id = ?, sent_status = 'sent' WHERE id = ?")
    .bind(providerBody.id, id)
    .run();

  if (payload.draftId) {
    const draft = await userMessage(env, user.id, payload.draftId);
    if (draft?.folder === 'drafts') await deleteMessageData(env, draft);
  }

  await audit(env, user.id, 'mail.sent', 'message', id);
  return json({ ok: true, messageId: id, providerId: providerBody.id, status: 'sent' }, 201);
}
