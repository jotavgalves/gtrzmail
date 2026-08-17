import PostalMime, { type Address, type Mailbox } from 'postal-mime';
import type { AppEnv } from './env';
import { createEnvelope, encryptWithDataKey } from './crypto';
import { sanitizeEmailHtml } from './html';

const encoder = new TextEncoder();

type MailboxRow = {
  id: string;
  user_id: string;
  address: string;
  display_name: string;
  is_default: number;
};

function mailboxFromAddress(address: Address | undefined): Mailbox | null {
  if (!address) return null;
  if ('group' in address && address.group) return address.group[0] || null;
  return address as Mailbox;
}

function addresses(items: Address[] | undefined): string[] {
  if (!items) return [];
  const result: string[] = [];
  for (const item of items) {
    if ('group' in item && item.group) {
      for (const member of item.group) {
        if (member.address) result.push(member.address.toLowerCase());
      }
      continue;
    }
    const mailbox = item as Mailbox;
    if (mailbox.address) result.push(mailbox.address.toLowerCase());
  }
  return result;
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

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function attachmentBinary(value: unknown): ArrayBuffer | Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return value;
  if (typeof value === 'string') return encoder.encode(value);
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy: Uint8Array<ArrayBuffer> = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }
  throw new Error('Unsupported attachment binary format');
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

async function audit(env: AppEnv, userId: string, action: string, targetType: string, targetId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO audit_logs (id, user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, action, targetType, targetId, now).run();
}

export async function receiveEmailFast(message: ForwardableEmailMessage, env: AppEnv): Promise<void> {
  const mailbox = await incomingMailbox(env, message.to);
  if (!mailbox) {
    message.setReject('GTRZ Mail: mailbox not configured');
    return;
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(raw, {
    maxNestingDepth: 80,
    maxHeadersSize: 524288
  });

  const from = mailboxFromAddress(parsed.from);
  const bodyText = safeText(parsed.text, parsed.html);
  const bodyHtml = parsed.html ? sanitizeEmailHtml(parsed.html, false) : '';
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const datePath = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  const prefix = `messages/${datePath}/${id}`;
  const bodyKey = `${prefix}/body.txt.enc`;
  const rawKey = `${prefix}/message.eml.enc`;
  const htmlKey = bodyHtml ? `${prefix}/body.html.enc` : null;

  // The normal reader decrypts only the compact body. The original RFC822 is
  // still retained, encrypted with the same per-message DEK, as a sidecar.
  const envelope = await createEnvelope(encoder.encode(bodyText), env);
  const rawEncrypted = await encryptWithDataKey(raw, envelope.dataKey);
  const htmlEncrypted = bodyHtml
    ? await encryptWithDataKey(encoder.encode(bodyHtml), envelope.dataKey)
    : null;

  const writes: Promise<unknown>[] = [
    env.MAIL_BUCKET.put(bodyKey, envelope.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1', content: 'body-text' }
    }),
    env.MAIL_BUCKET.put(rawKey, rawEncrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1', content: 'raw-rfc822' }
    })
  ];

  if (htmlKey && htmlEncrypted) {
    writes.push(env.MAIL_BUCKET.put(htmlKey, htmlEncrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1', content: 'sanitized-html' }
    }));
  }
  await Promise.all(writes);

  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [String(parsed.references)]
      : [];

  await env.DB.prepare(
    `INSERT INTO messages (
      id, mailbox_id, direction, folder, provider_id, message_id, in_reply_to, references_json,
      from_name, from_address, to_json, cc_json, bcc_json, subject, preview, storage_type,
      r2_key, encrypted_key, key_iv, body_iv, html_r2_key, html_body_iv,
      raw_r2_key, raw_body_iv, is_read, is_starred, sent_status, received_at, created_at, previous_folder, thread_id
    ) VALUES (?, ?, 'inbound', 'inbox', NULL, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'text',
      ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL, ?)`
  ).bind(
    id,
    mailbox.id,
    parsed.messageId || null,
    parsed.inReplyTo || null,
    JSON.stringify(references),
    from?.name || '',
    from?.address?.toLowerCase() || message.from.toLowerCase(),
    JSON.stringify(addresses(parsed.to)),
    JSON.stringify(addresses(parsed.cc)),
    parsed.subject || '(sem assunto)',
    previewOf(bodyText),
    bodyKey,
    envelope.encryptedKey,
    envelope.keyIv,
    envelope.bodyIv,
    htmlKey,
    htmlEncrypted?.iv || null,
    rawKey,
    rawEncrypted.iv,
    now,
    now,
    id
  ).run();

  const statements: D1PreparedStatement[] = [];
  for (const attachment of parsed.attachments || []) {
    const attachmentId = crypto.randomUUID();
    const attachmentKey = `attachments/${id}/${attachmentId}.enc`;
    const content = attachmentBinary(attachment.content);
    const encrypted = await encryptWithDataKey(content, envelope.dataKey);

    await env.MAIL_BUCKET.put(attachmentKey, encrypted.ciphertext, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { version: 'gtrz-envelope-v1' }
    });

    statements.push(
      env.DB.prepare(
        'INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, r2_key, body_iv, content_id, disposition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        attachmentId,
        id,
        (attachment.filename || 'anexo').slice(0, 180),
        attachment.mimeType || 'application/octet-stream',
        content.byteLength,
        attachmentKey,
        encrypted.iv,
        attachment.contentId || null,
        attachment.disposition || 'attachment',
        now
      )
    );
  }
  if (statements.length) await env.DB.batch(statements);

  await audit(env, mailbox.user_id, 'mail.received', 'message', id);
}
